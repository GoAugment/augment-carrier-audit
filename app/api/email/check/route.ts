/**
 * POST /api/email/check
 *
 * Accepts a Stage 1 ExtractedEmail JSON (produced by the LLM extraction
 * prompt in lib/email/stage1-prompt.ts), returns a Verdict with tier +
 * evidence + coverage. Pure deterministic — no LLM in this endpoint.
 *
 * Used by an upstream email orchestrator that handles inbound (SendGrid)
 * and outbound (SES) plus the Stage 1 LLM call. Splitting the LLM step
 * upstream keeps this app's deploy footprint focused on the carrier-audit
 * primitives + the deterministic verification logic.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCarrierEmail } from "@/lib/email/check";
import { logEvent } from "@/lib/log";
import type { ExtractedEmail } from "@/lib/email/types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  let body: ExtractedEmail;
  try {
    body = (await req.json()) as ExtractedEmail;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Minimal shape check — full validation happens implicitly in checkCarrierEmail.
  if (
    !body ||
    typeof body !== "object" ||
    !body.identity_claims ||
    !body.sender_metadata ||
    !body.behavioral_signals ||
    !body.lane
  ) {
    return NextResponse.json(
      {
        error:
          "Body must match ExtractedEmail shape — see lib/email/stage1-prompt.ts for the schema.",
      },
      { status: 400 }
    );
  }

  const t0 = Date.now();
  let verdict;
  try {
    verdict = await checkCarrierEmail(body);
  } catch (err) {
    logEvent("email_check_error", {
      dot: body.identity_claims.dot_number,
      err: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { error: "Failed to evaluate email", detail: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
  const elapsedMs = Date.now() - t0;

  // Telemetry — verdict tier + coverage, no email content persisted.
  logEvent("email_check", {
    tier: verdict.tier,
    dot: verdict.carrier?.dotNumber ?? null,
    signal_categories: [...new Set(verdict.signals.map((s) => s.category))],
    signal_tiers: [...new Set(verdict.signals.map((s) => s.tier))],
    coverage_richness: Object.values(verdict.coverage).filter(Boolean).length,
    elapsed_ms: elapsedMs,
  });

  return NextResponse.json(verdict);
}
