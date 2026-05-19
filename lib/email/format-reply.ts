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
import { buildReplyHtml } from "./format-reply-html";

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
  /** HTML alternative — SendGrid sends both parts; clients pick. Plain text
   *  is still the fallback for accessibility / forwarding. */
  html: string;
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
    if (c.physicalLocation) {
      lines.push(`  Based in ${c.physicalLocation}`);
    }
    if (c.dotIssued) {
      lines.push(`  DOT issued ${c.dotIssued} (${ageYears(c.dotIssued)} years of authority)`);
    }
    if (c.powerUnits) {
      const fleet = `${c.powerUnits} power unit${c.powerUnits === 1 ? "" : "s"}`;
      const drivers = c.drivers ? `, ${c.drivers} driver${c.drivers === 1 ? "" : "s"}` : "";
      lines.push(`  Fleet: ${fleet}${drivers}  (self-reported on MCS-150)`);
    }
    if (c.operatingArea) {
      lines.push(`  Operating area: ${describeOperatingArea(c.operatingArea)}`);
    }
    if (c.cargoCapabilities.length > 0) {
      lines.push(`  Registered cargo: ${c.cargoCapabilities.join(", ")}`);
    }
    if (c.fmcsaPhone) {
      lines.push(`  FMCSA-registered phone: ${formatPhone(c.fmcsaPhone)}`);
    }
    if (c.fmcsaEmail) {
      lines.push(`  FMCSA-registered email: ${c.fmcsaEmail}`);
    } else if (c.fmcsaEmailDomain) {
      lines.push(`  FMCSA-registered email domain: ${c.fmcsaEmailDomain}`);
    }
    if (c.bipdInsurer) {
      lines.push(`  BIPD insurer on file: ${c.bipdInsurer}`);
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
  // first, then verified-positive info signals, then remaining context.
  // Splitting the info bucket lets brokers see "what we verified" without
  // hunting through context-only notes.
  const hardSignals = verdict.signals.filter((s) => s.tier !== "info");
  const verifiedSignals = verdict.signals.filter(
    (s) => s.tier === "info" && isVerifiedPositive(s)
  );
  const otherInfoSignals = verdict.signals.filter(
    (s) => s.tier === "info" && !isVerifiedPositive(s)
  );

  if (hardSignals.length > 0) {
    lines.push("WHAT WE FOUND:");
    for (const s of hardSignals) {
      lines.push(`  ${TIER_ICON[s.tier]} ${s.label}`);
      lines.push(`    ${s.detail}`);
    }
    lines.push("");
  }

  if (verifiedSignals.length > 0) {
    lines.push("VERIFIED:");
    for (const s of verifiedSignals) {
      lines.push(`  ✓ ${s.label}`);
      lines.push(`    ${s.detail}`);
    }
    lines.push("");
  }

  if (otherInfoSignals.length > 0) {
    lines.push("CONTEXT (not flagged, but worth knowing):");
    for (const s of otherInfoSignals) {
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

  return { subject, text: lines.join("\n"), html: buildReplyHtml(verdict) };
}

/** Format 10-digit US phone numbers. Leaves international numbers alone. */
function formatPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1"))
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}

/** Info-tier signals split into "verified-positive" (passing checks the
 *  broker should know succeeded) and "general context" (notes that don't
 *  imply verification). Keyed off label prefixes from the evaluators. */
function isVerifiedPositive(s: Signal): boolean {
  const label = s.label.toLowerCase();
  return (
    label.startsWith("email authentication passed") ||
    label.startsWith("sender domain matches fmcsa") ||
    label.startsWith("sender domain age")
  );
}

function ageYears(yearStr: string): number {
  const y = parseInt(yearStr, 10);
  if (!Number.isFinite(y)) return 0;
  return new Date().getFullYear() - y;
}

const OPERATING_AREA_LABEL: Record<string, string> = {
  interstate_otr: "Interstate, long-haul",
  interstate_local: "Interstate within 100 miles",
  intrastate_long: "Intrastate, beyond 100 miles",
  intrastate_local: "Intrastate within 100 miles",
  unknown: "Unspecified",
};
function describeOperatingArea(area: string): string {
  return OPERATING_AREA_LABEL[area] ?? area;
}

function describeSkipped(coverage: Verdict["coverage"]): string {
  const skipped: string[] = [];
  if (!coverage.mc_match_checked) skipped.push("MC# match");
  if (!coverage.name_match_checked) skipped.push("company name match");
  if (!coverage.phone_match_checked) skipped.push("phone match");
  if (!coverage.lane_viability_checked) skipped.push("lane viability");
  if (!coverage.sender_domain_match_checked) skipped.push("sender domain match");
  // hazmat_match_checked is skipped on every non-hazmat email — that's
  // expected, not a coverage gap. Don't surface unless the broker would
  // expect the check to have run.

  if (skipped.length === 0) return "All checks ran with full data.";
  return `Skipped because the email didn't include the needed inputs: ${skipped.join(", ")}.`;
}
