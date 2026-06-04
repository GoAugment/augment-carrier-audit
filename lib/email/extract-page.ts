/**
 * Deterministic server-side extraction from a captured browser page.
 *
 * The bookmarklet/extension grabs the WHOLE rendered page (outerHTML + URL +
 * any text selection) and hands it to the server. All the parsing lives here
 * so we can iterate on extraction WITHOUT re-issuing the bookmarklet — the
 * bookmarklet is a dumb "grab everything and POST it" shim.
 *
 * Works across the three surfaces the broker uses:
 *   - Outlook / Gmail web — a carrier's email open in the reading pane. We
 *     pull the sender from the rendered DOM (mailto: links, Gmail's email="..."
 *     attribute, or a visible "From: Name <addr>" line) so the email gut check
 *     (sender-domain-vs-FMCSA, MX/SPF/DMARC, Reply-To) can run.
 *   - A TMS load page (T1, etc.) — no sender, but the DOT/MC + lane are in the
 *     visible text. We extract those for the carrier + lane coverage checks.
 *
 * Unlike the LLM Stage-1 extractor (extract.ts), this is free, instant, and
 * has no forwarded-email assumptions baked in — it reads whatever is on screen.
 *
 * Note on DKIM/SPF/DMARC: we DO parse per-message auth when the page exposes it
 * (Gmail "Show original"/details, or a raw Authentication-Results header) — see
 * parseEmailAuth. This is trustworthy here because the bookmarklet reads the
 * actually-received message (no forwarding to launder the headers). When the
 * page doesn't show auth (normal reading view), emailAuth is simply undefined.
 */
import type { ExtractedEmail } from "./types";

/** US state two-letter codes, for lane origin/destination detection. */
const ST =
  "(A[KLRZ]|C[AOT]|D[CE]|FL|GA|HI|I[ADLN]|K[SY]|LA|M[ADEINOST]|N[CDEHJMVY]|O[HKR]|PA|RI|S[CD]|T[NX]|UT|V[AT]|W[AIVY])";

export interface PageCapture {
  /** document.documentElement.outerHTML from the captured page. */
  html: string;
  /** location.href of the captured page (used as a context hint only). */
  url?: string;
  /** window.getSelection() text, when the user highlighted something. */
  sel?: string;
  /** Live form-field values as "Label: value" lines, captured by the
   *  bookmarklet. CRITICAL for SPA forms (T1 etc.): an <input>'s current value
   *  is a live DOM property, NOT serialized into outerHTML — so the carrier's
   *  DOT/MC/lane in a load-edit form is invisible to html scraping. The
   *  bookmarklet reads el.value + the field's label and sends them here; we
   *  scan them first. */
  fields?: string;
}

/** Build the text we scan: live form fields first (highest signal on SPA
 *  forms), then the user's selection if any, else the whole-page text. */
function scanText(cap: PageCapture): { text: string; usedSelection: boolean } {
  const html = (cap.html || "").slice(0, 3_000_000);
  const selTrim = (cap.sel || "").trim();
  const usedSelection = selTrim.length > 30;
  const body = usedSelection ? selTrim : htmlToText(html);
  const fieldsText = (cap.fields || "").trim();
  const text = ((fieldsText ? fieldsText.slice(0, 60_000) + "\n\n" : "") + body).slice(0, 300_000);
  return { text, usedSelection };
}

/** Minimal HTML → text: drop script/style, turn breaks into newlines, strip
 *  tags, decode the common entities. The LLM-grade version lives in extract.ts;
 *  this mirrors it. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<(?:br|tr|li|div|p|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/(?:p|div|tr|li|h[1-6]|table)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t ]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Domains that are NOT the carrier's own email — carrier-vetting relays,
// loadboards, and the TMS host itself. An address at one of these (e.g.
// Highway's "dot3626466@highway.com" relay shown on a T1 contact list) must
// never be treated as the carrier's sender, or the sender-vs-FMCSA check
// false-flags a mismatch.
const VENDOR_RELAY_DOMAINS = new Set([
  // Carrier-vetting relays + loadboards + TMS hosts.
  "highway.com",
  "dat.com",
  "truckstop.com",
  "123loadboard.com",
  "loadboard.com",
  "rmis.com",
  "mycarrierpackets.com",
  "carrier411.com",
  "registrymonitoring.com",
  "transportationone.com",
  // Consumer / big-tech / transactional senders that are never a carrier —
  // common inbox noise (e.g. running the bookmarklet on a Gmail inbox).
  "github.com",
  "google.com",
  "amazon.com",
  "apple.com",
  "microsoft.com",
  "paypal.com",
  "playstation.com",
  "sony.com",
  "facebook.com",
  "meta.com",
  "linkedin.com",
  "netflix.com",
  "uber.com",
  "doordash.com",
  "slack.com",
]);

/** Registrable-ish domain (last two labels) for host comparison. */
function registrableDomain(host: string): string {
  return host.toLowerCase().split(".").slice(-2).join(".");
}

