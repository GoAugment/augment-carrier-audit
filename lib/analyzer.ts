/**
 * Carrier risk analyzer — scorecard model.
 *
 * Produces a uniform row per carrier (flagged or clean) with per-axis status
 * cells, so the UI can render every carrier in the same scannable shape.
 *
 * Per-axis classification uses peer-group percentile cutoffs (P85/P90/P95)
 * from the FMCSA bulk snapshot. Overall risk tier is the worst axis status,
 * with bumps for compound signals (recent revocation + statistical signal →
 * Severe; chronic revocations → bump; large enforcement → bump).
 *
 * Methodology mirrors FMCSA SMS BASIC alerts with two practical departures:
 *   1. Crash axis uses raw count ÷ miles (vs SMS's severity- and time-weighted
 *      ÷ PU + utilization). Reason: industry conventions report
 *      "crashes per million miles," it's robust against self-reported PU
 *      inflation, and the unit is what every safety director already uses.
 *   2. An absolute crash floor (2.0 cpm) bumps tier up one regardless of
 *      peer group — small fleets with operationally bad crash rates don't
 *      hide behind "normal for small."
 */
import type { FmcsaCarrier } from "./fmcsa";
import { getRule } from "./rules";
import {
  getCutoffs,
  peerGroupForPU,
  peerGroupLabel,
  MIN_PU_FOR_CRASH,
  MIN_INSP_FOR_OOS,
  type AxisKey,
  type PeerGroup,
  type TierCutoffs,
  nationalThresholds,
} from "./thresholds";

export type RiskLevel = "Critical" | "Severe" | "High" | "Elevated";
export type AxisStatus =
  | "critical"
  | "severe"
  | "high"
  | "elevated"
  /** "info" surfaces historical/contextual signals (e.g. old revocations) in
   *  the cell without contributing to the carrier's overall risk tier. */
  | "info"
  | "clean"
  | "na";

const TIER_ORDER: RiskLevel[] = ["Critical", "Severe", "High", "Elevated"];
const ABSOLUTE_CRASH_FLOOR = 2.0; // crashes per million miles

// Industry-standard insurance + tenure floors (mirrors what Armstrong Transport
// Group and similar broker stacks enforce). FMCSA's "required" amount can be
// lower than the industry norm; we apply max(FMCSA-required, industry-floor).
const BIPD_FLOOR_DEFAULT_K = 1_000;   // $1.0M
const BIPD_FLOOR_HAZMAT_K = 5_000;    // $5.0M for hazmat loads
const BIPD_FLOOR_NJ_K = 1_500;        // $1.5M for NJ-based carriers
const CARGO_FLOOR_K = 100;            // $100k cargo minimum
const MIN_AUTHORITY_AGE_DAYS = 90;    // 90-day authority tenure

const RECENT_REVOCATION_WINDOW_DAYS = 730;
const CHRONIC_REVOCATION_THRESHOLD = 3;
const RECENT_ENFORCEMENT_WINDOW_DAYS = 730;
const ENFORCEMENT_LARGE_SETTLEMENT = 25_000;
// MCS-150 freshness affects cpm reliability — denominator gets stale fast.
const MCS150_STALE_DAYS = 730; // 24 months
// Safety rating ages out — Hunt's 1992 Satisfactory shouldn't be treated as
// equivalent to a 2024 Satisfactory.
const RATING_AGE_OUT_YEARS = 10;
// National percentile cutoffs for FMCSA BASIC measures (P85/P95/P99) — used
// only to label measure values in detail strings; not for tier decisions.
// Derived from the May 2026 parquet population, ≥5 driver inspections.
const FMCSA_MEASURE_CUTOFFS = {
  unsafeDriving:        { p85: 10.0, p95: 19.7, p99: 40.0 },
  hos:                  { p85: 2.73, p95: 4.79, p99: 7.60 },
  driverFitness:        { p85: 2.00, p95: 3.45, p99: 6.16 },
  controlledSubstances: { p85: 0.75, p95: 1.50, p99: 3.00 },
  vehicleMaintenance:   { p85: 10.75, p95: 15.63, p99: 21.75 },
} as const;
const CHAMELEON_CLUSTER_THRESHOLD = 2;

export interface LoadInput {
  dot: number;
  loadId?: string;
  isHazmat?: boolean;
}

export interface Reason {
  label: string;
  detail: string;
}

/** One cell in the scorecard — covers one axis for one carrier. */
export interface AxisCell {
  status: AxisStatus;
  /** Compact value to render in the cell (e.g. "43%", "1.19", "—"). */
  display: string;
  /** Longer explanation shown on hover/expand. */
  detail?: string;
}

export interface CarrierRow {
  rank: number;
  dot: number;
  carrierName: string | null;
  peerGroup: PeerGroup;
  peerGroupLabel: string;
  powerUnits: number;
  loadCount: number;
  loadIds: string[];
  hazmatLoadIds: string[];
  hasFatalCrash: boolean;
  /** Overall risk tier. "Clean" means no axis flagged. */
  riskLevel: RiskLevel | "Clean";
  axes: {
    crash: AxisCell;
    unsafeDriving: AxisCell;
    hos: AxisCell;
    driverOos: AxisCell;
    vehicleOos: AxisCell;
    hazmatOos: AxisCell;
    revocations: AxisCell;
    authority: AxisCell;
    insurance: AxisCell;
  };
  /** Prose summary of the flagged signals (for tooltip / expand). */
  reasons: Reason[];
  /**
   * Sort metadata. Drives the in-tier ordering: statistical-signal carriers
   * first, ranked by worst-axis severity then magnitude. Pattern-only carriers
   * (revocations / enforcement / authority / insurance) sort to the bottom of
   * their tier.
   */
  sortMeta: {
    hasStatSignal: boolean;
    /** Higher = more severe axis. 0 if no statistical signal. */
    worstAxisRank: number;
    /** observed_rate / peer_P95_cutoff. 0 if no statistical signal. */
    worstAxisMagnitude: number;
  };
}

export interface AuditResult {
  totalLoads: number;
  totalCarriers: number;
  flaggedCarriers: number;
  bySeverity: Record<RiskLevel, number>;
  rows: CarrierRow[];
  thresholdsUsed: typeof nationalThresholds;
  unresolvedDots: number[];
}

// ---------- helpers ----------

function daysAgo(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const d = Date.parse(isoDate.slice(0, 10));
  if (Number.isNaN(d)) return null;
  return (Date.now() - d) / (1000 * 60 * 60 * 24);
}

function statTier(value: number, cuts: TierCutoffs): AxisStatus {
  // Tightened from the original P85/P90/P95 ladder to flag only P95+ — the
  // P85/P90 tiers produced too many marginal small-fleet false positives
  // (carriers a few violations above their peer-group middle). P95 remains
  // Severe because the cutoff is "1-in-20" — those are real outliers.
  if (value >= cuts.p95) return "severe";
  return "clean";
}

