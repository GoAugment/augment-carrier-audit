/**
 * Dev/preview route: render the carrier-email reply for a DOT so the email
 * output is easy to eyeball without sending a real message.
 *
 *   localhost:3000/check/3621624            (defaults to a NY→FL lane)
 *   localhost:3000/check/3621624?from=NY&to=FL
 *
 * Synthesizes a minimal ExtractedEmail (DOT + lane only) and runs the real
 * single-MC check + reply renderer. The lane drives the lane-coverage advisory.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCarrierEmail } from "@/lib/email/check";
import { buildReplyHtml } from "@/lib/email/format-reply-html";
import type { ExtractedEmail } from "@/lib/email/types";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { dot: string } }
) {
  const sp = req.nextUrl.searchParams;
  const from = (sp.get("from") || "NY").toUpperCase().slice(0, 2);
  const to = (sp.get("to") || "FL").toUpperCase().slice(0, 2);
  const e: ExtractedEmail = {
    extracted_text: `Preview render for DOT ${params.dot}, lane ${from} → ${to}.`,
    summary: "Preview render (synthetic email).",
    identity_claims: {
      dot_number: params.dot,
      mc_number: null,
      claimed_company_name: null,
      claimed_phone: null,
      contact_person: null,
    },
    sender_metadata: {
      sender_email: "",
      sender_email_domain: "",
      sender_display_name: "",
      reply_to_domain: null,
    },
    behavioral_signals: {
      is_response_to_load_posting: false,
      urgency_markers: [],
      has_signature_block: false,
      specificity_score: 1,
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
  const html = buildReplyHtml(verdict, e);
  return new NextResponse(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
