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
 *     pull the sender from the rendered DOM (mailto: links, Gmail's email="…"
 *     attribute, or a visible "From: Name <addr>" line) so the email gut check
 *     (sender-domain-vs-FMCSA, MX/SPF/DMARC, WHOIS age, Reply-To) can run.
 *   - A TMS load page (T1, etc.) — no sender, but the DOT/MC + lane are in the
 *     visible text. We extract those for the carrier + lane coverage checks.
 *
 * Unlike the LLM Stage-1 extractor (extract.ts), this is free, instant, and
 * has no forwarded-email assumptions baked in — it reads whatever is on screen.
 *
 * Note on DKIM/SPF/DMARC: we deliberately do NOT parse per-message
 * Authentication-Results even when present — inline forwards strip the
 * carrier's original auth and leave the broker's forwarding-server result
 * (always passes, meaningless). The email gut check is domain-level, so we only
 * need the sender's address. (If we ever want raw-source auth, this is where it
 * would go.)
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

/** The ONE authoritative sender, from a genuine From: context only — Gmail's
 *  email="" attr (the sender in the Gmail DOM) or a visible "From:" line. NOT
 *  mailto/contact emails, which on a directory page are ambiguous. "" when the
 *  page has no clear single sender (then we fall back to candidate matching).
 *  Skips vendor-relay / loadboard / TMS-host domains. */
function findAuthoritativeSender(html: string, text: string, hostDomain: string): string {
  const ok = (a: string) => {
    const dom = a.split("@").pop() ?? "";
    return !!dom && !isIgnoredSenderDomain(dom, hostDomain);
  };
  const attr = html.match(new RegExp(`\\bemail=["']\\s*(${EMAIL_RE_SRC})\\s*["']`, "i"));
  if (attr && ok(attr[1])) return attr[1].toLowerCase();
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

export function extractFromPage(cap: PageCapture): ExtractedEmail {
  const html = (cap.html || "").slice(0, 3_000_000);
  const { text } = scanText(cap);

  // --- DOT / MC ---
  // The "MC/DOT Number" label (T1) is ambiguous, so trust the VALUE's own
  // prefix first: a digit-attached "MC116400" / "MC-116400" / "USDOT 116400"
  // tells us the type for certain. Only when no prefixed-attached form exists
  // do we fall back to the looser label form ("DOT is 3533697"), defaulting a
  // bare number to DOT.
  let dot_number: string | null = null;
  let mc_number: string | null = null;
  // MC bound to its digits (optional - or # or a single space, e.g. the T1
  // value "MC116400"). The leading boundary stops it matching "...MC" inside
  // a word.
  const mcAttached = text.match(/(?:^|[^A-Za-z0-9])MC[-#]?\s?(\d{3,8})\b/i);
  // (US)DOT bound to its digits.
  const dotAttached = text.match(/(?:^|[^A-Za-z0-9])(?:US[-\s]?)?DOT[-#:]?\s?(\d{4,8})\b/i);
  if (mcAttached) mc_number = `MC-${mcAttached[1]}`;
  if (dotAttached) dot_number = dotAttached[1];
  if (!dot_number && !mc_number) {
    // Ambiguous label form: "MC/DOT Number: 1234567", "our DOT is 3533697".
    const dotLabeled = text.match(/\b(?:US)?DOT\b\D{0,14}?(\d{4,8})\b/i);
    if (dotLabeled) dot_number = dotLabeled[1];
    else {
      const mcLabeled = text.match(/\bMC\b\D{0,12}?(\d{3,8})\b/i);
      if (mcLabeled) mc_number = `MC-${mcLabeled[1]}`;
    }
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
  let from = stateAfter(text, "origin|pickup|pick[\\s-]?up|ship\\s*from|p[\\s.]*u\\b");
  let to = stateAfter(text, "destination|delivery|consignee|deliver\\s*to|ship\\s*to|drop|d[\\s.]*el\\b");
  if (!from || !to) {
    // TMS stop lists (T1) render facilities as "City: Elkton State: VA" …
    // "City: Union State: NJ" with no origin/dest words. Take the first two
    // DISTINCT states that follow a "State:" label as origin → destination
    // (billing/customer states repeat later, so first-two-distinct skips them).
    const stRe = new RegExp(`\\bState:?\\s*${ST}\\b`, "gi");
    const distinct: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = stRe.exec(text)) && distinct.length < 2) {
      const s = m[1].toUpperCase();
      if (!distinct.includes(s)) distinct.push(s);
    }
    if (!from && distinct[0]) from = distinct[0];
    if (!to && distinct[1]) to = distinct[1];
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

  // --- phone (claimed) ---
  const phoneM = text.match(/(?:phone|tel|cell|call|ph)\b[:\s.]*((?:\+?1[\s.\-]*)?\(?\d{3}\)?[\s.\-]*\d{3}[\s.\-]*\d{4})/i);
  const claimed_phone = phoneM ? phoneM[1].trim() : null;

  return {
    extracted_text: "",
    summary: "Single-carrier check (captured page).",
    identity_claims: {
      dot_number,
      mc_number,
      // We don't try to guess the legal name from arbitrary page text — the
      // verdict resolves the registered name from FMCSA off the DOT/MC.
      claimed_company_name: null,
      claimed_phone,
      contact_person: null,
    },
    sender_metadata: {
      sender_email: senderEmail,
      sender_email_domain: senderDomain,
      sender_display_name: senderName,
      reply_to_domain: replyToDomain,
    },
    sender_candidates: senderCandidates.length ? senderCandidates : undefined,
    behavioral_signals: {
      is_response_to_load_posting: false,
      urgency_markers: [],
      // Manual capture, not a parsed cold email — keep the "vague cold pitch"
      // info signal from firing on the absence of a signature block.
      has_signature_block: true,
      specificity_score: from && to ? 2 : 1,
    },
    lane: {
      origin_city: null,
      origin_state: from,
      destination_city: null,
      destination_state: to,
      equipment_type: null,
      is_hazmat_load,
    },
  };
}