function statusRank(s: AxisStatus): number {
  // higher = worse. "info" doesn't roll up — same as clean for tier purposes.
  switch (s) {
    case "critical":
      return 4;
    case "severe":
      return 3;
    case "high":
      return 2;
    case "elevated":
      return 1;
    case "info":
      return 0;
    case "clean":
      return 0;
    case "na":
      return -1;
  }
}

function statusToRiskLevel(s: AxisStatus): RiskLevel | "Clean" {
  if (s === "critical") return "Critical";
  if (s === "severe") return "Severe";
  if (s === "high") return "High";
  if (s === "elevated") return "Elevated";
  return "Clean";
}

function bumpUp(t: RiskLevel | "Clean"): RiskLevel | "Clean" {
  if (t === "Clean") return "Elevated";
  if (t === "Elevated") return "High";
  if (t === "High") return "Severe";
  return t; // Severe and Critical stay
}

function bandLabel(s: AxisStatus): string {
  if (s === "severe") return "Severe/P95";
  if (s === "high") return "High/P90";
  if (s === "elevated") return "Elevated/P85";
  return "";
}

function cutoffForStatus(cuts: TierCutoffs, s: AxisStatus): number {
  if (s === "severe") return cuts.p95;
  if (s === "high") return cuts.p90;
  return cuts.p85;
}

/**
 * Format an FMCSA BASIC measure value as a P-rank label.
 *   formatFmcsaMeasure(19.7, "unsafeDriving") → "19.7 (≈P95)"
 * Returns null when measure is null/zero so we don't pollute the tooltip
 * with "0 (below P50)" lines for clean carriers.
 */
function formatFmcsaMeasure(
  measure: number | null | undefined,
  basic: keyof typeof FMCSA_MEASURE_CUTOFFS
): string | null {
  if (measure == null || measure === 0) return null;
  const cuts = FMCSA_MEASURE_CUTOFFS[basic];
  let label: string;
  if (measure >= cuts.p99) label = "≥P99 — top 1% nationally";
  else if (measure >= cuts.p95) label = "≈P95 — top 5%";
  else if (measure >= cuts.p85) label = "≈P85 — top 15%";
  else label = "below P85";
  return `${measure.toFixed(2)} (${label})`;
}

/**
 * Append FMCSA measure + alert evidence to a cell's detail tooltip, after our
 * own peer-group scoring has already produced the status. Display-only — does
 * not change the cell's tier.
 */
function enrichAxisDetailWithFmcsa(
  cell: AxisCell,
  measure: number | null | undefined,
  alert: string | null | undefined,
  basic: keyof typeof FMCSA_MEASURE_CUTOFFS
): void {
  const measureLine = formatFmcsaMeasure(measure, basic);
  if (measureLine == null && alert !== "Y") return;
  const parts: string[] = [];
  if (measureLine) parts.push(`FMCSA measure: ${measureLine}`);
  if (alert === "Y") parts.push("FMCSA Alert: ⚠ Yes");
  cell.detail = cell.detail ? `${cell.detail}\n${parts.join(". ")}.` : parts.join(". ");
}