function isIgnoredSenderDomain(domain: string, hostDomain: string): boolean {
  const d = domain.toLowerCase();
  if (VENDOR_RELAY_DOMAINS.has(d)) return true;
  if (hostDomain && (d === hostDomain || d.endsWith("." + hostDomain))) return true;
  return false;
}

const EMAIL_RE_SRC = "[A-Za-z0-9._%+\\-]+@[A-Za-z0-9.\\-]+\\.[A-Za-z]{2,}";

/** The ONE authoritative sender — ONLY from an explicit "From:" line (a real
 *  forwarded/inbound email). We deliberately do NOT use Gmail's email="" attr:
 *  on a list/inbox view the first such attr is some unrelated message, which
 *  produced a false "sender domain mismatch". When there's no clear single
 *  sender we return "" and fall back to candidate matching. */
function findAuthoritativeSender(_html: string, text: string, hostDomain: string): string {
  const ok = (a: string) => {
    const dom = a.split("@").pop() ?? "";
    return !!dom && !isIgnoredSenderDomain(dom, hostDomain);
  };
  const fromAngle = text.match(new RegExp(`From:\\s*[^<\\n]*<(${EMAIL_RE_SRC})>`, "i"));
  if (fromAngle && ok(fromAngle[1])) return fromAngle[1].toLowerCase();
  const fromBare = text.match(new RegExp(`From:\\s*(${EMAIL_RE_SRC})`, "i"));
  if (fromBare && ok(fromBare[1])) return fromBare[1].toLowerCase();
  return "";
}

/** ALL distinct emails on the page (attr, mailto, From:/Email: lines, and bare
 *  text), vendor/loadboard/host domains excluded. The check then looks for the
 *  carrier's FMCSA-registered email/domain among these rather than betting on
 *  one. Capped so a pathological page can't balloon the payload. */
