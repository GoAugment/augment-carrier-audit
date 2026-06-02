/**
 * Single-carrier check — the bookmarklet / extension target. Renders the SAME
 * rich, email-style audit reply a broker gets back from audit@augie.ai, so the
 * web check and the email stay one design. Driven by checkCarrierEmail +
 * buildReplyHtml (lib/email/*), which already render the carrier profile, the
 * safety checks, the lane coverage-fit gut check, and the sender/email gut
 * check from a single ExtractedEmail.
 *
 *   /check/3533697                         DOT
 *   /check/MC-1234567   (or ?mc=1234567)   MC → DOT
 *   ?from=NJ&to=FL                         lane gut check (coverage-fit advisory)
 *   ?se=ops@acme.com&sn=Joe%20D&rt=...     sender → email gut check
 *
 * The email gut check is domain-level: sender-domain-vs-FMCSA-on-file, plus a
 * live MX/SPF/DMARC config + WHOIS age lookup on the sender domain, plus the
 * Reply-To mismatch flag. We deliberately do NOT trust per-message SPF/DKIM/
 * DMARC headers — inline forwards strip the carrier's original auth and leave
 * only the broker's forwarding-server auth (always passes, meaningless) — so
 * the bookmarklet only needs to grab the sender's address, not raw headers.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCarrierEmail } from "@/lib/email/check";
import { buildReplyHtml } from "@/lib/email/format-reply-html";
import type { ExtractedEmail } from "@/lib/email/types";

export const dynamic = "force-dynamic";

/** Normalize a 2-letter US state code from a query param; null when absent or
 *  not a clean 2-letter code (so we don't feed garbage into the lane checks). */
function stateParam(v: string | null): string | null {
  if (!v) return null;
  const s = v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  return s.length === 2 ? s : null;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { dot: string } }
) {
  const sp = req.nextUrl.searchParams;

  // DOT or MC from the path (or ?mc=). "MC-1234567" / "MC1234567" → mc_number;
  // a bare number → dot_number. checkCarrierEmail resolves MC → DOT internally.
  const raw = params.dot ?? "";
  const mcParam = sp.get("mc");
  const isMc = !!mcParam || /mc/i.test(raw);
  const digits = (mcParam ?? raw).replace(/\D/g, "");
  const dot_number = !isMc && digits ? digits : null;
  const mc_number = isMc && digits ? `MC-${digits}` : null;

  const from = stateParam(sp.get("from"));
  const to = stateParam(sp.get("to"));

  // Sender (optional) — drives the email gut check. Domain is derived from the
  // address; Reply-To powers the reply-to-mismatch flag.
  const senderEmail = (sp.get("se") || "").trim().toLowerCase();
  const senderName = (sp.get("sn") || "").trim();
  const replyTo = (sp.get("rt") || "").trim().toLowerCase();
  const senderDomain = senderEmail.includes("@") ? senderEmail.split("@").pop()! : "";
  const replyToDomain = replyTo.includes("@") ? replyTo.split("@").pop()! : replyTo || null;

  const e: ExtractedEmail = {
    extracted_text: "",
    summary: "Single-carrier check (web).",
    identity_claims: {
      dot_number,
      mc_number,
      claimed_company_name: null,
      claimed_phone: null,
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
      // Manual web check, not a parsed cold email — keep the "vague cold pitch"
      // info signal from firing just because there's no signature block.
      has_signature_block: true,
      specificity_score: 2,
    },
    lane: {
      origin_city: null,
      origin_state: from,
      destination_city: null,
      destination_state: to,
      equipment_type: null,
      is_hazmat_load: false,
    },
  };

  const verdict = await checkCarrierEmail(e);

  // Only hand the renderer the `extracted` email when we actually grabbed
  // page-side context (a sender or a lane). With just a DOT there's nothing
  // meaningful for the "From the email" block, so we omit it and show the
  // carrier profile + checks alone.
  const hasPageContext = !!(senderEmail || from || to);
  const html = buildReplyHtml(verdict, hasPageContext ? e : undefined);
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // No-store: verdicts read live FMCSA data + run DNS/WHOIS at request time.
      "cache-control": "no-store",
    },
  });
}
