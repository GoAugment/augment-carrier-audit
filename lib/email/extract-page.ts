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

const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/;

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

/** Find the carrier's sender address. Prefer the structured DOM cues (most
 *  reliable, hardest to confuse with stray addresses in quoted text), then a
 *  visible "From:" line, then any address as a last resort. */
function findSenderEmail(html: string, text: string): string {
  // Gmail renders the sender as <span email="dispatch@acme.com" …>.
  const attr = html.match(/\bemail=["']\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\s*["']/i);
  if (attr) return attr[1];
  // mailto: link (Outlook web, many TMS contact panels).
  const mailto = html.match(/mailto:([^"'?>\s]+@[^"'?>\s]+)/i);
  if (mailto) {
    try {
      return decodeURIComponent(mailto[1]);
    } catch {
      return mailto[1];
    }
  }
  // Visible "From: Name <addr>" or "From: addr" line in the rendered text.
  const fromAngle = text.match(/From:\s*[^<\n]*<([^>\s]+@[^>\s]+)>/i);
  if (fromAngle) return fromAngle[1];
  const fromBare = text.match(/From:\s*([A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})/i);
  if (fromBare) return fromBare[1];
  // Last resort: first address anywhere in the captured text.
  const any = text.match(EMAIL_RE);
  return any ? any[0] : "";
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
  // Tolerant of filler between the label and the number: "DOT 3533697",
  // "USDOT# 3533697", "DOT no. 3533697", "our DOT is 3533697". The lazy
  // \D{0,N}? caps how far the number can sit from the label to avoid grabbing
  // an unrelated number elsewhere on the page. \bMC\b boundary avoids matching
  // "MC" inside words like "MCLEAN".
  const dotM = text.match(/\b(?:US)?DOT\D{0,12}?(\d{4,8})\b/i);
  const mcM = text.match(/\bMC\b\D{0,10}?(\d{3,8})\b/i);
  const dot_number = dotM ? dotM[1] : null;
  const mc_number = mcM ? `MC-${mcM[1]}` : null;

  // --- sender (email gut check) ---
  const senderEmail = findSenderEmail(html, text).toLowerCase().trim();
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@").pop()! : "";
  const senderName = findSenderName(text);
  let replyToDomain = findReplyToDomain(text);
  // Only meaningful when it differs from the From: domain.
  if (replyToDomain && senderDomain && replyToDomain === senderDomain) replyToDomain = null;

  // --- lane (coverage gut check) ---
  const from = stateAfter(text, "origin|pickup|pick[\\s-]?up|ship\\s*from|p[\\s.]*u\\b");
  const to = stateAfter(text, "destination|delivery|consignee|deliver\\s*to|ship\\s*to|drop|d[\\s.]*el\\b");

  // --- hazmat hint ---
  const is_hazmat_load =
    /\b(haz[\s-]?mat|placard|hazardous materials?|UN\s?\d{3,4}\b|class\s?[1-9]\b)\b/i.test(text);

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
