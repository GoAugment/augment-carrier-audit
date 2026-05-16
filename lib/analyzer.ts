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
  if (value >= cuts.p95) return "severe";
  if (value >= cuts.p90) return "high";
  if (value >= cuts.p85) return "elevated";
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
  return {
    cell,
    reason: {
      label: axisLabel,
      detail: `${pctStr} — ${oosCount} of ${inspections} inspections. Above ${bandLabel(status)} cutoff for ${peerGroupLabel[peer]} fleets (${(cutoffForStatus(cuts, status) * 100).toFixed(0)}%).`,
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
  return {
    cell,
    reason: {
      label: "Crashes",
      detail: `${cpm.toFixed(2)} per million miles (${c.crashTotal} crashes on ${c.totalPowerUnits} PU${sevStr}). Above ${bandLabel(status)} cutoff for ${peerGroupLabel[peer]} fleets (${cutoffForStatus(cuts, status).toFixed(2)})${floorApplied ? "; absolute floor applied" : ""}.`,
    },
  };
}

function classifyRevocation(c: FmcsaCarrier): {
  cell: AxisCell;
  reasons: Reason[];
  recent: boolean;
  chronic: boolean;
} {
  const reasons: Reason[] = [];
  const sinceLastInvol = daysAgo(c.mostRecentInvoluntaryDate);
  const recent =
    sinceLastInvol !== null && sinceLastInvol <= RECENT_REVOCATION_WINDOW_DAYS;
  const chronic = c.involuntaryRevocations >= CHRONIC_REVOCATION_THRESHOLD;

  let status: AxisStatus = "clean";
  let display = "—";
  const detailParts: string[] = [];

  if (recent) {
    status = "high"; // recent alone = High; combine logic upgrades if needed
    display = c.mostRecentInvoluntaryDate ?? "Recent";
    detailParts.push(
      `Most recent involuntary revocation: ${c.mostRecentInvoluntaryDate}.`
    );
    reasons.push({
      label: "🚨 Recent revocation",
      detail: `${c.mostRecentInvoluntaryDate} — FMCSA pulled authority within the last 24 months.`,
    });
  }
  if (chronic) {
    // chronic alone is also High; if also recent, escalate to Severe below
    if (statusRank(status) < statusRank("high")) status = "high";
    if (recent) status = "severe";
    if (!recent) display = `${c.involuntaryRevocations}× involuntary`;
    detailParts.push(
      `${c.involuntaryRevocations} involuntary revocations on record (total ${c.revocationsTotal}).`
    );
    reasons.push({
      label: "⚠ Chronic revocations",
      detail: `${c.involuntaryRevocations} involuntary revocations on record (total ${c.revocationsTotal}).`,
    });
  }
  if (!recent && !chronic && c.revocationsTotal > 0) {
    // Historical revocations only — surface as context (amber) without
    // contributing to the carrier's overall risk tier.
    status = "info";
    display = `${c.revocationsTotal} historical`;
    detailParts.push(
      `${c.revocationsTotal} revocations on record, none recent (≤24mo) or chronic (≥3). Surfaced as context — not a flag.`
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
    chronic,
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
    parts.push("Sat");
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
  // Elevated: meets FMCSA but below the higher industry floor (broker-norm).
  if (onFile < floor) {
    const floorReason = hasHazmatLoad
      ? "hazmat industry floor"
      : (c.physicalState ?? "").toUpperCase() === "NJ"
        ? "NJ-based industry floor"
        : "industry floor";
    return {
      cell: {
        status: "elevated",
        display: `${fmtMoney(onFile)} ↓`,
        detail: `BIPD on file (${fmtMoney(onFile)}) meets FMCSA-required but is below the ${floorReason} (${fmtMoney(floor)}). Many large brokers won't tender below this floor.`,
      },
      reason: {
        label: "⚠ Insurance below industry floor",
        detail: `${fmtMoney(onFile)} BIPD on file vs ${fmtMoney(floor)} broker-standard ${floorReason} (carrier still meets FMCSA's ${fmtMoney(fmcsaRequired)} minimum).`,
      },
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
  const onFile = c.cargoInsuranceOnFile;
  // If cargo isn't required AND nothing's on file, treat as n/a (some
  // carriers don't haul cargo subject to FMCSA cargo-coverage rules).
  if (!c.cargoInsuranceRequired && onFile === 0) {
    return {
      cell: {
        status: "na",
        display: "—",
        detail: "Cargo insurance not on file (not flagged as required by FMCSA).",
      },
      reason: null,
    };
  }
  if (onFile === 0) {
    return {
      cell: {
        status: "elevated",
        display: "$0 ↓",
        detail: `Cargo insurance: $0 on file. Industry floor is ${fmtMoney(CARGO_FLOOR_K)} but many large carriers self-insure cargo — verify a current COI directly with the carrier before tendering.`,
      },
      reason: {
        label: "⚠ Cargo insurance missing on file",
        detail: `$0 cargo on file (industry floor ${fmtMoney(CARGO_FLOOR_K)}). Many large carriers self-insure cargo — verify via direct COI before tender.`,
      },
    };
  }
  if (onFile < CARGO_FLOOR_K) {
    return {
      cell: {
        status: "elevated",
        display: `${fmtMoney(onFile)} ↓`,
        detail: `Cargo insurance (${fmtMoney(onFile)}) is below the ${fmtMoney(CARGO_FLOOR_K)} industry floor.`,
      },
      reason: {
        label: "⚠ Cargo insurance below industry floor",
        detail: `${fmtMoney(onFile)} cargo on file vs ${fmtMoney(CARGO_FLOOR_K)} broker-standard industry floor.`,
      },
    };
  }
  return {
    cell: {
      status: "clean",
      display: fmtMoney(onFile),
      detail: `Cargo: ${fmtMoney(onFile)} on file.`,
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
  const bipd = classifyInsurance(c, hasHazmatLoad);
  const cargo = classifyCargoInsurance(c);
  // Combine BIPD + cargo into a single insurance cell so the scorecard
  // doesn't balloon to 12 columns. Worst status wins; display shows both.
  const insurance: { cell: AxisCell; reason: Reason | null } = (() => {
    const status = statusRank(bipd.cell.status) >= statusRank(cargo.cell.status)
      ? bipd.cell.status
      : cargo.cell.status;
    const displayParts: string[] = [];
    if (bipd.cell.status !== "na") displayParts.push(bipd.cell.display);
    if (cargo.cell.status !== "na") displayParts.push(cargo.cell.display);
    const display = displayParts.length ? displayParts.join(" / ") : "—";
    const detail = [bipd.cell.detail, cargo.cell.detail].filter(Boolean).join(" ");
    return { cell: { status, display, detail }, reason: null };
  })();
  const enforcement = classifyEnforcement(c);

  // Collect reasons (for tooltip/expand)
  const reasons: Reason[] = [];
  if (bipd.reason) reasons.push(bipd.reason);
  if (cargo.reason) reasons.push(cargo.reason);
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
  if (revocation.chronic && level !== "Critical") {
    level = bumpUp(level);
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
