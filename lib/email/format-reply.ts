/**
 * Turn a Verdict into the broker-facing reply email body.
 *
 * Plain text only (no HTML). Reasons:
 *   - Brokers reply to these on phones and via forwarding to teammates;
 *     plain text travels cleanly through every email client / thread
 *   - HTML rendering across clients is inconsistent (Outlook strips
 *     things, Gmail re-flows, mobile chops); plain text just works
 *   - Plain text is easier to copy/paste into Slack, tickets, CRMs
 *
 * The structure is deliberately scan-able: verdict header at top,
 * carrier-identity-block second (so brokers can verify out-of-band), then
 * signals grouped by category. No fluff, no marketing.
 */
import type { Signal, Verdict } from "./types";

const TIER_HEADER: Record<Verdict["tier"], string> = {
  Critical: "🛑 CRITICAL — do not engage without out-of-band verification",
  High: "⚠ HIGH — verify identity before tendering",
  Caution: "⚡ CAUTION — proceed with elevated scrutiny",
  Clean: "✓ CLEAN — looks legitimate",
};

const TIER_ICON: Record<Signal["tier"], string> = {
  critical: "🛑",
  high: "⚠",
  caution: "⚡",
  info: "·",
};

export interface FormattedReply {
  subject: string;
  text: string;
}

export function formatReply(verdict: Verdict, originalSubject: string): FormattedReply {
  const lines: string[] = [];

  lines.push(TIER_HEADER[verdict.tier]);
  lines.push("");
  lines.push(verdict.summary);
  lines.push("");

  // Carrier identity block — lets the broker verify by calling the
  // FMCSA-registered number directly, regardless of what the email claimed.
  if (verdict.carrier) {
    const c = verdict.carrier;
    lines.push("CARRIER (per FMCSA):");
    lines.push(`  ${c.legalName ?? "(unnamed)"}`);
    lines.push(`  DOT ${c.dotNumber}${c.mcNumber ? "  ·  " + c.mcNumber : ""}`);
    if (c.fmcsaPhone) {
      lines.push(`  FMCSA-registered phone: ${formatPhone(c.fmcsaPhone)}`);
    }
    lines.push(
      `  Carrier audit tier: ${c.audit.tier}` +
        (c.audit.reasonLabels.length
          ? ` (${c.audit.reasonLabels.join(", ")})`
          : "")
    );
    lines.push("");
  }

  // Signals grouped by category. Show hard signals (critical/high/caution)
  // first, then info-level context at the end.
  const hardSignals = verdict.signals.filter((s) => s.tier !== "info");
  const infoSignals = verdict.signals.filter((s) => s.tier === "info");

  if (hardSignals.length > 0) {
    lines.push("WHAT WE FOUND:");
    for (const s of hardSignals) {
      lines.push(`  ${TIER_ICON[s.tier]} ${s.label}`);
      lines.push(`    ${s.detail}`);
    }
    lines.push("");
  }

  if (infoSignals.length > 0) {
    lines.push("CONTEXT (not flagged, but worth knowing):");
    for (const s of infoSignals) {
      lines.push(`  · ${s.label}`);
      lines.push(`    ${s.detail}`);
    }
    lines.push("");
  }

  // Coverage note — be honest about what we did and didn't check.
  const checks = verdict.coverage;
  const checksRan = Object.values(checks).filter(Boolean).length;
  const checksTotal = Object.keys(checks).length;
  lines.push(
    `Checks performed: ${checksRan} of ${checksTotal}. ` +
      `${describeSkipped(verdict.coverage)}`
  );
  lines.push("");

  // Footer
  if (verdict.carrier) {
    lines.push(
      `Full audit:  https://augment-carrier-audit.vercel.app/?dot=${verdict.carrier.dotNumber}`
    );
  }
  lines.push("— safe@augie.ai");
  lines.push(`Generated: ${verdict.generatedAt}`);

  // Subject: keep the broker's thread together, prepend the tier.
  // Strip prior "Re: " prefixes to avoid the "Re: Re: Re:" cascade.
  const baseSubject = originalSubject.replace(/^(Re:\s*)+/i, "").trim();
  const subject = `Re: ${baseSubject} — ${verdict.tier}`;

  return { subject, text: lines.join("\n") };
}

/** Format 10-digit US phone numbers. Leaves international numbers alone. */
function formatPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1"))
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}

function describeSkipped(coverage: Verdict["coverage"]): string {
  const skipped: string[] = [];
  if (!coverage.mc_match_checked) skipped.push("MC# match");
  if (!coverage.name_match_checked) skipped.push("company name match");
  if (!coverage.phone_match_checked) skipped.push("phone match");
  if (!coverage.lane_viability_checked) skipped.push("lane viability");
  if (!coverage.sender_domain_match_checked) skipped.push("sender domain match");

  if (skipped.length === 0) return "All checks ran with full data.";
  return `Skipped because the email didn't include the needed inputs: ${skipped.join(", ")}.`;
}