/** Years between two ISO dates, null if either is missing/invalid. */
function yearsBetween(fromIso: string | null, toIso: string | null): number | null {
  if (!fromIso || !toIso) return null;
  const a = Date.parse(fromIso);
  const b = Date.parse(toIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.abs(b - a) / (1000 * 60 * 60 * 24 * 365.25);
}

// ---------- per-axis classifiers ----------

function classifyOos(
  axisKey: AxisKey,
  oosCount: number,
  inspections: number,
  peer: PeerGroup,
  axisLabel: string
): { cell: AxisCell; reason: Reason | null } {
  if (inspections < MIN_INSP_FOR_OOS) {
    return {
      cell: {
        status: "na",
        display: "—",
        detail: `Only ${inspections} inspection(s) in last 24 months — not enough data to score.`,
      },
      reason: null,
    };
  }
  const rate = oosCount / inspections;
  const cuts = getCutoffs(axisKey, peer);
  const status = statTier(rate, cuts);
  const pctStr = `${(rate * 100).toFixed(0)}%`;
  const cell: AxisCell = {
    status,
    display: pctStr,
    detail: `${oosCount} of ${inspections} inspections. ${
      status === "clean"
        ? `Below ${peerGroupLabel[peer]} P85 cutoff of ${(
            cuts.p85 * 100
          ).toFixed(0)}%.`
        : `Above ${bandLabel(status)} cutoff for ${peerGroupLabel[peer]} fleets (${(
            cutoffForStatus(cuts, status) * 100
          ).toFixed(0)}%).`
    }`,
  };
  if (status === "clean" || status === "na") return { cell, reason: null };
  const cutoff = cutoffForStatus(cuts, status);
  const magnitude = cutoff > 0 ? rate / cutoff : 1;
  // Tag the magnitude with a brief outlier label so brokers can distinguish
  // "barely over the P95 line" from "way beyond." No new tier — just text.
  const magLabel =
    magnitude >= 3 ? "extreme outlier"
    : magnitude >= 2 ? "deep outlier"
    : magnitude >= 1.5 ? "well above cutoff"
    : "just over cutoff";
  return {
    cell,
    reason: {
      label: axisLabel,
      detail: `${pctStr} — ${oosCount} of ${inspections} inspections. Above ${bandLabel(status)} cutoff for ${peerGroupLabel[peer]} fleets (${(cutoff * 100).toFixed(0)}%). ${magnitude.toFixed(2)}× over cutoff (${magLabel}).`,
    },
  };
}

function classifyCrash(
  c: FmcsaCarrier,
  peer: PeerGroup
): { cell: AxisCell; reason: Reason | null } {
  const cpm = c.crashesPerMillionMiles;
  // Gate on mileage alone (≥100k annual). Mileage is the right exposure
  // proxy; PU floor would exclude legit 2-4 truck operators with real VMT.
  if (!c.annualMileage || c.annualMileage < 100_000 || cpm == null) {
    return {
      cell: {
        status: "na",
        display: "—",
        detail: `Annual mileage on file is below 100k — not enough exposure to compute a crash rate per million miles.`,
      },
      reason: null,
    };
  }
  if (c.crashTotal === 0) {
    return {
      cell: { status: "clean", display: "0.00", detail: "No crashes in last 24 months." },
      reason: null,
    };
  }
  const cuts = getCutoffs("crashesPerMillionMiles" as AxisKey, peer);
  // Note: thresholds.ts has the cutoffs under crashesPerMillionMiles via the
  // JSON file's `crashes_per_million_miles` field — getCutoffs handles it.
  let status = statTier(cpm, cuts);
  // Absolute floor: a small carrier with a genuinely bad crash rate doesn't
  // hide behind "normal for small."
  let floorApplied = false;
  if (cpm >= ABSOLUTE_CRASH_FLOOR) {
    floorApplied = true;
    status = (statusRank(status) > statusRank("elevated") ? status : null) ?? "elevated";
    // Bump up one level when the absolute floor trips
    const rl = statusToRiskLevel(status);
    const bumped = bumpUp(rl === "Clean" ? "Elevated" : rl);
    status =
      bumped === "Severe"
        ? "severe"
        : bumped === "High"
          ? "high"
          : bumped === "Elevated"
            ? "elevated"
            : status;
  }
  const sev: string[] = [];
  if (c.fatalCrash > 0) sev.push(`${c.fatalCrash} fatal`);
  if (c.injCrash > 0) sev.push(`${c.injCrash} injury`);
  if (c.towawayCrash > 0) sev.push(`${c.towawayCrash} tow`);
  const sevStr = sev.length ? ` (${sev.join(", ")})` : "";
  const detail = `${cpm.toFixed(2)} crashes per million miles — ${c.crashTotal} crashes on ${c.totalPowerUnits} PU${sevStr}. ${
    status === "clean"
      ? `Below ${peerGroupLabel[peer]} P85 cutoff of ${cuts.p85.toFixed(2)}.`
      : `Above ${bandLabel(status)} cutoff for ${peerGroupLabel[peer]} fleets (${cutoffForStatus(cuts, status).toFixed(2)})${floorApplied ? "; absolute crash-rate floor (2.00 cpm) applied" : ""}.`
  }`;
  const cell: AxisCell = { status, display: cpm.toFixed(2), detail };
  if (status === "clean") return { cell, reason: null };
  const crashCutoff = cutoffForStatus(cuts, status);
  const crashMag = crashCutoff > 0 ? cpm / crashCutoff : 1;
  const crashMagLabel =
    crashMag >= 3 ? "extreme outlier"
    : crashMag >= 2 ? "deep outlier"
    : crashMag >= 1.5 ? "well above cutoff"
    : "just over cutoff";
  return {
    cell,
    reason: {
      label: "Crashes",
      detail: `${cpm.toFixed(2)} per million miles (${c.crashTotal} crashes on ${c.totalPowerUnits} PU${sevStr}). Above ${bandLabel(status)} cutoff for ${peerGroupLabel[peer]} fleets (${crashCutoff.toFixed(2)})${floorApplied ? "; absolute floor applied" : ""}. ${crashMag.toFixed(2)}× over cutoff (${crashMagLabel}).`,
    },
  };
}

function classifyRevocation(c: FmcsaCarrier): {
  cell: AxisCell;
  reasons: Reason[];
  recent: boolean;
} {
  const reasons: Reason[] = [];
  const sinceLastInvol = daysAgo(c.mostRecentInvoluntaryDate);
  const recent =
    sinceLastInvol !== null && sinceLastInvol <= RECENT_REVOCATION_WINDOW_DAYS;

  let status: AxisStatus = "clean";
  let display = "—";
  const detailParts: string[] = [];

  if (recent) {
    status = "high";
    display = c.mostRecentInvoluntaryDate ?? "Recent";
    detailParts.push(
      `Most recent involuntary revocation: ${c.mostRecentInvoluntaryDate}.`
    );
    reasons.push({
      label: "🚨 Recent revocation",
      detail: `${c.mostRecentInvoluntaryDate} — FMCSA pulled authority within the last 24 months.`,
    });
  } else if (c.revocationsTotal > 0) {
    // Historical revocations only — surface as context (amber/info) without
    // contributing to the carrier's overall risk tier. The "chronic" lifetime
    // check that used to bump these to High has been dropped: a carrier with
    // 6 involuntary revocations from 20 years ago who's been clean since is
    // not a current risk. Brokers see the history in the tooltip.
    status = "info";
    display =
      c.involuntaryRevocations > 0
        ? `${c.involuntaryRevocations}× hist.`
        : `${c.revocationsTotal} hist.`;
    detailParts.push(
      `${c.involuntaryRevocations} involuntary, ${c.revocationsTotal} total revocations on record — none in last 24 months. Surfaced as context, not a flag.`
    );
  }

  return {
    cell: {
      status,
      display,
      detail: detailParts.join(" ") || "No revocation history on file.",
    },
    reasons,
    recent,
  };
}

/**
 * Composite Authority cell — captures three related regulatory facts in one
 * column: status (Active/Inactive), safety rating (S/C/U), and DOT tenure
 * (90-day chameleon-prevention rule). The cell status is the worst of the
 * three; reasons are pushed separately so each Critical fact is documented.
 */
function classifyAuthority(c: FmcsaCarrier): {
  cell: AxisCell;
  reasons: Reason[];
} {
  const reasons: Reason[] = [];
  const parts: string[] = [];
  let worst: AxisStatus = "clean";
  const promote = (s: AxisStatus) => {
    if (statusRank(s) > statusRank(worst)) worst = s;
  };

  // --- Status code ---
  const code = (c.statusCode ?? "").toUpperCase();
  const allowed = (c.allowedToOperate ?? "").toUpperCase();
  if (code === "A" || allowed === "Y") {
    parts.push("Active");
  } else if (code) {
    parts.push(code);
    promote("critical");
    reasons.push({
      label: "🛑 Authority",
      detail: `FMCSA operating authority is not Active (status_code=${code}).`,
    });
  } else {
    parts.push("—");
  }

  // --- Safety rating (FMCSA uses single letters: S/C/U, or null = none) ---
  const rating = (c.safetyRating ?? "").trim().toUpperCase();
  if (rating === "U" || rating === "UNSATISFACTORY") {
    parts.push("Unsat");
    promote("critical");
    reasons.push({
      label: "🛑 Safety rating",
      detail: "FMCSA safety rating: Unsatisfactory.",
    });
  } else if (rating === "C" || rating === "CONDITIONAL") {
    parts.push("Cond");
    promote("critical");
    reasons.push({
      label: "🛑 Safety rating",
      detail: "FMCSA safety rating: Conditional (industry standard is to refuse).",
    });
  } else if (rating === "S" || rating === "SATISFACTORY") {
    // Old "Satisfactory" ratings (>10y, FMCSA's de-facto stale window) aren't
    // a current-state signal — drop from the at-a-glance display so brokers
    // don't read "Sat" as a positive when the rating predates the operator's
    // current safety performance. The full history is still in the tooltip.
    const ratingYears = yearsBetween(
      c.safetyRatingDate,
      new Date().toISOString().slice(0, 10)
    );
    if (ratingYears == null || ratingYears < RATING_AGE_OUT_YEARS) {
      parts.push("Sat");
    }
  }
  // No rating on file → omit from display; common, not a flag

  // --- DOT tenure / new entrant ---
  const days = daysSinceAuthorityIssued(c.dotAddDate);
  if (days != null) {
    if (days < MIN_AUTHORITY_AGE_DAYS) {
      parts.push(`${days}d NEW`);
      promote("critical");
      reasons.push({
        label: "🛑 New authority",
        detail: `DOT issued ${days} days ago (${c.dotAddDate}) — below the ${MIN_AUTHORITY_AGE_DAYS}-day industry tenure floor.`,
      });
    } else if (days < 365) {
      parts.push(`${days}d`);
    } else {
      const y = days / 365;
      parts.push(`${y >= 10 ? y.toFixed(0) : y.toFixed(1)}y`);
    }
  }

  const display = parts.join(" · ");
  const worstStatus: AxisStatus = worst;
  const detail =
    worstStatus !== "clean" && reasons.length > 0
      ? reasons.map((r) => r.detail).join(" ")
      : `${display}. Active authority, no rating issues, established tenure.`;
  return {
    cell: { status: worstStatus, display: display || "—", detail },
    reasons,
  };
}

/** Format an amount in thousands as a human-friendly $X.Xk / $X.XM string. */
function fmtMoney(amountInThousands: number): string {
  if (amountInThousands >= 1000) {
    const m = amountInThousands / 1000;
    // $1M, $1.5M, $4M — drop trailing .0
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `$${amountInThousands}k`;
}

/**
 * Compute the effective BIPD floor for a carrier (in $ thousands), as
 * max(FMCSA-required, industry-norm). Industry norms come from Armstrong's
 * published vetting standard: $1M default, $5M for hazmat, $1.5M for NJ-based.
 */
function effectiveBipdFloorK(c: FmcsaCarrier, hasHazmatLoad: boolean): number {
  let floor = BIPD_FLOOR_DEFAULT_K;
  if (hasHazmatLoad) floor = Math.max(floor, BIPD_FLOOR_HAZMAT_K);
  if ((c.physicalState ?? "").toUpperCase() === "NJ") {
    floor = Math.max(floor, BIPD_FLOOR_NJ_K);
  }
  // FMCSA-required can be higher than industry floor; respect that too.
  return Math.max(floor, c.bipdRequiredAmount);
}

function classifyInsurance(
  c: FmcsaCarrier,
  hasHazmatLoad: boolean
): { cell: AxisCell; reason: Reason | null } {
  const onFile = c.bipdInsuranceOnFile;
  const fmcsaRequired = c.bipdRequiredAmount;
  // BIPD is "n/a" only when FMCSA explicitly doesn't require it AND we don't
  // know enough to apply an industry floor (broker-only or private carrier).
  if (c.bipdInsuranceRequired !== "Y" && fmcsaRequired === 0) {
    return {
      cell: {
        status: "na",
        display: "—",
        detail: "BIPD insurance not flagged as required by FMCSA for this carrier.",
      },
      reason: null,
    };
  }
  const floor = effectiveBipdFloorK(c, hasHazmatLoad);
  // Critical: actual lapse (below FMCSA-required)
  if (onFile === 0) {
    return {
      cell: {
        status: "critical",
        display: "$0",
        detail: `BIPD on file: $0. FMCSA required: ${fmtMoney(fmcsaRequired)}. Industry floor: ${fmtMoney(floor)}.`,
      },
      reason: {
        label: "🛑 Insurance lapsed",
        detail: `$0 BIPD on file vs ${fmtMoney(fmcsaRequired || floor)} required.`,
      },
    };
  }
  if (fmcsaRequired > 0 && onFile < fmcsaRequired) {
    return {
      cell: {
        status: "critical",
        display: fmtMoney(onFile),
        detail: `BIPD on file (${fmtMoney(onFile)}) is below FMCSA-required (${fmtMoney(fmcsaRequired)}).`,
      },
      reason: {
        label: "🛑 Insurance lapsed",
        detail: `${fmtMoney(onFile)} on file vs ${fmtMoney(fmcsaRequired)} FMCSA-required.`,
      },
    };
  }
  // Info (surfaced but does NOT bump overall tier): meets FMCSA but below
  // the higher industry floor. Flagging this as Elevated would put nearly
  // every $750k-BIPD small carrier on the list — too noisy. Surface as
  // context only; the broker can use the info to ask for more coverage
  // direct from the carrier if needed.
  if (onFile < floor) {
    const floorReason = hasHazmatLoad
      ? "hazmat industry floor"
      : (c.physicalState ?? "").toUpperCase() === "NJ"
        ? "NJ-based industry floor"
        : "industry floor";
    return {
      cell: {
        status: "info",
        display: `${fmtMoney(onFile)} ↓`,
        detail: `BIPD on file (${fmtMoney(onFile)}) meets FMCSA-required but is below the ${floorReason} (${fmtMoney(floor)}). Many large brokers won't tender below this floor; surfaced as context.`,
      },
      reason: null,
    };
  }
  return {
    cell: {
      status: "clean",
      display: fmtMoney(onFile),
      detail: `BIPD: ${fmtMoney(onFile)} on file (floor: ${fmtMoney(floor)}).`,
    },
    reason: null,
  };
}

function classifyCargoInsurance(c: FmcsaCarrier): {
  cell: AxisCell;
  reason: Reason | null;
} {
  // FMCSA's Carrier-AllWithHistory bulk file only exposes a Y/N flag for cargo
  // (not the actual amount). So this axis can only answer "is cargo on file
  // with FMCSA?" — useful for compliance check but not for amount-vs-floor.
  if (!c.cargoInsuranceRequired && !c.cargoInsuranceOnFile) {
    return {
      cell: {
        status: "na",
        display: "—",
        detail: "Cargo insurance not flagged as required for this carrier.",
      },
      reason: null,
    };
  }
  if (c.cargoInsuranceRequired && !c.cargoInsuranceOnFile) {
    return {
      cell: {
        status: "elevated",
        display: "Missing",
        detail:
          "FMCSA flags cargo insurance as required for this carrier, but no cargo policy is on file. Many large carriers legitimately self-insure cargo — verify a current COI directly before tendering.",
      },
      reason: {
        label: "⚠ Cargo insurance not on file",
        detail:
          "FMCSA marks cargo as required but no policy on file. Many large carriers self-insure cargo — verify via direct COI before tender.",
      },
    };
  }
  return {
    cell: {
      status: "clean",
      display: "On file",
      detail: c.cargoInsuranceRequired
        ? "Cargo insurance is required by FMCSA and on file."
        : "Cargo insurance is on file (not required by FMCSA).",
    },
    reason: null,
  };
}

/** Compute days since DOT was issued. Null if no add date or future date. */
function daysSinceAuthorityIssued(addDateIso: string | null): number | null {
  if (!addDateIso) return null;
  const d = Date.parse(addDateIso);
  if (Number.isNaN(d)) return null;
  const diffMs = Date.now() - d;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

function classifyAuthorityAge(c: FmcsaCarrier): {
  cell: AxisCell;
  reason: Reason | null;
} {
  const days = daysSinceAuthorityIssued(c.dotAddDate);
  if (days == null) {
    return {
      cell: {
        status: "na",
        display: "—",
        detail: "DOT issue date not on file.",
      },
      reason: null,
    };
  }
  const years = days / 365;
  const display =
    years >= 1
      ? `${years.toFixed(years >= 10 ? 0 : 1)}y`
      : `${days}d`;
  if (days < MIN_AUTHORITY_AGE_DAYS) {
    return {
      cell: {
        status: "critical",
        display,
        detail: `DOT issued ${days} days ago — below the ${MIN_AUTHORITY_AGE_DAYS}-day industry tenure rule (chameleon-prevention).`,
      },
      reason: {
        label: "🛑 New authority",
        detail: `DOT issued ${days} days ago (${c.dotAddDate}) — below the ${MIN_AUTHORITY_AGE_DAYS}-day industry tenure minimum.`,
      },
    };
  }
  return {
    cell: {
      status: "clean",
      display,
      detail: `DOT issued ${c.dotAddDate} — ${days} days old (${years.toFixed(1)} years).`,
    },
    reason: null,
  };
}

function classifyEnforcement(c: FmcsaCarrier): {
  cell: AxisCell;
  reason: Reason | null;
  hit: boolean;
  large: boolean;
} {
  const since = daysAgo(c.enforcementRecentDate);
  const recent =
    since !== null &&
    since <= RECENT_ENFORCEMENT_WINDOW_DAYS &&
    c.enforcementCasesCount >= 1;
  if (!recent) {
    return {
      cell: {
        status: "clean",
        display: "—",
        detail: "No recent enforcement case (≤ 24 months).",
      },
      reason: null,
      hit: false,
      large: false,
    };
  }
  const large = c.enforcementTotalSettled >= ENFORCEMENT_LARGE_SETTLEMENT;
  return {
    cell: {
      status: large ? "high" : "elevated",
      display: `$${(c.enforcementTotalSettled / 1000).toFixed(0)}k`,
      detail: `${c.enforcementCasesCount} closed case(s), $${c.enforcementTotalSettled.toLocaleString()} settled (latest ${c.enforcementRecentDate}).`,
    },
    reason: {
      label: "⚖ Recent enforcement",
      detail: `${c.enforcementCasesCount} closed case(s), $${c.enforcementTotalSettled.toLocaleString()} settled (latest ${c.enforcementRecentDate}).`,
    },
    hit: true,
    large,
  };
}

// ---------- main analyzer ----------

/**
 * Statistical-axis severity rank — higher value = more directly maps to harm.
 * Used for in-tier sorting so the "drivers crashing" carriers surface above
 * the "carrier with paperwork problems" carriers within the same risk tier.
 */
const AXIS_RANK = {
  crash: 6,
  driverOos: 5,
  hos: 4,
  unsafeDriving: 3,
  vehicleOos: 2,
  hazmatOos: 1,
} as const;

function scoreCarrier(
  c: FmcsaCarrier,
  loadInfo: { loadIds: Set<string>; hazmatLoadIds: Set<string> }
): CarrierRow {
  const peer = peerGroupForPU(c.totalPowerUnits);

  const crash = classifyCrash(c, peer);
  const unsafeDriving = classifyOos(
    "unsafeDriving",
    c.unsafeDrivingViolations,
    c.driverInsp,
    peer,
    "Unsafe Driving"
  );
  const hos = classifyOos(
    "hos",
    c.hosViolations,
    c.driverInsp,
    peer,
    "HOS Compliance"
  );
  const driver = classifyOos(
    "driverOos",
    c.driverOosInsp,
    c.driverInsp,
    peer,
    "Driver OOS"
  );
  const vehicle = classifyOos(
    "vehicleOos",
    c.vehicleOosInsp,
    c.vehicleInsp,
    peer,
    "Vehicle OOS"
  );
  const hazmat = classifyOos(
    "hazmatOos",
    c.hazmatOosInsp,
    c.hazmatInsp,
    peer,
    "Hazmat OOS"
  );
  const revocation = classifyRevocation(c);
  const authority = classifyAuthority(c);
  const hasHazmatLoad = loadInfo.hazmatLoadIds.size > 0;
  // BIPD only — we pulled cargo from the scorecard because FMCSA's cargo-on-
  // file flag is too noisy (most carriers self-insure or file cargo via COI
  // direct with the broker, not in FMCSA's bulk file).
  const insurance = classifyInsurance(c, hasHazmatLoad);
  const enforcement = classifyEnforcement(c);

  // ---- Post-classification enrichments (display-only) ----
  // FMCSA's own BASIC measure + alert flag, alongside our peer-group call.
  // When FMCSA agrees, the tooltip says so — when they disagree we still flag
  // (we're more sensitive than FMCSA's intervention threshold by design), but
  // the broker can see both perspectives.
  enrichAxisDetailWithFmcsa(unsafeDriving.cell, c.unsafeDrivingMeasure, c.unsafeDrivingAlert, "unsafeDriving");
  enrichAxisDetailWithFmcsa(hos.cell, c.hosMeasure, c.hosAlert, "hos");
  enrichAxisDetailWithFmcsa(vehicle.cell, c.vehicleMaintenanceMeasure, c.vehicleMaintenanceAlert, "vehicleMaintenance");
  // Driver OOS and Driver Fitness aren't 1:1 mapped, but our driverOos axis is
  // the closest broker-facing analog of FMCSA's Driver Fitness BASIC, so we
  // surface that measure here as the most-relevant FMCSA cross-reference.
  enrichAxisDetailWithFmcsa(driver.cell, c.driverFitnessMeasure, c.driverFitnessAlert, "driverFitness");

  // MCS-150 staleness — if the form is >24mo old, our crashes-per-million-miles
  // denominator is built from a stale mileage report. Surface in the crash
  // cell so the broker knows when cpm is unreliable.
  const mcs150AgeDays = c.mcs150Date == null ? null : daysAgo(c.mcs150Date);
  if (mcs150AgeDays != null && mcs150AgeDays > MCS150_STALE_DAYS && crash.cell.status !== "na") {
    const months = Math.round(mcs150AgeDays / 30);
    crash.cell.detail = `${crash.cell.detail ?? ""}\nMCS-150 filed ${months} months ago — cpm denominator is stale, treat with caution.`;
  }
  // FMCSA's own recordable crash rate, when published (~1% of carriers).
  if (c.recordableCrashRate != null && c.recordableCrashRate > 0 && crash.cell.status !== "na") {
    crash.cell.detail = `${crash.cell.detail ?? ""}\nFMCSA recordable crash rate: ${c.recordableCrashRate.toFixed(2)}.`;
  }

  // Old satisfactory rating age-out — surface as info-tier context. Doesn't
  // downgrade an already-flagged Conditional/Unsat status.
  const ratingYears = yearsBetween(c.safetyRatingDate, new Date().toISOString().slice(0, 10));
  if (
    ratingYears != null &&
    ratingYears >= RATING_AGE_OUT_YEARS &&
    (c.safetyRating === "S" || c.safetyRating === "SATISFACTORY") &&
    authority.cell.status === "clean"
  ) {
    authority.cell.status = "info";
    authority.cell.detail = `${authority.cell.detail ?? ""}\nSatisfactory rating is ${ratingYears.toFixed(0)} years old (${c.safetyRatingDate}) — not a current-state signal.`;
  }
  // Review date (note: this is the rating-context review, not most-recent).
  if (c.reviewDate && c.reviewType) {
    authority.cell.detail = `${authority.cell.detail ?? ""}\nRating-context review: ${c.reviewDate} (type=${c.reviewType}).`;
  }
  // Fleet-size plausibility heuristic from add_plausibility.py.
  if (c.fleetSizeFlag === "low-activity") {
    authority.cell.detail = `${authority.cell.detail ?? ""}\nFleet plausibility: low-activity (${c.inspectionsPerPu?.toFixed(2) ?? "?"} inspections per PU over 24mo — reported power-units may be inflated).`;
  }

  // Insurance enrichments: insurer identity + policy lifecycle + cancellation
  // history (chameleon signal). Detail-only — escalation handled below.
  if (c.bipdInsurerName) {
    insurance.cell.detail = `${insurance.cell.detail ?? ""}\nBIPD insurer: ${c.bipdInsurerName}${c.bipdPolicyEffectiveDate ? ` (effective ${c.bipdPolicyEffectiveDate})` : ""}.`;
  }
  if (c.cargoInsurerName) {
    insurance.cell.detail = `${insurance.cell.detail ?? ""}\nCargo insurer: ${c.cargoInsurerName}.`;
  }
  if (c.insuranceCancellations24mo > 0) {
    insurance.cell.detail = `${insurance.cell.detail ?? ""}\n${c.insuranceCancellations24mo} insurance cancellation(s) in last 24mo${c.mostRecentCancelDate ? ` (most recent policy event ${c.mostRecentCancelDate}, ${c.mostRecentCancelReason ?? "unspecified"})` : ""}.`;
  }

  // ---- Post-classification escalations (status overrides) ----

  // A1. FMCSA's prior-revoke flag.
  //
  // Self-revoke (prior_revoke_dot_number === this DOT) is dropped entirely
  // — the analyzer focuses on the last 24 months, and a self-revoke without
  // corroborating data in the current Revocation file is by definition an
  // aged-out event (could be 10+ years old). Carriers with current revocation
  // activity are handled by the existing classifyRevocation logic.
  //
  // True chameleon (prior_revoke_dot_number !== this DOT) stays Critical —
  // successor relationships are identity-based and don't expire. Even an
  // old successor relationship is a signal that this DOT was re-incorporated
  // to escape a prior carrier's safety history.
  if (
    c.priorRevokeFlag &&
    c.priorRevokeDotNumber != null &&
    c.priorRevokeDotNumber !== c.dotNumber
  ) {
    revocation.cell.status = "critical";
    const detail = `FMCSA flags this DOT as a re-incarnation of a previously-revoked predecessor (prior DOT: ${c.priorRevokeDotNumber}).`;
    revocation.cell.detail = revocation.cell.detail
      ? `${revocation.cell.detail}\n${detail}`
      : detail;
    revocation.reasons.push({ label: "🛑 FMCSA prior-revoke flag (chameleon)", detail });
  }

  // A2. Rapid cancel+replace insurance pattern is a chameleon signal ONLY
  // when paired with ≥3 true cancellations in 24 months. A single cancel +
  // replace within 30 days is the normal pattern for routine insurer
  // renewals — flagging on that alone produces too many false positives
  // (verified against production carriers). The combined pattern (rapid
  // replace AND repeated cancellations) is the actual re-incarnation move.
  if (c.rapidReplaceFlag && c.insuranceCancellations24mo >= 3) {
    insurance.cell.status = "critical";
    const detail = `Insurance policy cancelled and replaced within ~30 days, alongside ${c.insuranceCancellations24mo} true cancellations in 24 months — re-incarnation pattern.`;
    insurance.cell.detail = insurance.cell.detail ? `${insurance.cell.detail}\n${detail}` : detail;
    insurance.reason = { label: "🛑 Rapid replace + cancellation history", detail };
  } else if (c.rapidReplaceFlag) {
    // Surface as info-only context — broker can see "they swapped insurers
    // recently" without it driving the tier.
    if (insurance.cell.status === "clean") {
      insurance.cell.status = "info";
    }
    const detail =
      "Insurance cancelled and replaced within ~30 days — likely a routine broker switch, surfaced for context.";
    insurance.cell.detail = insurance.cell.detail ? `${insurance.cell.detail}\n${detail}` : detail;
  }
  // A3. Insurance cancellation churn, graduated by national-population rarity:
  //   ≥7 cancellations in 24mo (P99 — top 1%) → Severe
  //   ≥3 cancellations in 24mo (P95 — top 5%) → Elevated
  // Skipped when rapid_replace_flag already fired (A2 sets a stronger tier
  // with the same evidence).
  if (!c.rapidReplaceFlag) {
    if (c.insuranceCancellations24mo >= 7) {
      if (statusRank(insurance.cell.status) < statusRank("severe")) {
        insurance.cell.status = "severe";
      }
      if (!insurance.reason) {
        insurance.reason = {
          label: "🛑 Severe insurance churn",
          detail: `${c.insuranceCancellations24mo} true insurance cancellations in last 24 months — top 1% of carriers nationally. Carrier is on the edge of insurer dropout.`,
        };
      }
    } else if (c.insuranceCancellations24mo >= 3) {
      if (statusRank(insurance.cell.status) < statusRank("elevated")) {
        insurance.cell.status = "elevated";
      }
      if (!insurance.reason) {
        insurance.reason = {
          label: "⚠ Insurance churn",
          detail: `${c.insuranceCancellations24mo} true insurance cancellations in last 24 months — top 5% nationally. Verify carrier is on a stable policy before tendering.`,
        };
      }
    }
  }

  // Collect reasons (for tooltip/expand)
  const reasons: Reason[] = [];
  if (insurance.reason) reasons.push(insurance.reason);
  reasons.push(...authority.reasons);
  if (crash.reason) reasons.push(crash.reason);
  if (unsafeDriving.reason) reasons.push(unsafeDriving.reason);
  if (hos.reason) reasons.push(hos.reason);
  if (driver.reason) reasons.push(driver.reason);
  if (vehicle.reason) reasons.push(vehicle.reason);
  if (hazmat.reason) reasons.push(hazmat.reason);
  reasons.push(...revocation.reasons);
  if (enforcement.reason) reasons.push(enforcement.reason);

  // Compute overall risk tier
  // Start with the worst per-axis status
  const cellStatuses: AxisStatus[] = [
    crash.cell.status,
    unsafeDriving.cell.status,
    hos.cell.status,
    driver.cell.status,
    vehicle.cell.status,
    hazmat.cell.status,
    revocation.cell.status,
    authority.cell.status,
    insurance.cell.status,
  ];
  let worst: AxisStatus = "clean";
  for (const s of cellStatuses) {
    if (statusRank(s) > statusRank(worst)) worst = s;
  }
  let level: RiskLevel | "Clean" = statusToRiskLevel(worst);

  // Bumps for compound signals
  const hasStatisticalSignal =
    (crash.cell.status !== "clean" && crash.cell.status !== "na") ||
    (unsafeDriving.cell.status !== "clean" && unsafeDriving.cell.status !== "na") ||
    (hos.cell.status !== "clean" && hos.cell.status !== "na") ||
    (driver.cell.status !== "clean" && driver.cell.status !== "na") ||
    (vehicle.cell.status !== "clean" && vehicle.cell.status !== "na") ||
    (hazmat.cell.status !== "clean" && hazmat.cell.status !== "na");
  if (revocation.recent && hasStatisticalSignal) {
    // Recent revocation + any statistical signal → Severe
    if (level !== "Critical") level = "Severe";
  }
  // (Chronic lifetime-count bump removed — see classifyRevocation. Carriers
  // are flagged only on actual activity in the last 24 months.)

  // D10. Chameleon-pattern cluster — if 2+ independent chameleon signals fire,
  // escalate row tier to Severe minimum. Any single signal on its own is
  // already handled by its axis cell (prior_revoke → critical revocation,
  // rapid_replace → critical insurance, etc.) — this is the *combined* signal.
  const chameleonSignals: string[] = [];
  // Only count prior-revoke as a chameleon signal when it points to a
  // DIFFERENT DOT (true successor relationship). Self-revoke is a separate
  // pattern (carrier had its own authority pulled then reinstated).
  if (
    c.priorRevokeFlag &&
    c.priorRevokeDotNumber != null &&
    c.priorRevokeDotNumber !== c.dotNumber
  ) {
    chameleonSignals.push(`FMCSA prior-revoke flag (prior DOT ${c.priorRevokeDotNumber})`);
  }
  if (c.rapidReplaceFlag) {
    chameleonSignals.push("Insurance cancel+replace within 30 days");
  }
  if (c.insuranceCancellations24mo >= 2) {
    chameleonSignals.push(`${c.insuranceCancellations24mo} insurance cancellations in 24mo`);
  }
  const authAgeDays = daysSinceAuthorityIssued(c.dotAddDate);
  const isNewAuth = authAgeDays != null && authAgeDays < MIN_AUTHORITY_AGE_DAYS;
  const lowActivity = c.fleetSizeFlag === "low-activity" || c.fleetSizeFlag === "tiny";
  if (isNewAuth && lowActivity) {
    chameleonSignals.push(`New authority (${authAgeDays}d) + ${c.fleetSizeFlag} fleet`);
  }
  // D10b. Chameleon address-cluster — N other OOS DOTs share this carrier's
  // physical address. Rule definition + thresholds documented in
  // lib/rules/index.ts > chameleon-address-cluster; we pull the label and
  // threshold-detail strings from the registry so the website and email
  // can't drift in wording.
  {
    const addrRule = getRule("chameleon-address-cluster");
    const oos = c.addressDupeOosCount;
    const active = c.addressDupeActiveCount;
    let addrTier: "critical" | "high" | "caution" | null = null;
    if (oos >= 10) addrTier = "critical";
    else if (oos >= 5) addrTier = "high";
    else if (oos >= 3) addrTier = "caution";

    if (addrTier) {
      const siblingsClause = active > 0
        ? ` Also ${active} other active DOT${active === 1 ? "" : "s"} at this address.`
        : "";
      const detail =
        `${oos} out-of-service DOT${oos === 1 ? "" : "s"} share this carrier's ` +
        `physical address on FMCSA.${siblingsClause} ` +
        `${addrRule.thresholds[addrTier]} ` +
        `Common chameleon-carrier pattern; verify the operating address out-of-band before tendering.`;
      const glyph =
        addrTier === "critical" ? "🛑"
        : addrTier === "high" ? "⚠"
        : "⚡";
      reasons.push({ label: `${glyph} ${addrRule.label}`, detail });
      // Contribute to the multi-signal chameleon-cluster escalator below.
      chameleonSignals.push(`${oos} OOS DOTs at same address`);
      // Direct level escalation: critical-tier address cluster floors the
      // carrier at Severe minimum (preserves Critical); high-tier floors at
      // High; caution alone doesn't escalate level (it just appears as a
      // reason on the carrier audit row).
      if (addrTier === "critical" && level !== "Critical") {
        level = "Severe";
      } else if (addrTier === "high" && level !== "Critical" && level !== "Severe") {
        level = "High";
      }
    }
  }

  if (chameleonSignals.length >= CHAMELEON_CLUSTER_THRESHOLD) {
    // Escalate to Severe minimum (preserve Critical if already there).
    if (level !== "Critical" && level !== "Severe") {
      level = "Severe";
    }
    reasons.push({
      label: "🚨 Chameleon-pattern cluster",
      detail: `${chameleonSignals.length} independent re-incarnation signals: ${chameleonSignals.join("; ")}.`,
    });
  }
  if (enforcement.hit) {
    if (enforcement.large) {
      // Large settlement floor at High
      if (level !== "Critical" && level !== "Severe") level = "High";
    } else if (level !== "Critical" && level !== "Clean") {
      // Bump existing tier up one for non-large enforcement
      level = bumpUp(level);
    }
  }

  // Compute sort metadata: which statistical axis fired worst, and how badly.
  // Maps each axis cell's observed value to its peer-group P95 cutoff to get
  // a magnitude ratio. Axis-rank tiebreaker uses AXIS_RANK above.
  type StatAxisEntry = {
    key: keyof typeof AXIS_RANK;
    cell: AxisCell;
    observed: number;
    cutoffKey: AxisKey;
  };
  const statAxes: StatAxisEntry[] = [
    {
      key: "crash",
      cell: crash.cell,
      observed: c.crashesPerMillionMiles ?? 0,
      cutoffKey: "crashesPerMillionMiles",
    },
    {
      key: "driverOos",
      cell: driver.cell,
      observed: c.driverInsp > 0 ? c.driverOosInsp / c.driverInsp : 0,
      cutoffKey: "driverOos",
    },
    {
      key: "hos",
      cell: hos.cell,
      observed: c.driverInsp > 0 ? c.hosViolations / c.driverInsp : 0,
      cutoffKey: "hos",
    },
    {
      key: "unsafeDriving",
      cell: unsafeDriving.cell,
      observed:
        c.driverInsp > 0 ? c.unsafeDrivingViolations / c.driverInsp : 0,
      cutoffKey: "unsafeDriving",
    },
    {
      key: "vehicleOos",
      cell: vehicle.cell,
      observed: c.vehicleInsp > 0 ? c.vehicleOosInsp / c.vehicleInsp : 0,
      cutoffKey: "vehicleOos",
    },
    {
      key: "hazmatOos",
      cell: hazmat.cell,
      observed: c.hazmatInsp > 0 ? c.hazmatOosInsp / c.hazmatInsp : 0,
      cutoffKey: "hazmatOos",
    },
  ];
  let worstAxisRank = 0;
  let worstAxisMagnitude = 0;
  let hasStatSignal = false;
  for (const a of statAxes) {
    const s = a.cell.status;
    if (s === "elevated" || s === "high" || s === "severe" || s === "critical") {
      hasStatSignal = true;
      const r = AXIS_RANK[a.key];
      const cutoffs = getCutoffs(a.cutoffKey, peer);
      // Compare against P95 — anything past that is exceptional, so the
      // magnitude is a real "how many times beyond catastrophic"
      const mag = cutoffs.p95 > 0 ? a.observed / cutoffs.p95 : 0;
      if (r > worstAxisRank) {
        worstAxisRank = r;
        worstAxisMagnitude = mag;
      } else if (r === worstAxisRank && mag > worstAxisMagnitude) {
        worstAxisMagnitude = mag;
      }
    }
  }

  return {
    rank: 0, // assigned after sort
    dot: c.dotNumber ?? 0,
    carrierName: c.legalName,
    peerGroup: peer,
    peerGroupLabel: peerGroupLabel[peer],
    powerUnits: c.totalPowerUnits,
    loadCount: loadInfo.loadIds.size,
    loadIds: Array.from(loadInfo.loadIds).sort(),
    hazmatLoadIds: Array.from(loadInfo.hazmatLoadIds).sort(),
    hasFatalCrash: c.fatalCrash > 0,
    riskLevel: level,
    axes: {
      crash: crash.cell,
      unsafeDriving: unsafeDriving.cell,
      hos: hos.cell,
      driverOos: driver.cell,
      vehicleOos: vehicle.cell,
      hazmatOos: hazmat.cell,
      revocations: revocation.cell,
      authority: authority.cell,
      insurance: insurance.cell,
    },
    reasons,
    sortMeta: { hasStatSignal, worstAxisRank, worstAxisMagnitude },
  };
}

export function analyze(
  loads: LoadInput[],
  carriers: Map<number, FmcsaCarrier>
): AuditResult {
  const byCarrier = new Map<
    number,
    { loadIds: Set<string>; hazmatLoadIds: Set<string> }
  >();
  for (let i = 0; i < loads.length; i++) {
    const load = loads[i];
    const id = load.loadId ?? `row-${i + 1}`;
    const g = byCarrier.get(load.dot) ?? {
      loadIds: new Set(),
      hazmatLoadIds: new Set(),
    };
    g.loadIds.add(id);
    if (load.isHazmat) g.hazmatLoadIds.add(id);
    byCarrier.set(load.dot, g);
  }

  const unresolvedDots: number[] = [];
  const rows: CarrierRow[] = [];
  for (const [dot, g] of byCarrier) {
    const c = carriers.get(dot);
    if (!c) {
      unresolvedDots.push(dot);
      continue;
    }
    rows.push(scoreCarrier(c, g));
  }

  const SORT_ORDER: Array<RiskLevel | "Clean"> = [
    "Critical",
    "Severe",
    "High",
    "Elevated",
    "Clean",
  ];
  // Sort: tier first, then within tier put statistical-signal carriers
  // (drivers/trucks doing dangerous things on the road) above pattern-only
  // carriers (regulatory/admin history). Within statistical-signal: rank by
  // worst axis severity, then by magnitude (how far above P95 cutoff).
  rows.sort((a, b) => {
    const td =
      SORT_ORDER.indexOf(a.riskLevel) - SORT_ORDER.indexOf(b.riskLevel);
    if (td !== 0) return td;
    // Statistical-signal carriers first
    if (a.sortMeta.hasStatSignal !== b.sortMeta.hasStatSignal) {
      return a.sortMeta.hasStatSignal ? -1 : 1;
    }
    // Among statistical-signal carriers, higher axis rank first
    const ar = b.sortMeta.worstAxisRank - a.sortMeta.worstAxisRank;
    if (ar !== 0) return ar;
    // Same axis rank — higher magnitude first
    const am = b.sortMeta.worstAxisMagnitude - a.sortMeta.worstAxisMagnitude;
    if (am !== 0) return am;
    // Fall back to load count desc
    return b.loadCount - a.loadCount;
  });
  rows.forEach((r, i) => (r.rank = i + 1));

  const bySeverity: Record<RiskLevel, number> = {
    Critical: 0,
    Severe: 0,
    High: 0,
    Elevated: 0,
  };
  for (const r of rows) {
    if (r.riskLevel !== "Clean") bySeverity[r.riskLevel] += 1;
  }
  const flaggedCarriers = rows.filter((r) => r.riskLevel !== "Clean").length;

  return {
    totalLoads: loads.length,
    totalCarriers: byCarrier.size,
    flaggedCarriers,
    bySeverity,
    rows,
    thresholdsUsed: nationalThresholds,
    unresolvedDots,
  };
}

/**
 * Parse pasted input. One load per line. Tolerates:
 *   3621624
 *   3621624, INF31459-18990
 *   3621624 INF31459-18990 HAZMAT
 */
export function parseInput(raw: string): { loads: LoadInput[]; errors: string[] } {
  const loads: LoadInput[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#")) continue;
    const tokens = line.split(/[,\s\t]+/).map((t) => t.trim()).filter(Boolean);
    if (!tokens.length) continue;
    const dotStr = tokens[0].replace(/^DOT[:#]?/i, "").replace(/\D/g, "");
    const dot = parseInt(dotStr, 10);
    if (!Number.isFinite(dot) || dot <= 0) {
      errors.push(`Line ${i + 1}: could not parse a DOT number from "${line}"`);
      continue;
    }
    let loadId: string | undefined;
    let isHazmat = false;
    for (let j = 1; j < tokens.length; j++) {
      const t = tokens[j];
      if (/^hazmat$/i.test(t)) isHazmat = true;
      else if (!loadId) loadId = t;
    }
    loads.push({ dot, loadId, isHazmat });
  }
  return { loads, errors };
}
