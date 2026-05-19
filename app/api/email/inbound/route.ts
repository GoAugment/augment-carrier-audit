/**
 * POST /api/email/inbound
 *
 * SendGrid Inbound Parse webhook target. Configure SendGrid to POST parsed
 * email payloads to this URL when mail arrives at safe@augie.ai (or the
 * subdomain we point at it).
 *
 * Full lifecycle:
 *   1. Parse SendGrid's multipart/form-data payload
 *   2. Call Anthropic Claude (Haiku) with the Stage 1 prompt → ExtractedEmail
 *   3. Run checkCarrierEmail() → Verdict
 *   4. Format the Verdict into a reply email body
 *   5. Send the reply via SendGrid outbound to the original broker
 *   6. Return 200 to SendGrid so it doesn't retry
 *
 * All steps inside one function — no internal HTTP hops. checkCarrierEmail
 * is imported directly from lib/email/check.ts.
 *
 * Error handling: SendGrid retries on 4xx/5xx. We catch all internal errors
 * and return 200 (after logging) to avoid retry loops that would either
 * exhaust LLM credits or hammer the broker with duplicate replies. The one
 * exception is failure during the SendGrid OUTBOUND step — we'll still
 * return 200 to SendGrid Inbound because there's no use retrying inbound,
 * but we log loudly so the broker outage is visible.
 */
import { NextRequest, NextResponse } from "next/server";
import { extractEmail } from "@/lib/email/extract";
import { checkCarrierEmail } from "@/lib/email/check";
import { formatReply } from "@/lib/email/format-reply";
import { sendReply } from "@/lib/email/send";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;
// Prevent Next.js from trying to statically pre-render this route at build
// time. duckdb's native binary requires libstdc++ ≥12 (GLIBCXX_3.4.30) which
// isn't available in Vercel's build container — only in the function
// runtime. Forcing dynamic skips the build-time load attempt.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const t0 = Date.now();
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch (err) {
    logEvent("email_inbound_parse_error", {
      err: err instanceof Error ? err.message : String(err),
    });
    // SendGrid sent us something we couldn't parse. Return 200 — retrying
    // won't help, and we don't want SendGrid pile-driving us.
    return NextResponse.json({ ok: true, note: "unparseable payload" });
  }

  const brokerEmail = pickFirstAddress(
    (formData.get("from") as string) ?? ""
  );
  const toField = (formData.get("to") as string) ?? "";
  const subject = (formData.get("subject") as string) ?? "(no subject)";
  const bodyText = (formData.get("text") as string) ?? "";
  const bodyHtml = (formData.get("html") as string) ?? "";
  const rawHeaders = (formData.get("headers") as string) ?? "";
  const inboundMessageId = extractMessageId(rawHeaders);

  // Recipient filter: only process mail addressed to safe@*. We MX'd the
  // augie.ai apex to SendGrid Inbound Parse, which means ALL @augie.ai mail
  // arrives here — including marketing@, hello@, anything anyone makes up.
  // We only have value for the safe@ flow, so silently drop everything else.
  // (We return 200 so SendGrid doesn't retry.)
  if (!isSafeRecipient(toField)) {
    logEvent("email_inbound_ignored_recipient", { to: toField, from: brokerEmail });
    return NextResponse.json({ ok: true, note: "not a safe@ recipient" });
  }

  if (!brokerEmail) {
    logEvent("email_inbound_no_from", { subject });
    return NextResponse.json({ ok: true, note: "no From: address" });
  }

  // Step 2: LLM extraction
  let extracted;
  try {
    extracted = await extractEmail({
      bodyText,
      bodyHtml,
      rawHeaders,
      brokerEmail,
      subject,
    });
  } catch (err) {
    logEvent("email_inbound_extraction_error", {
      brokerEmail,
      err: err instanceof Error ? err.message : String(err),
    });
    // Don't reply to the broker if extraction failed — we'd be sending a
    // useless email. Just acknowledge to SendGrid.
    return NextResponse.json({ ok: true, note: "extraction failed" });
  }

  // Step 3: deterministic verdict
  let verdict;
  try {
    verdict = await checkCarrierEmail(extracted);
  } catch (err) {
    logEvent("email_inbound_check_error", {
      brokerEmail,
      dot: extracted.identity_claims.dot_number,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ ok: true, note: "check failed" });
  }

  // Step 4-5: format + send the reply
  const reply = formatReply(verdict, subject);
  try {
    await sendReply({
      to: brokerEmail,
      subject: reply.subject,
      text: reply.text,
      html: reply.html,
      inReplyTo: inboundMessageId,
    });
  } catch (err) {
    logEvent("email_inbound_send_error", {
      brokerEmail,
      tier: verdict.tier,
      err: err instanceof Error ? err.message : String(err),
    });
    // The verdict was computed; sending the reply failed. Log loudly but
    // still 200 — SendGrid retrying won't help SES outbound.
    return NextResponse.json({ ok: true, note: "send failed" });
  }

  const elapsedMs = Date.now() - t0;
  logEvent("email_inbound_complete", {
    brokerEmail: maskEmail(brokerEmail),
    tier: verdict.tier,
    dot: verdict.carrier?.dotNumber ?? null,
    signal_count: verdict.signals.length,
    coverage_richness: Object.values(verdict.coverage).filter(Boolean).length,
    elapsed_ms: elapsedMs,
  });

  return NextResponse.json({ ok: true });
}

/**
 * Pull the email address from a From: line that might be in the form
 * "Joe Broker <joe@brokerage.com>" or just "joe@brokerage.com".
 */
function pickFirstAddress(s: string): string {
  const m = s.match(/<([^>]+)>/);
  if (m) return m[1].trim().toLowerCase();
  return s.trim().toLowerCase();
}

/**
 * Recipient guard: only safe@augie.ai (or safe@anything-augie.ai for the
 * subdomain variant) is in scope. The To: field can have multiple
 * recipients comma-separated; we treat it as a match if ANY recipient is
 * a safe@ address.
 */
function isSafeRecipient(toField: string): boolean {
  if (!toField) return false;
  // Match safe@augie.ai OR safe@<subdomain>.augie.ai (e.g. safe@parse.augie.ai)
  return /\bsafe@(?:[a-z0-9-]+\.)*augie\.ai\b/i.test(toField);
}

/** Pull the Message-ID header value from a raw headers blob. */
function extractMessageId(rawHeaders: string): string | undefined {
  const m = rawHeaders.match(/^Message-ID:\s*(<[^>]+>)/im);
  return m?.[1];
}

/**
 * Mask a broker email for telemetry — keep the domain so we can see which
 * brokerages are using safe@, but obfuscate the user part. We don't need
 * cryptographic hashing here; this is internal analytics, not auth.
 */
function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${user.slice(0, 3)}***@${domain}`;
}
