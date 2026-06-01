/**
 * Convert audit rows to a CSV string suitable for download or email attachment.
 *
 * The safety block is deliberately split by DATA SOURCE so a spreadsheet user
 * can filter/pivot without conflating two different statistics:
 *   - "FMCSA …" columns = FMCSA's SMS BASIC percentile (blank where FMCSA hasn't
 *     scored the carrier). Crash Indicator + Hazmat are our faithful
 *     reconstructions of BASICs FMCSA computes but doesn't publish.
 *   - "Augie …" columns = our OWN peer-ranked measures (raw OOS rates,
 *     crashes-per-million), our methodology, NOT an FMCSA SMS percentile.
 *   - one resolved "<axis> status" per on-road axis = the tier the tool landed
 *     on for that cell (source-agnostic).
 * Non-safety columns (authority / insurance / revocation / identity / risk)
 * are unchanged.
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
/** OOS inspections / total inspections as a whole-percent string (our measure). */
const oosRate = (oos: number, insp: number): string =>
  insp > 0 ? `${Math.round((oos / insp) * 100)}%` : "";

const HEADERS = [
  // --- identity / context ---
  "Rank",
  "Risk tier",
  "Carrier",
  "DOT",
  "Peer group",
  "Power units",
  "Loads",
  // --- resolved on-road verdict (the tool's call per axis; source-agnostic) ---
  "Crash status",
  "Unsafe Driving status",
  "HOS status",
  "Driver OOS status",
  "Vehicle OOS status",
  "Hazmat OOS status",
  // --- non-safety axes (display + status) ---
  "Revocations (display)",
  "Revocations status",
  "Authority (display)",
  "Authority status",
  "BIPD insurance (display)",
  "Insurance status",
  // --- FMCSA SMS BASIC percentiles (FMCSA's number; blank where unscored) ---
  "FMCSA Unsafe Driving %ile",
  "FMCSA HOS %ile",
  "FMCSA Driver Fitness %ile",
  "FMCSA Controlled Substances %ile",
  "FMCSA Vehicle Maintenance %ile",
  "FMCSA Crash Indicator %ile (reconstructed)",
  "FMCSA Hazmat Compliance %ile (reconstructed)",
  // --- Augie peer-ranked measures (OUR methodology, not FMCSA percentiles) ---
  "Augie crashes per M-mi",
  "Augie Driver OOS rate",
  "Augie Vehicle OOS rate",
  "Augie Hazmat OOS rate",
  // --- FAST Act & serious violations ---
  "FAST-Act high-risk",
  "FAST-Act BASICs >=90th (count)",
  "FAST-Act BASICs (which)",
  "Serious/acute violation",
  "Serious violation count",
  "Serious violation BASICs",
  // --- roll-up scores ---
  "ISS score (est)",
  "ISS tier",
  "Augie Safety score",
  "Augie Safety tier",
  // --- Regulatory: risk + insurance + standing ---
  "Risk score",
  "Risk tier",
  "Risk contributions",
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
  const riskContributions = r.riskContributions
    .map((f) => `+${f.points} [${f.category}] ${f.label}: ${f.detail}`)
    .join("; ");
  return [
    r.rank,
    r.riskLevel,
    r.carrierName ?? "unknown",
    r.dot,
    r.peerGroupLabel,
    r.powerUnits,
    r.loadCount,
    // resolved on-road verdict (status only, the underlying numbers live in
    // the source-separated groups below)
    r.axes.crash.status,
    r.axes.unsafeDriving.status,
    r.axes.hos.status,
    r.axes.driverOos.status,
    r.axes.vehicleOos.status,
    r.axes.hazmatOos.status,
    // non-safety axes
    r.axes.revocations.display,
    r.axes.revocations.status,
    r.axes.authority.display,
    r.axes.authority.status,
    r.axes.insurance.display,
    r.axes.insurance.status,
    // FMCSA SMS BASIC percentiles (FMCSA's own number)
    pct(c.unsafeDrivingPercentile),
    pct(c.hosPercentile),
    pct(c.driverFitnessPercentile),
    pct(c.controlledSubstancesPercentile),
    pct(c.vehicleMaintenancePercentile),
    pct(c.crashIndicatorPercentile),
    pct(c.hmCompliancePercentile),
    // Augie peer-ranked measures (ours)
    c.crashesPerMillionMiles == null ? "" : c.crashesPerMillionMiles.toFixed(2),
    oosRate(c.driverOosInsp, c.driverInsp),
    oosRate(c.vehicleOosInsp, c.vehicleInsp),
    oosRate(c.hazmatOosInsp, c.hazmatInsp),
    // FAST Act & serious violations
    yn(c.fastActHighRisk),
    c.fastActHighRiskN,
    c.fastActHighRiskBasics,
    yn(c.hasSeriousViolation),
    c.seriousViolationCount,
    c.seriousViolationBasics,
    // roll-up scores
    r.issScore,
    r.issTier,
    r.safetyScore,
    r.safetyTier,
    // Regulatory
    r.riskScore,
    r.riskTier,
    riskContributions || r.riskFactors.join("; "),
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
  // Preamble, methodology note + summary, prefixed with # so it's clearly
  // human context, not a data row.
  lines.push(`# Augment Carrier Safety Audit, ${new Date().toISOString().slice(0, 10)}`);
  lines.push(
    `# ${result.totalLoads} loads / ${result.totalCarriers} carriers / ${result.flaggedCarriers} flagged`
  );
  lines.push(
    `# Tiers: ${result.bySeverity.Critical} Critical, ${result.bySeverity.High} High, ${result.bySeverity.Medium} Medium`
  );
  lines.push(
    `# Safety sources are split by column prefix. "FMCSA …" = FMCSA's SMS BASIC percentile ` +
      `(blank where FMCSA hasn't scored the carrier; Crash Indicator + Hazmat are our faithful ` +
      `reconstructions of BASICs FMCSA doesn't publish). "Augie …" = our own peer-ranked measures ` +
      `(raw OOS rates; crashes-per-million via MCS-150 VMT), used where FMCSA has no percentile, ` +
      `NOT an FMCSA SMS percentile. ISS score is our reproduction (est). Risk score is our additive ` +
      `index. Insurance/revocation/authority from L&I feeds.`
  );
  lines.push("");
  lines.push(HEADERS.map(escape).join(","));
  for (const r of result.rows) lines.push(row(r));
  return lines.join("\n");
}
