/**
 * Convert audit rows to a CSV string suitable for download or email attachment.
 *
 * Format mirrors the on-screen scorecard plus the prose reasoning, so a broker
 * can file the CSV as their audit trail without losing fidelity.
 */
import type { AuditResult, CarrierRow } from "./analyzer";

function escape(value: string | number | null | undefined): string {
  if (value == null) return "";
  const s = String(value);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

const HEADERS = [
  "Rank",
  "Risk tier",
  "Carrier",
  "DOT",
  "Peer group",
  "Power units",
  "Loads",
  "Crashes per million miles",
  "Crashes status",
  "Unsafe Driving rate",
  "Unsafe Driving status",
  "HOS Compliance rate",
  "HOS status",
  "Driver OOS rate",
  "Driver OOS status",
  "Vehicle OOS rate",
  "Vehicle OOS status",
  "Hazmat OOS rate",
  "Hazmat OOS status",
  "Revocations",
  "Revocations status",
  "Authority",
  "Authority status",
  "BIPD insurance",
  "Insurance status",
  "Reasons (prose)",
];

function row(r: CarrierRow): string {
  const reasons = r.reasons
    .map((rs) => `${rs.label}: ${rs.detail}`)
    .join(" | ");
  return [
    r.rank,
    r.riskLevel,
    r.carrierName ?? "unknown",
    r.dot,
    r.peerGroupLabel,
    r.powerUnits,
    r.loadCount,
    r.axes.crash.display,
    r.axes.crash.status,
    r.axes.unsafeDriving.display,
    r.axes.unsafeDriving.status,
    r.axes.hos.display,
    r.axes.hos.status,
    r.axes.driverOos.display,
    r.axes.driverOos.status,
    r.axes.vehicleOos.display,
    r.axes.vehicleOos.status,
    r.axes.hazmatOos.display,
    r.axes.hazmatOos.status,
    r.axes.revocations.display,
    r.axes.revocations.status,
    r.axes.authority.display,
    r.axes.authority.status,
    r.axes.insurance.display,
    r.axes.insurance.status,
    reasons,
  ]
    .map(escape)
    .join(",");
}

export function toCsv(result: AuditResult): string {
  const lines: string[] = [];
  // Preamble — methodology note + summary, prefixed with # so it's clearly
  // human context, not a data row. Excel will treat as a comment-ish line.
  lines.push(
    `# Augment Carrier Safety Audit — ${new Date().toISOString().slice(0, 10)}`
  );
  lines.push(
    `# ${result.totalLoads} loads / ${result.totalCarriers} carriers / ${result.flaggedCarriers} flagged`
  );
  lines.push(
    `# Tiers: ${result.bySeverity.Critical} Critical, ${result.bySeverity.Severe} Severe, ${result.bySeverity.High} High, ${result.bySeverity.Elevated} Elevated`
  );
  lines.push(
    `# Methodology: peer-group percentile cutoffs (P85/P90/P95) from May 2026 FMCSA bulk snapshot. Crash rate = crashes per million miles (MCS-150 VMT denominator).`
  );
  lines.push("");
  lines.push(HEADERS.map(escape).join(","));
  for (const r of result.rows) lines.push(row(r));
  return lines.join("\n");
}