function findEmailCandidates(html: string, text: string, hostDomain: string): string[] {
  const out: string[] = [];
  const add = (a: string) => {
    const e = a.toLowerCase().trim();
    const dom = e.split("@").pop() ?? "";
    if (dom && !isIgnoredSenderDomain(dom, hostDomain) && !out.includes(e)) out.push(e);
  };
  for (const m of html.matchAll(new RegExp(`\\bemail=["']\\s*(${EMAIL_RE_SRC})\\s*["']`, "gi"))) add(m[1]);
  for (const m of html.matchAll(/mailto:([^"'?>\s]+@[^"'?>\s]+)/gi)) {
    try {
      add(decodeURIComponent(m[1]));
    } catch {
      add(m[1]);
    }
  }
  for (const m of text.matchAll(new RegExp(EMAIL_RE_SRC, "gi"))) {
    add(m[0]);
    if (out.length >= 25) break;
  }
  return out.slice(0, 25);
}

/** Parse per-message SPF/DKIM/DMARC + the DKIM-signing domain from the captured
 *  text. Handles both Gmail's "Show original" prose ("DKIM: 'PASS' with domain
 *  augie.ai", "SPF: PASS …", "DMARC: 'PASS'") and a raw Authentication-Results
 *  header ("spf=pass", "dkim=pass header.d=augie.ai", "dmarc=pass"). Returns
 *  undefined when no auth results are present (normal reading view). */
function parseEmailAuth(text: string): ExtractedEmail["emailAuth"] | undefined {
  const norm = (v: string | undefined): "pass" | "fail" | "other" | null => {
    if (!v) return null;
    const x = v.toLowerCase();
    if (x === "pass" || x === "bestguesspass") return "pass";
    if (x === "fail" || x === "softfail" || x === "permerror") return "fail";
    return "other";
  };
  const spf = norm(
    text.match(/\bspf[:=]\s*'?(pass|fail|softfail|neutral|none|temperror|permerror)/i)?.[1]
  );
  const dkim = norm(text.match(/\bdkim[:=]\s*'?(pass|fail|none)/i)?.[1]);
  const dmarc = norm(text.match(/\bdmarc[:=]\s*'?(pass|fail|bestguesspass|none)/i)?.[1]);
  // DKIM signing domain: Gmail "with domain X" or raw "header.d=X".
  const dkimDomainRaw =
    text.match(/dkim[^\n]{0,40}?(?:with domain|header\.d=)\s*'?([A-Za-z0-9.\-]+)/i)?.[1] ?? null;
  const dkimDomain = dkimDomainRaw ? dkimDomainRaw.toLowerCase().replace(/[.'"]+$/, "") : null;

  if (spf == null && dkim == null && dmarc == null) return undefined;
  return { spf, dkim, dmarc, dkimDomain };
}

/** Sender display name from a "From: Display Name <addr>" line, when present. */
function findSenderName(text: string): string {
  const m = text.match(/From:\s*([^<\n]+?)\s*<[^>]+@[^>]+>/i);
  return m ? m[1].replace(/["']/g, "").trim() : "";
}

/** Reply-To domain when a Reply-To line is visible and differs is handled
 *  downstream; we just surface the domain here. */
function findReplyToDomain(text: string): string | null {
  const m = text.match(/Reply-?To:\s*[^<\n]*<?([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})>?/i);
  if (!m) return null;
  const dom = m[1].toLowerCase().split("@").pop();
  return dom || null;
}

function stateAfter(text: string, leadIns: string): string | null {
  const re = new RegExp(`(?:${leadIns})[\\s\\S]{0,80}?,\\s*${ST}\\b`, "i");
  const x = text.match(re);
  return x ? x[1].toUpperCase() : null;
}

/** Diagnostics for tuning the scraper against a real page (T1, Outlook, …)
 *  without round-tripping the raw HTML by hand. Returned by /api/check?debug=1.
 *  Shows what we extracted PLUS the surrounding context for the labels we key
 *  on, so we can see how a given host actually phrases the DOT/MC/lane. */
export interface PageDiagnostics {
  extracted: ExtractedEmail;
  htmlLength: number;
  textLength: number;
  usedSelection: boolean;
  textHead: string;
  dotContexts: string[];
  mcContexts: string[];
  carrierContexts: string[];
  senderCandidates: string[];
  numbers4to8: string[];
}

function contextsAround(text: string, needle: RegExp, max = 8, pad = 55): string[] {
  const g = new RegExp(needle.source, "gi");
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = g.exec(text)) && out.length < max) {
    const i = m.index;
    out.push(
      "…" +
        text
          .slice(Math.max(0, i - 12), Math.min(text.length, i + pad))
          .replace(/\s+/g, " ")
          .trim() +
        "…"
    );
    if (g.lastIndex === i) g.lastIndex++; // guard against zero-width loops
  }
  return out;
}

export function pageDiagnostics(cap: PageCapture): PageDiagnostics {
  const html = (cap.html || "").slice(0, 3_000_000);
  const { text, usedSelection } = scanText(cap);

  const senderCandidates: string[] = [];
  const attrAll = html.match(/\bemail=["']\s*[^"']+@[^"']+\s*["']/gi) || [];
  const mailtoAll = html.match(/mailto:[^"'?>\s]+@[^"'?>\s]+/gi) || [];
  const fromAll = text.match(/From:\s*[^\n]{0,80}/gi) || [];
  for (const s of [...attrAll.slice(0, 5), ...mailtoAll.slice(0, 5), ...fromAll.slice(0, 5)]) {
    senderCandidates.push(s.replace(/\s+/g, " ").trim().slice(0, 90));
  }

  const numbers = Array.from(new Set(text.match(/\b\d{4,8}\b/g) || [])).slice(0, 40);

  return {
    extracted: extractFromPage(cap),
    htmlLength: (cap.html || "").length,
    textLength: text.length,
    usedSelection,
    textHead: text.slice(0, 1800),
    dotContexts: contextsAround(text, /dot/),
    mcContexts: contextsAround(text, /\bmc\b/),
    carrierContexts: contextsAround(text, /carrier/),
    senderCandidates,
    numbers4to8: numbers,
  };
}

/**
 * Pull a DOT and/or MC out of a chunk of text. `allowBareDot` treats a lone
 * number (a selection like "2902577") as a DOT, which only makes sense for the
 * user's deliberate selection — never for whole-page scanning, where stray
 * 4–8 digit numbers (zips, order ids, phone fragments) are everywhere.
 */
function identifiersFromText(
  t: string,
  allowBareDot = false
): { dot: string | null; mc: string | null } {
  let dot: string | null = null;
  let mc: string | null = null;
  // Type-attached forms first ("MC116400", "MC-116400", "USDOT 116400").
  const mcAttached = t.match(/(?:^|[^A-Za-z0-9])MC[-#]?\s?(\d{3,8})\b/i);
  const dotAttached = t.match(/(?:^|[^A-Za-z0-9])(?:US[-\s]?)?DOT[-#:]?\s?(\d{4,8})\b/i);
  if (mcAttached) mc = `MC-${mcAttached[1]}`;
  if (dotAttached) dot = dotAttached[1];
  if (!dot && !mc) {
    // Looser label form: "MC/DOT Number: 1234567", "our DOT is 3533697".
    const dotLabeled = t.match(/\b(?:US)?DOT\b\D{0,14}?(\d{4,8})\b/i);
    if (dotLabeled) dot = dotLabeled[1];
    else {
      const mcLabeled = t.match(/\bMC\b\D{0,12}?(\d{3,8})\b/i);
      if (mcLabeled) mc = `MC-${mcLabeled[1]}`;
    }
  }
  // A lone selected number ("2902577", "#2902577") — the user picked it on
  // purpose, so treat it as a DOT.
  if (!dot && !mc && allowBareDot) {
    const bare = t.trim().match(/^#?\s*(\d{5,8})\s*$/);
    if (bare) dot = bare[1];
  }
  return { dot, mc };
}

export function extractFromPage(cap: PageCapture): ExtractedEmail {
  const html = (cap.html || "").slice(0, 3_000_000);
  const { text } = scanText(cap);

  // --- DOT / MC ---
  // The user's text SELECTION wins when it names a carrier — this is the
  // disambiguator on a busy inbox/TMS page where many DOTs are present and a
  // plain document-order scan would grab the wrong one (e.g. another email's
  // carrier, or a prior Augie audit reply). Highlight the DOT/MC (or just the
  // number) of the carrier you mean and we use that; otherwise fall back to
  // scanning the page.
  const selTrim = (cap.sel || "").trim();
  let { dot: dot_number, mc: mc_number } = selTrim
    ? identifiersFromText(selTrim, true)
    : { dot: null, mc: null };
  if (!dot_number && !mc_number) {
    ({ dot: dot_number, mc: mc_number } = identifiersFromText(text));
  }

  // --- sender (email gut check) ---
  let hostDomain = "";
  try {
    if (cap.url) hostDomain = registrableDomain(new URL(cap.url).hostname);
  } catch {
    /* bad url */
  }
  // One authoritative sender (real From:) drives the hard impersonation check;
  // ALL candidate emails drive the soft "is the carrier's FMCSA email among
  // these?" check (a page lists customer/broker/carrier — don't bet on one).
  const senderEmail = findAuthoritativeSender(html, text, hostDomain);
  const senderCandidates = findEmailCandidates(html, text, hostDomain);
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@").pop()! : "";
  const senderName = findSenderName(text);
  let replyToDomain = findReplyToDomain(text);
  // Only meaningful when it differs from the From: domain.
  if (replyToDomain && senderDomain && replyToDomain === senderDomain) replyToDomain = null;

  // --- lane (coverage gut check) ---
  // Resolve origin → destination as flexibly as the page allows. The state code
  // is what the checks key off; cities are captured for display when we can get
  // them. Direction doesn't affect the checks — coverage takes the worst-injury
  // state of the pair, viability keys off interstate-ness — so first-seen order
  // is fine.
  //
  // Collect every "City, ST [ZIP]" stop in document order first (TMS stop lists
  // "Lewistown, PA" … "Dalton, OH", address blocks, or email prose "pickup in
  // Dallas, TX"). The state abbreviation is the anchor; the city is 1–3
  // capitalized words single-spaced before the comma (single-spaced so a label
  // on the previous line isn't glued on), with an optional trailing ZIP.
  const stopRe = new RegExp(
    `([A-Z][A-Za-z.'\\-]*(?:[ ][A-Z][A-Za-z.'\\-]*){0,2})\\s*,\\s*${ST}\\b(?:\\s+\\d{5}(?:-\\d{4})?)?`,
    "g"
  );
  // Leading lane-label words an all-caps "DEST UNION, NJ" / "Pickup Dallas, TX"
  // glues onto the city — strip them so we keep just the place name.
  const laneLabel =
    /^(?:origin|destination|dest|pickup|pick\s*up|pu|delivery|deliver|drop\s*off?|drop|stops?|shipper|consignee|receiver|ship\s*(?:from|to)|from|to)\s+/i;
  const cleanCity = (c: string): string | null => {
    const t = c.replace(laneLabel, "").trim();
    return t || null;
  };
  // Several state codes are also common English words (OR, IN, OK, ME, HI, DE,
  // …), so a greeting/closing before a comma — "Hi, OR" / "Thanks, IN" — can
  // masquerade as a stop. Drop a match whose whole "city" is one of these
  // non-place words. (A real city named after one of these would need a second
  // word, e.g. "Hi Nella" — still allowed.)
  const NON_PLACE = new Set([
    "hi", "hey", "hello", "thanks", "thank", "thx", "best", "regards", "cheers",
    "dear", "sincerely", "yours", "yes", "no", "ok", "okay", "re", "fwd", "fw",
    "sent", "from", "to", "cc", "bcc", "subject", "date", "as", "is", "of", "or",
  ]);
  const cityStops: { city: string | null; state: string }[] = [];
  let lm: RegExpExecArray | null;
  while ((lm = stopRe.exec(text))) {
    if (NON_PLACE.has(lm[1].trim().toLowerCase())) continue;
    cityStops.push({ city: cleanCity(lm[1]), state: lm[2].toUpperCase() });
    if (cityStops.length >= 40) break;
  }
  // First two DISTINCT states (billing/remit lines repeat the same state later,
  // so first-two-distinct skips them).
  const distinctStops: { city: string | null; state: string }[] = [];
  for (const s of cityStops) {
    if (!distinctStops.some((x) => x.state === s.state)) distinctStops.push(s);
    if (distinctStops.length >= 2) break;
  }

  let originCity: string | null = null;
  let destCity: string | null = null;
  // Explicit lead-ins win for the STATE ("origin … TX", "deliver to … IL").
  let from = stateAfter(text, "origin|pickup|pick[\\s-]?up|ship\\s*from|p[\\s.]*u\\b");
  let to = stateAfter(text, "destination|delivery|consignee|deliver\\s*to|ship\\s*to|drop|d[\\s.]*el\\b");
  if (!from && distinctStops[0]) from = distinctStops[0].state;
  if (!to && distinctStops[1]) to = distinctStops[1].state;
  // Backfill the city for each end from whichever stop matches the resolved
  // state (so a labeled "Pickup: Saint Louis, MO" still gets its city).
  if (from) originCity = cityStops.find((s) => s.state === from && s.city)?.city ?? null;
  if (to) destCity = cityStops.find((s) => s.state === to && s.city && s.city !== originCity)?.city ?? null;

  if (!from || !to) {
    // TMS stop tables that split the address into fields: "City: Elkton State:
    // VA" … "City: Union State: NJ" (no comma between city and state).
    const stRe = new RegExp(
      `(?:City:?\\s*([A-Za-z][A-Za-z .'\\-]*?)\\s+)?\\bState:?\\s*${ST}\\b`,
      "gi"
    );
    const stops: { city: string | null; state: string }[] = [];
    let m: RegExpExecArray | null;
    while ((m = stRe.exec(text)) && stops.length < 2) {
      const s = m[2].toUpperCase();
      if (!stops.some((x) => x.state === s)) {
        stops.push({ city: m[1] ? m[1].trim() : null, state: s });
      }
    }
    if (!from && stops[0]) {
      from = stops[0].state;
      originCity = originCity ?? stops[0].city;
    }
    if (!to && stops[1]) {
      to = stops[1].state;
      destCity = destCity ?? stops[1].city;
    }
  }

  // --- hazmat hint ---
  // Only when AFFIRMATIVELY indicated. A bare "hazmat" keyword is NOT enough:
  // every TMS load form (T1) carries a "Hazmat" field label in its markup, so
  // scanning the page would flag every load (it false-fired on a palletized-
  // beer load). Require placard/hazardous-material prose, a UN number, an
  // affirmative hazmat value ("Hazmat: Yes"), or hazmat used as a load
  // descriptor ("hazmat load/shipment").
  const is_hazmat_load =
    /\b(placard(?:ed)?|hazardous\s+(?:materials?|substances?)|hazard\s+class\s*\d)\b/i.test(text) ||
    /\bUN\s?\d{4}\b/.test(text) ||
    /\bhaz[\s-]?mat\b\s*[:=]?\s*(?:yes|y|true|1|required|x|✓)\b/i.test(text) ||
    /\bhaz[\s-]?mat\b\s+(?:load|shipment|freight|cargo|placard)/i.test(text);

  // --- phones ---
  // A page (TMS load, contact directory) lists several numbers — customer,
  // broker, carrier — so don't bet on one "claimed phone" (that false-flagged
  // a phone mismatch). Collect ALL of them as candidates; the check looks for
  // the carrier's FMCSA phone among them. Dedup by last-10-digits.
  const phoneCandidates: string[] = [];
  const seenPhones = new Set<string>();
  // Skip placeholder / junk numbers a page renders as filler: NANP requires the
  // area code and exchange to start 2–9 (kills "(000) 000-0000", "111-…"), and
  // an all-identical-digit string ("000…", "555…") is filler, not a real line.
  const isPlausiblePhone = (d10: string): boolean =>
    /^[2-9]\d{2}[2-9]\d{6}$/.test(d10) && !/^(\d)\1{9}$/.test(d10);
  for (const m of text.matchAll(/(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}\b/g)) {
    const raw = m[0].trim();
    const d10 = raw.replace(/\D/g, "").slice(-10);
    if (d10.length === 10 && isPlausiblePhone(d10) && !seenPhones.has(d10)) {
      seenPhones.add(d10);
      phoneCandidates.push(raw);
      if (phoneCandidates.length >= 30) break;
    }
  }

  // Keep ALL candidates flowing to the check so the carrier's FMCSA email/phone
  // is still found even amid inbox noise (Gmail keeps the whole inbox list in
  // the DOM even when one email is open). The wall-of-junk problem is handled
  // at RENDER time: when none match FMCSA and there are many, we collapse the
  // display to a single count instead of suppressing the match entirely.
  const emails = senderCandidates;
  const phones = phoneCandidates;

  // Per-message auth, if the captured page shows it (Gmail "Show original" /
  // details, or a raw Authentication-Results header).
  const emailAuth = parseEmailAuth(text);

  return {
    source: "page",
    extracted_text: "",
    summary: "Single-carrier check (captured page).",
    identity_claims: {
      dot_number,
      mc_number,
      // We don't try to guess the legal name from arbitrary page text — the
      // verdict resolves the registered name from FMCSA off the DOT/MC.
      claimed_company_name: null,
      // No single "claimed phone" on a multi-contact page — see phone_candidates.
      claimed_phone: null,
      contact_person: null,
    },
    sender_metadata: {
      sender_email: senderEmail,
      sender_email_domain: senderDomain,
      sender_display_name: senderName,
      reply_to_domain: replyToDomain,
    },
    sender_candidates: emails.length ? emails : undefined,
    phone_candidates: phones.length ? phones : undefined,
    emailAuth,
    behavioral_signals: {
      is_response_to_load_posting: false,
      urgency_markers: [],
      // Manual capture, not a parsed cold email — keep the "vague cold pitch"
      // info signal from firing on the absence of a signature block.
      has_signature_block: true,
      specificity_score: from && to ? 2 : 1,
    },
    lane: {
      origin_city: originCity,
      origin_state: from,
      destination_city: destCity,
      destination_state: to,
      equipment_type: null,
      is_hazmat_load,
    },
  };
}
