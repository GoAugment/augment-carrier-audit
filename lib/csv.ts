/**
 * Convert audit rows to a CSV string suitable for download or email attachment.
 *
 * Format mirrors the on-screen scorecard plus the prose reasoning, so a broker
 * can file the CSV as their audit trail without losing fidelity. The original
 * per-axis columns are preserved; two extra column groups are appended:
 *   - FMCSA: the Augie scores (ISS / Safety / Risk) + the raw BASIC percentiles
 *   - Regulatory: insurance / lapse / cancellation, revocations, enforcement,
 *     authority, MC# — the standing details behind the verdict.
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

const pct = (p: number | null | undefined): string =>
  p == null ? "" : String(Math.round(p));
const yn = (b: boolean | null | undefined): string => (b ? "Y" : "");

const HEADERS = [
  // --- identity / context ---
  "Rank",
  "Risk tier",
  "Carrier",
  "DOT",
  "Peer group",
  "Power units",
  "Loads",
  // --- on-screen axes (display + status) ---
  "Crash (display)",
  "Crash status",
  "Unsafe Driving (display)",
  "Unsafe Driving status",
  "HOS (display)",
  "HOS status",
  "Driver Fitness (display)",
  "Driver Fitness status",
  "Vehicle Maint (display)",
  "Vehicle Maint status",
  "Hazmat (display)",
  "Hazmat status",
  "Revocations (display)",
  "Revocations status",
  "Authority (display)",
  "Authority status",
  "BIPD insurance (display)",
  "Insurance status",
  // --- FMCSA: Augie scores + raw BASIC percentiles ---
  "ISS score",
  "ISS tier",
  "Safety score",
  "Safety tier",
  "Crashes per million miles",
  "Crash Indicator %ile (est)",
  "Unsafe Driving %ile",
  "HOS %ile",
  "Driver Fitness %ile",
  "Controlled Substances %ile",
  "Vehicle Maintenance %ile",
  "Hazmat Compliance %ile (est)",
  "FAST-Act high-risk",
  "Serious/acute violation",
  // --- Regulatory: risk + insurance + standing ---
  "Risk score",
  "Risk tier",
  "Risk factors",
  "BIPD on file ($k)",
  "BIPD required ($k)",
  "Insurer",
  "Insurance cancellations 24mo",
  "Imminent lapse",
  "Days to lapse",
  "Pending cancel date",
  "Revocations (total)",
  "Involuntary revocations",
  "Most recent involuntary",
  "Enforcement cases",
  "FMCSA safety rating",
  "Operating authority",
  "MC number",
  // --- prose ---
  "Reasons (prose)",
];

function row(r: CarrierRow): string {
  const c = r.carrier;
  const reasons = r.reasons.map((rs) => `${rs.label}: ${rs.detail}`).join(" | ");
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
    // FMCSA
    r.issScore,
    r.issTier,
    r.safetyScore,
    r.safetyTier,
    c.crashesPerMillionMiles == null ? "" : c.crashesPerMillionMiles.toFixed(2),
    pct(c.crashIndicatorPercentile),
    pct(c.unsafeDrivingPercentile),
    pct(c.hosPercentile),
    pct(c.driverFitnessPercentile),
    pct(c.controlledSubstancesPercentile),
    pct(c.vehicleMaintenancePercentile),
    pct(c.hmCompliancePercentile),
    yn(c.fastActHighRisk),
    yn(c.hasSeriousViolation),
    // Regulatory
    r.riskScore,
    r.riskTier,
    r.riskFactors.join("; "),
    c.bipdInsuranceOnFile,
    c.bipdRequiredAmount,
    c.bipdInsurerName,
    c.insuranceCancellations24mo,
    yn(c.bipdImminentLapse),
    c.bipdDaysToLapse,
    c.bipdPendingCancelDate,
    c.revocationsTotal,
    c.involuntaryRevocations,
    c.mostRecentInvoluntaryDate,
    c.enforcementCasesCount,
    c.safetyRating,
    c.allowedToOperate,
    c.mcNumber,
    reasons,
  ]
    .map(escape)
    .join(",");
}

export function toCsv(result: AuditResult): string {
  const lines: string[] = [];
  // Preamble — methodology note + summary, prefixed with # so it's clearly
  // human context, not a data row.
  lines.push(`# Augment Carrier Safety Audit — ${new Date().toISOString().slice(0, 10)}`);
  lines.push(
    `# ${result.totalLoads} loads / ${result.totalCarriers} carriers / ${result.flaggedCarriers} flagged`
  );
  lines.push(
    `# Tiers: ${result.bySeverity.Critical} Critical, ${result.bySeverity.High} High, ${result.bySeverity.Medium} Medium`
  );
  lines.push(
    `# Methodology: FMCSA SMS BASIC percentiles (peer-ranked) + Augie ISS/Safety/Risk scores. ` +
      `Crash & Hazmat percentiles (est) are our reproductions — FMCSA does not publish them. ` +
      `Crashes per million miles uses the MCS-150 VMT denominator. Insurance/revocation/authority from L&I feeds.`
  );
  lines.push("");
  lines.push(HEADERS.map(escape).join(","));
  for (const r of result.rows) lines.push(row(r));
  return lines.join("\n");
}
