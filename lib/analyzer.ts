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
import insurerRisk from "./data/insurer-risk.json";
import zipRiskData from "./data/zip-risk.json";

/** Empirical insurer-reputation lookup (built by build_insurer_risk.py): an
 *  insurer's BIPD-portfolio involuntary-revocation rate vs the national base.
 *  "Specialty"/RRG surplus-lines insurers write the carriers standard insurers
 *  won't and their books revoke 3-5x more — a leading signal known at booking. */
function lookupInsurerRisk(name: string | null): { tier: string; lift: number } | null {
  if (!name) return null;
  const e = (insurerRisk.insurers as Record<string, { tier: string; lift: number }>)[
    name.toUpperCase().trim()
  ];
  return e ?? null;
}

/** Empirical ZIP-reputation lookup (built by build_zip_risk.py): a physical-
 *  address ZIP's carrier shutdown rate (revoked/OOS ÷ total) vs the national
 *  base. Independently reproduces the new-authority-surge hotspots. Soft marker
 *  — these are also legit freight hubs, so it's lightly weighted and gated to
 *  never flag alone. Keyed by the first 5 digits of the ZIP. */
function lookupZipRisk(zip: string | null): { tier: string; lift: number } | null {
  if (!zip) return null;
  const z = zip.match(/\d{5}/)?.[0];
  if (!z) return null;
  const e = (zipRiskData.zips as Record<string, { tier: string; lift: number }>)[z];
  return e ?? null;
}
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

// Four-tier carrier verdict. "Low" is the clean baseline (nothing flagged);
// Medium/High/Critical are the escalating flagged tiers. Critical absorbs what
// used to be a separate "Severe" tier — a below-minimum/lapsed/revoked/fraud
// carrier and a multi-signal chameleon are both "do not tender."
export type RiskLevel = "Critical" | "High" | "Medium" | "Low";
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

const TIER_ORDER: RiskLevel[] = ["Critical", "High", "Medium", "Low"];
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

export type RiskFactorCategory =
  | "Authority / insurance"
  | "Identity / chameleon"
  | "Operations"
  | "Safety / compliance"
  | "Context";

export type RiskFactorKind = "core" | "context";

export interface RiskFactorContribution {
  category: RiskFactorCategory;
  label: string;
  points: number;
  detail: string;
  /** Core factors are allowed to unlock weak corroborators like free email. */
  kind: RiskFactorKind;
}

export interface CarrierIdentityRiskSignals {
  freeEmailDomain: string | null;
  residentialAddressMarker: string | null;
  shutdownIdentityLinks: string[];
}

/** One cell in the scorecard — covers one axis for one carrier. */
export interface AxisCell {
  status: AxisStatus;
  /** Compact value to render in the cell (e.g. "43%", "1.19", "—"). */
  display: string;
  /** Optional small secondary line under `display` (e.g. the absolute rate
   *  anchoring a percentile headline). */
  sub?: string;
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
  /** Overall risk tier. "Low" is the clean baseline (no axis flagged). */
  riskLevel: RiskLevel;
  /** Estimated FMCSA ISS-CSA score (1-100) + tier ("Inspect"/"Optional"/"Pass")
   *  + group label. Context only (not a tier driver). Null if unscored. */
  issScore: number | null;
  issTier: string | null;
  issGroup: string | null;
  /** Augie Safety Score (0-100, higher=worse) — peer-fair crash-risk roll-up of
   *  the BASIC percentiles. Companion to ISS (fixes ISS's small-carrier blind
   *  spot). + tier (High/Moderate/Low). Null if data-insufficient. */
  safetyScore: number | null;
  safetyTier: string | null;
  /** Carrier Risk Score (0-100, higher=worse) — transparent additive score across
   *  authority/insurance, identity/chameleon, operations, safety/compliance, and
   *  contextual corroborators. It is a heuristic index, not a probability. */
  riskScore: number;
  riskTier: string;
  riskFactors: string[];
  riskContributions: RiskFactorContribution[];
  /** Top named shared-fleet sibling (the single largest cross-DOT VIN-overlap
   *  partner), surfaced when the chameleon-shared-fleet reason fires. `siblingTier`
   *  is its own Augie verdict — filled in by the API route via a second scoring
   *  pass so the broker can see at a glance whether the linked authority is itself
   *  Critical/High. All three null when no concentrated sibling was named. */
  siblingDot: number | null;
  siblingName: string | null;
  siblingTier: RiskLevel | null;
  /** The linked sibling's own authority status. "revoked" (involuntary) is the
   *  textbook chameleon-successor tell — its trucks reappearing under this DOT.
   *  Null when no sibling was named. `siblingRevokedDate` is the involuntary
   *  revocation date when status is "revoked". */
  siblingStatus: "active" | "inactive" | "revoked" | null;
  siblingRevokedDate: string | null;
  /** Underlying FMCSA record — carried so the CSV export can emit the full FMCSA
   *  (BASIC percentiles) + regulatory (insurance/revocation/authority) columns
   *  beyond what the on-screen axes show. Not serialized into snapshots. */
  carrier: FmcsaCarrier;
  axes: {
    crash: AxisCell;
    unsafeDriving: AxisCell;
    hos: AxisCell;
    driverOos: AxisCell;
    controlledSubstances: AxisCell;
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
  bySeverity: Record<Exclude<RiskLevel, "Low">, number>;
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

function statusToRiskLevel(s: AxisStatus): RiskLevel {
  // critical + severe cell bands both map to the Critical carrier tier.
  if (s === "critical" || s === "severe") return "Critical";
  if (s === "high") return "High";
  if (s === "elevated") return "Medium";
  return "Low";
}

function ordinal(n: number): string {
  const v = n % 100;
  const suffix = v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** Render a BASIC as its FMCSA SMS percentile (peer-ranked — what FMCSA alerts
 *  on) instead of the raw rate, keeping the rate as a secondary anchor. Color
 *  reflects FMCSA's alert: at/above intervention threshold → high (severe if
 *  ≥90th); approaching → elevated. Falls back to the rate cell when the carrier
 *  isn't data-sufficient for a percentile. */
function basicPctCell(
  percentile: number | null,
  alert: string | null,
  rateCell: AxisCell,
  label: string,
  estimate = false
): AxisCell {
  if (percentile == null) return rateCell;
  const p = Math.round(percentile);
  const alerted = alert === "Y";
  // Tier bands. FMCSA's alert threshold is the 65th percentile (UD/HOS) — a low
  // bar ~1/3 of carriers cross on some BASIC, so "any alert → High" floods the
  // High tier. So a single alert only reaches High when it's ALSO ≥90th
  // percentile (genuinely top-decile); an alert at 65–89th, or a non-alerted
  // ≥75th, is Medium (awareness). Two crash-correlated BASICs ≥90th still
  // escalate to Critical via FAST-Act at the carrier-tier level.
  const status: AxisStatus =
    alerted && p >= 90 ? "high" : alerted || p >= 75 ? "elevated" : "clean";
  const rate = rateCell.display && rateCell.display !== "—" ? rateCell.display : null;
  // estimate = FMCSA doesn't publish this BASIC's percentile (Crash Indicator,
  // Hazmat Compliance) — we reproduce it, marked with * (see footnote).
  const star = estimate ? "*" : "";
  // One coherent story centered on the FMCSA percentile (the number that drives
  // the verdict). We deliberately DON'T mix in our raw OOS-rate-vs-peer-cutoff
  // ("below P85 cutoff…") or the national measure band — those are different
  // lenses that contradict the peer percentile (a carrier can be 100th-percentile
  // among peers yet below an absolute-rate cutoff). The raw inspection counts
  // stay as factual support.
  const countsMatch = rateCell.detail?.match(/^\d[\d,]* of [\d,]+ inspections/);
  const counts = countsMatch ? countsMatch[0] : null;
  const standing = alerted
    ? " — at/above FMCSA's intervention threshold"
    : p >= 75
      ? " — elevated, below FMCSA's alert threshold"
      : "";
  return {
    status,
    // Just the percentile — the cell color already encodes the alert/elevated
    // standing, so a ⚠ glyph next to the number was redundant noise. The
    // intervention-threshold wording stays in the hover detail.
    display: `${ordinal(p)}${star}`,
    // Single number per cell (the peer percentile); the supporting counts live
    // in the hover detail.
    detail:
      `${estimate ? "Estimated " : "FMCSA SMS "}${label}: ${ordinal(p)} percentile among peers${standing}` +
      `${estimate ? " (estimate — FMCSA doesn't publish this BASIC)" : ""}.` +
      `${counts ? ` Seen in ${counts}${rate ? ` (${rate})` : ""}.` : ""}`,
  };
}

/** Map crashes-per-million-miles to an approximate peer percentile using the
 *  fleet-size peer cutoffs. CI percentile is sparse (~21k carriers); cpm has full
 *  coverage and backtested almost as well (1.64x vs CI 1.74x), so it's the
 *  high-coverage fallback for the crash input. */
function cpmToPercentile(cpm: number | null, peer: PeerGroup): number | null {
  if (cpm == null) return null;
  const cuts = getCutoffs("crashesPerMillionMiles" as AxisKey, peer);
  if (cpm <= 0) return 0;
  if (cuts.p85 > 0 && cpm < cuts.p85) return Math.round((cpm / cuts.p85) * 85);
  if (cuts.p95 > cuts.p85 && cpm < cuts.p95)
    return Math.round(85 + ((cpm - cuts.p85) / (cuts.p95 - cuts.p85)) * 10);
  return cuts.p95 > 0 ? Math.min(99, Math.round(95 + (cpm / cuts.p95 - 1) * 4)) : 90;
}

/** Augie Safety Score (0-100, higher = worse): peer-fair, crash-calibrated roll-up
 *  of the BASIC percentiles. Weights are the measured crash-prediction lift from
 *  the temporal backtest — Crash Indicator/cpm (1.74x/1.64x) and Unsafe Driving
 *  (1.35x) dominate; HOS/VM/DF are near-flat for *crashes* so they carry only a
 *  token weight (they stay visible in their own cells for compliance). The
 *  percentile basis + fleet-size peer grouping make this fairer to small carriers
 *  than ISS, which under-ranks them on thin inspection exposure. Null when the
 *  carrier has no percentile or crash inputs (data-insufficient). */
// Crash-leaning but uses ALL 7 BASIC percentiles. Crash + Unsafe Driving carry
// the most weight (backtest crash-prediction lift); the other BASICs get real —
// not token — weight because they're genuine safety signals (and what ISS/brokers
// recognize), so the score tracks ISS instead of contradicting it. Controlled
// Substances (drug/alcohol) is safety- and crash-relevant; Hazmat is niche so it
// gets the least. Weights sum to 1.0 over available inputs (renormalized).
const SAFETY_WEIGHTS = { crash: 0.34, ud: 0.22, hos: 0.14, cs: 0.1, vm: 0.1, df: 0.06, hm: 0.04 };
function computeSafetyScore(
  c: FmcsaCarrier,
  peer: PeerGroup
): { score: number | null; tier: string | null } {
  // Crash input = the WORSE of the cpm-derived percentile and the scraped Crash
  // Indicator estimate. cpm has full coverage and is reliable; the CI estimate is
  // sparse and occasionally bogus (e.g. an intermodal carrier at 18 cpm showing
  // CI* 1st), so never let a low CI estimate mask a genuinely high crash rate.
  // cpm-preferred (reliable); the noisy scraped CI estimate only fills the gap
  // when there's no per-mile rate. (Avoids over-flagging big low-per-mile fleets.)
  const crashPct = cpmToPercentile(c.crashesPerMillionMiles, peer) ?? c.crashIndicatorPercentile;
  const parts: Array<[number | null, number]> = [
    [crashPct, SAFETY_WEIGHTS.crash],
    [c.unsafeDrivingPercentile, SAFETY_WEIGHTS.ud],
    [c.hosPercentile, SAFETY_WEIGHTS.hos],
    [c.controlledSubstancesPercentile, SAFETY_WEIGHTS.cs],
    [c.vehicleMaintenancePercentile, SAFETY_WEIGHTS.vm],
    [c.driverFitnessPercentile, SAFETY_WEIGHTS.df],
    [c.hmCompliancePercentile, SAFETY_WEIGHTS.hm],
  ];
  // Weighted CUBIC mean (power-mean, k=3), not a linear average: risk is
  // worst-driven, so a carrier with one or two severe BASICs must score high
  // even when its other BASICs are clean (a flat average would dilute a
  // 96th-percentile problem down to "Low"). The cube makes high percentiles
  // dominate while still using all 7 inputs.
  let num = 0;
  let den = 0;
  for (const [p, w] of parts) {
    if (p != null) {
      num += w * p * p * p;
      den += w;
    }
  }
  if (den === 0) return { score: null, tier: null };
  const score = Math.round(Math.cbrt(num / den));
  const tier = score >= 65 ? "High" : score >= 45 ? "Moderate" : "Low";
  return { score, tier };
}

type RiskScoreResult = {
  score: number;
  tier: string;
  factors: string[];
  contributions: RiskFactorContribution[];
};

function formatRiskContribution(f: RiskFactorContribution): string {
  return `+${f.points} ${f.label} — ${f.detail}`;
}

function refreshRiskScore(risk: RiskScoreResult): void {
  risk.score = Math.min(
    100,
    risk.contributions.reduce((sum, f) => sum + f.points, 0)
  );
  risk.tier = riskTierOf(risk.score);
  risk.factors = risk.contributions.map(formatRiskContribution);
}

function addRiskContribution(
  risk: RiskScoreResult,
  contribution: RiskFactorContribution
): void {
  if (contribution.points <= 0) return;
  risk.contributions.push(contribution);
  refreshRiskScore(risk);
}

function hasCoreRiskContribution(risk: RiskScoreResult): boolean {
  return risk.contributions.some((f) => f.kind === "core");
}

function parseDateishMs(value: string | null): number | null {
  if (!value) return null;
  const s = value.trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  const ms = m
    ? Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]))
    : Date.parse(s.slice(0, 10));
  return Number.isNaN(ms) ? null : ms;
}

function daysAgoDateish(value: string | null): number | null {
  const ms = parseDateishMs(value);
  if (ms == null) return null;
  return (Date.now() - ms) / (1000 * 60 * 60 * 24);
}

/** Carrier Risk Score (0-100, higher = worse): one transparent score across
 *  regulatory standing, identity/chameleon evidence, operating evidence, safety,
 *  and weak corroborators. We use the "balanced" point schedule from the May
 *  2026 shutdown/revocation review: strong signals move the score directly;
 *  soft markers such as ZIP, insurer, free email, or residential address stay
 *  low-weight and cannot create a high-risk call on their own. This is a
 *  heuristic index, not a calibrated probability. */
function computeRiskScore(
  c: FmcsaCarrier,
  safetyScore: number | null,
  identitySignals?: CarrierIdentityRiskSignals
): RiskScoreResult {
  const risk: RiskScoreResult = {
    score: 0,
    tier: "None",
    factors: [],
    contributions: [],
  };
  const add = (
    points: number,
    category: RiskFactorCategory,
    label: string,
    detail: string,
    kind: RiskFactorKind = "core"
  ) => addRiskContribution(risk, { category, label, points, detail, kind });

  // Phantom fleet (13.5x lift) — "claims tiny, runs hundreds": distinct power-unit
  // VINs ≫ reported PU. Gated to reported PU ≤ 5 so it targets shells, not legit
  // mid/large carriers with stale filings + leased owner-operators (e.g. CFI's
  // 91 PU). Suggestive alone (legit drive-away/auto-haul also look phantom), so
  // base is modest; a big bonus lands only when corroborated by financial-distress
  // / new-authority — the backtest's phantom+sub-ins (73%) / +new-auth (82%) combo.
  const phantom =
    c.totalPowerUnits <= 5 && c.puVinsInspected >= 10 && c.puVinsInspected >= 4 * Math.max(c.totalPowerUnits, 1);
  const bipdRelevant = c.bipdInsuranceRequired === "Y" || c.bipdRequiredAmount > 0;
  const subMin =
    bipdRelevant &&
    (c.bipdInsuranceOnFile === 0 ||
      (c.bipdRequiredAmount > 0 && c.bipdInsuranceOnFile < c.bipdRequiredAmount));
  const insChurn =
    c.rapidReplaceFlag ||
    c.insuranceCancellations24mo >= 2 ||
    c.insuranceDistinctPolicies24mo >= 3;
  const newAuthDays = daysSinceAuthorityIssued(c.dotAddDate);
  const newAuth = newAuthDays != null && newAuthDays < 365;
  const code = (c.statusCode ?? "").toUpperCase();
  const allowed = (c.allowedToOperate ?? "").toUpperCase();
  if (code && code !== "A" && allowed !== "Y") {
    add(
      35,
      "Authority / insurance",
      "Operating authority not active",
      `FMCSA status_code=${code}; carrier is not currently active.`
    );
  }
  const rating = (c.safetyRating ?? "").trim().toUpperCase();
  if (rating === "U" || rating === "UNSATISFACTORY") {
    add(
      35,
      "Safety / compliance",
      "Unsatisfactory safety rating",
      "FMCSA safety rating is Unsatisfactory."
    );
  } else if (rating === "C" || rating === "CONDITIONAL") {
    add(
      20,
      "Safety / compliance",
      "Conditional safety rating",
      "FMCSA safety rating is Conditional (milder than Unsatisfactory)."
    );
  }
  const involDaysAgo = daysAgo(c.mostRecentInvoluntaryDate);
  if (involDaysAgo != null && involDaysAgo <= 730) {
    add(
      30,
      "Authority / insurance",
      "Recent involuntary revocation",
      `Own authority was involuntarily revoked within 24 months (${c.mostRecentInvoluntaryDate}).`
    );
  } else if (
    c.priorRevokeFlag &&
    c.priorRevokeDotNumber != null &&
    c.priorRevokeDotNumber !== c.dotNumber
  ) {
    add(
      24,
      "Identity / chameleon",
      "FMCSA predecessor-revoke flag",
      c.priorRevokeDotNumber > 0
        ? `FMCSA links this carrier to previously revoked DOT ${c.priorRevokeDotNumber}.`
        : "FMCSA links this carrier to a previously revoked predecessor."
    );
  } else if (c.priorRevokeFlag) {
    add(
      12,
      "Authority / insurance",
      "Historical revocation context",
      "FMCSA prior-revoke flag is present, but no separate predecessor DOT is recorded.",
      "context"
    );
  }
  if (subMin) {
    add(
      30,
      "Authority / insurance",
      "$0/sub-minimum BIPD",
      c.bipdInsuranceOnFile === 0
        ? `$0 BIPD on file vs ${fmtMoney(c.bipdRequiredAmount)} FMCSA-required.`
        : `${fmtMoney(c.bipdInsuranceOnFile)} BIPD on file vs ${fmtMoney(c.bipdRequiredAmount)} FMCSA-required.`
    );
  } else if (c.bipdImminentLapse) {
    add(
      28,
      "Authority / insurance",
      "Imminent BIPD lapse",
      `Terminal BIPD cancellation filed${
        c.bipdPendingCancelDate ? ` for ${c.bipdPendingCancelDate}` : ""
      } with no replacement${
        c.bipdDaysToLapse != null
          ? c.bipdDaysToLapse < 0
            ? "; lapse is already past due"
            : `; ${c.bipdDaysToLapse} day(s) to lapse`
          : ""
      }.`
    );
  }
  if (phantom) {
    add(
      phantom && (subMin || insChurn || newAuth) ? 42 : 28,
      "Identity / chameleon",
      "Phantom fleet",
      `${c.puVinsInspected} distinct trucks inspected vs ${c.totalPowerUnits} reported power unit(s)${
        subMin || insChurn || newAuth ? "; corroborated by insurance distress or new authority." : "."
      }`
    );
  }
  if (insChurn) {
    const bits: string[] = [];
    if (c.insuranceCancellations24mo >= 2)
      bits.push(`${c.insuranceCancellations24mo} cancellation(s) in 24mo`);
    if (c.insuranceDistinctPolicies24mo >= 3)
      bits.push(`${c.insuranceDistinctPolicies24mo} distinct policies in 24mo`);
    if (c.rapidReplaceFlag) bits.push("rapid cancel+replace");
    add(
      16,
      "Authority / insurance",
      "Insurance churn",
      bits.join("; ")
    );
  }
  if (c.enforcementCasesCount >= 1) {
    add(
      16,
      "Safety / compliance",
      "FMCSA enforcement case",
      `${c.enforcementCasesCount} closed enforcement case(s)${
        c.enforcementRecentDate ? `, latest ${c.enforcementRecentDate}` : ""
      }.`
    );
  }
  // Chameleon contribution is added in scoreCarrier from the carrier-tier
  // chameleon results (shared-fleet / diffuse-equipment / address-cluster tiers
  // + the multi-signal cluster) — those use graduated thresholds with
  // concentration guards, so they catch real sub-70%-overlap chameleons (e.g.
  // VOXSER at 35% diffuse) that this function's old standalone VIN-check missed,
  // without re-introducing the over-firing. Kept out of here to avoid two
  // different chameleon thresholds disagreeing (score said Low, tier said
  // Critical). See applyChameleonRisk below.

  const months = newAuthDays != null ? Math.floor(newAuthDays / 30) : null;
  if (newAuthDays != null) {
    if (newAuthDays < 90)
      add(
        10,
        "Operations",
        "Very new authority",
        `${months}mo old; below the 90-day industry tenure floor.`,
        "context"
      );
    else if (newAuthDays < 180)
      add(
        6,
        "Operations",
        "New authority",
        `${months}mo old; below the 180-day vetting breakpoint.`,
        "context"
      );
    else if (newAuthDays < 365)
      add(3, "Operations", "Authority under 1 year", `${months}mo old.`, "context");
  }

  if (c.cargoInsuranceRequired && !c.cargoInsuranceOnFile) {
    add(
      14,
      "Authority / insurance",
      "Cargo filing missing when required",
      "FMCSA marks cargo insurance as required, but no cargo filing is on record."
    );
  }

  const mcs150AgeDays = daysAgo(c.mcs150Date);
  const bipdAgeDays = daysAgoDateish(c.bipdPolicyEffectiveDate);
  const shelfActivation =
    c.statusCode === "A" &&
    c.hasPropertyAuthority &&
    c.totalPowerUnits >= 3 &&
    newAuthDays != null &&
    newAuthDays >= 730 &&
    mcs150AgeDays != null &&
    mcs150AgeDays <= 365 &&
    bipdAgeDays != null &&
    bipdAgeDays <= 365 &&
    c.fleetSizeFlag === "low-activity";
  if (shelfActivation) {
    add(
      14,
      "Operations",
      "Dormant authority reactivation pattern",
      `DOT is ${Math.floor(newAuthDays / 365)}y old, but has fresh MCS-150/insurance activity and low inspection activity for ${c.totalPowerUnits} PU.`
    );
  }

  const safetyHard =
    c.fastActHighRisk ||
    c.hasSeriousViolation ||
    c.issTier === "Inspect" ||
    (c.crashesPerMillionMiles != null && c.crashesPerMillionMiles >= 5 && c.crashTotal >= 2);
  const safetyContext =
    !safetyHard &&
    (c.issTier === "Optional" ||
      (c.crashesPerMillionMiles != null && c.crashesPerMillionMiles >= 2 && c.crashTotal >= 2) ||
      (safetyScore != null && safetyScore >= 65));
  if (safetyHard) {
    const bits: string[] = [];
    if (c.issTier === "Inspect" && c.issScore != null) bits.push(`ISS ${c.issScore} Inspect`);
    if (c.fastActHighRisk) bits.push("FAST Act high-risk");
    if (c.hasSeriousViolation) bits.push(`${c.seriousViolationCount} acute/critical serious violation(s)`);
    if (c.crashesPerMillionMiles != null && c.crashesPerMillionMiles >= 5)
      bits.push(`${c.crashesPerMillionMiles.toFixed(2)} crashes per million miles`);
    add(18, "Safety / compliance", "Hard safety signal", bits.join("; "));
  } else if (safetyContext) {
    const bits: string[] = [];
    if (c.issTier === "Optional" && c.issScore != null) bits.push(`ISS ${c.issScore} Optional`);
    if (c.crashesPerMillionMiles != null && c.crashesPerMillionMiles >= 2)
      bits.push(`${c.crashesPerMillionMiles.toFixed(2)} crashes per million miles`);
    if (safetyScore != null && safetyScore >= 65) bits.push(`safety score ${safetyScore}`);
    add(8, "Safety / compliance", "Elevated safety context", bits.join("; "), "context");
  }

  const insr = lookupInsurerRisk(c.bipdInsurerName);
  const zipRisk = lookupZipRisk(c.physicalZip);
  const contextParts: string[] = [];
  let contextPoints = 0;
  if (insr) {
    contextPoints = Math.max(contextPoints, insr.tier === "high" ? 8 : 4);
    contextParts.push(
      `${c.bipdInsurerName} insurer book revokes ${insr.lift}x average (${insr.tier})`
    );
  }
  if (zipRisk) {
    contextPoints = Math.max(contextPoints, zipRisk.tier === "high" ? 8 : 4);
    contextParts.push(
      `${c.physicalZip} ZIP shutdown/revoke lift ${zipRisk.lift}x (${zipRisk.tier})`
    );
  }
  if (contextPoints > 0) {
    add(
      contextPoints,
      "Context",
      "Insurer / ZIP risk context",
      contextParts.join("; "),
      "context"
    );
  }

  if (identitySignals?.shutdownIdentityLinks.length) {
    const links = identitySignals.shutdownIdentityLinks;
    // Email/phone shared with a shut-down revoked DOT is the real identity tell
    // (2.5x revoke lift); an officer-name-only match is the weak majority of
    // volume (2.1x) and prone to common-name collisions / disparate impact, so
    // it gets a much lower weight. See officer-reuse-deadend + the 2026-05 lift test.
    const hasContactLink = links.some(
      (l) => l.startsWith("email") || l.startsWith("phone")
    );
    add(
      hasContactLink ? 20 : 10,
      "Identity / chameleon",
      hasContactLink
        ? "Identity tied to shut-down revoked DOT"
        : "Officer name shared with shut-down revoked DOT",
      links.slice(0, 3).join("; ")
    );
  }

  return risk;
}

function addWeakIdentityContext(
  risk: RiskScoreResult,
  identitySignals?: CarrierIdentityRiskSignals
): void {
  if (!identitySignals || !hasCoreRiskContribution(risk)) return;
  const markers: string[] = [];
  if (identitySignals.freeEmailDomain) {
    markers.push(`free email domain ${identitySignals.freeEmailDomain}`);
  }
  if (identitySignals.residentialAddressMarker) {
    markers.push(`address marker ${identitySignals.residentialAddressMarker}`);
  }
  if (!markers.length) return;
  addRiskContribution(risk, {
    category: "Context",
    label: "Personal contact/address corroborator",
    points: 5,
    detail: markers.join("; "),
    kind: "context",
  });
}

/** Risk-score tier. Bands match the balanced proposal:
 *  80+ Critical, 60-79 High, 35-59 Medium, 15-34 Low/context, else None. */
function riskTierOf(score: number): string {
  return score >= 80
    ? "Critical"
    : score >= 60
      ? "High"
      : score >= 35
        ? "Medium"
        : score >= 15
          ? "Low"
          : "None";
}

function bumpUp(t: RiskLevel): RiskLevel {
  if (t === "Low") return "Medium";
  if (t === "Medium") return "High";
  if (t === "High") return "Critical";
  return t; // Critical stays
}

/** Empirical percentile-rarity label for an insurance-cancellation count
 *  (24-month window). Distribution is heavily zero-inflated — 90% of active
 *  carriers have 0 cancellations, so naive percentile labels like "P95" don't
 *  map to "5 cancellations" the way you'd expect. Numbers below come from a
 *  one-time count over the May 2026 snapshot's 2.06M active carriers; refresh
 *  on the next snapshot if the rarity gets renamed in marketing copy.
 *
 *    n=3  ≈ top 2.3%   (P97.7)
 *    n=4  ≈ top 1.2%   (P98.8)
 *    n=5  ≈ top 0.7%   (P99.3)
 *    n=6  ≈ top 0.4%   (P99.6)
 *    n=7  ≈ top 0.25%  (P99.75)
 *    n=8  ≈ top 0.16%  (P99.84)
 *    n=10+≈ top 0.07%  (P99.93)
 */
/**
 * Percentile labels for distinct policies cancelled in 24mo.
 *
 * Empirical distribution among carriers with any BIPD cancellation in 24mo:
 *   P50 = 1 distinct policy, P75 = 2, P95 = 3, P99 = 4, P99.96 = 7+
 *
 * National rates among ALL active carriers are sharper still — only ~0.9%
 * have ≥3 distinct cancelled policies, ~0.04% have ≥5.
 *
 * The labels here are aligned to the new "distinct policies" metric. Prior
 * implementation labeled raw cancellation events, which over-stated the rarity
 * for carriers with chronic billing-cycle issues (1 policy cancelled 6 times
 * looked like top 0.4% nationally).
 */
export function cancelChurnPercentileText(n: number): string {
  if (n >= 7) return "top 0.04% (P99.96)";
  if (n >= 5) return "top 0.3% (P99.7)";
  if (n >= 4) return "top 0.6% (P99.4)";
  if (n >= 3) return "top 0.9% (P99.1)";
  if (n >= 2) return "top 4.3% (P95.7)";
  return "uncommon";
}

function bandLabel(s: AxisStatus): string {
  // Cell-band vocabulary matches the 4-tier carrier scale: a ≥P95 axis maps to
  // the Critical tier, the floor-bumped band to High, P85 to Medium.
  if (s === "severe") return "Critical/P95";
  if (s === "high") return "High/P90";
  if (s === "elevated") return "Medium/P85";
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
  let status = statTier(rate, cuts);
  // A single OOS-rate BASIC caps at High — one axis alone never forces Critical,
  // especially on thin samples (e.g. FATEH: 2 of 3 inspections) or when FMCSA's
  // own ISS says Pass. Critical is reserved for crash outliers, FAST-Act (2+
  // BASICs ≥90th), and regulatory/fraud failures. statTier emits only severe
  // (≥P95) or clean, so this caps the severe band down to High.
  if (status === "severe") status = "high";
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
  if (c.crashTotal < 2) {
    // A single crash is statistical noise, not a pattern — one event plus a low
    // VMT denominator can spike the per-mile rate over the floor (e.g. 1 crash
    // on a 10-truck fleet → 2.3/M mi). Show the rate for transparency, but a
    // lone crash doesn't drive the tier; 2+ crashes in 24mo are needed to flag.
    return {
      cell: {
        status: "clean",
        display: cpm.toFixed(2),
        detail: `${cpm.toFixed(2)} crashes per million miles — 1 crash on ${c.totalPowerUnits} PU in 24 months. A single crash isn't scored (one event can spike a small fleet's per-mile rate); 2+ crashes are needed to flag.`,
      },
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
    // At least elevated, then bump one cell-severity notch when the absolute
    // floor trips: clean/elevated → high, high → severe; severe/critical are
    // already at or above the floor.
    const notch: Partial<Record<AxisStatus, AxisStatus>> = {
      clean: "high", na: "high", info: "high", elevated: "high",
      high: "severe", severe: "severe", critical: "critical",
    };
    status = notch[status] ?? "high";
  }
  // Marginal demotion: a rate within 10% of its flagging cutoff is statistically
  // indistinguishable from the line, so a hair over drops one notch (1.02× over
  // P90 → Medium, not High). Keeps deep outliers (MJ 2.28×) untouched.
  if (status === "severe" || status === "high") {
    const c0 = cutoffForStatus(cuts, status);
    if (c0 > 0 && cpm / c0 < 1.1) status = status === "severe" ? "high" : "elevated";
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
      label: getRule("crash-rate").label,
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
      label: getRule("recent-revocation").label,
      detail: `${c.mostRecentInvoluntaryDate} — FMCSA pulled authority within the last 24 months.`,
    });
  } else if (c.revocationsTotal > 0) {
    // Historical revocations only — surface the count as neutral context (grey,
    // no highlight) without contributing to the carrier's overall risk tier.
    // Only a RECENT involuntary revocation (≤24mo, handled above) earns a cell
    // color; a carrier with 6 involuntary revocations from 20 years ago who's
    // been clean since is not a current risk, so the cell shouldn't draw the eye.
    // The count + dates still render (display + tooltip) for anyone who looks.
    status = "na";
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
      label: getRule("authority-not-active").label,
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
      label: getRule("safety-rating-unsatisfactory").label,
      detail: "FMCSA safety rating: Unsatisfactory.",
    });
  } else if (rating === "C" || rating === "CONDITIONAL") {
    parts.push("Cond");
    promote("critical");
    reasons.push({
      label: getRule("safety-rating-conditional").label,
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
        label: getRule("new-authority").label,
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
        label: getRule("insurance-lapsed").label,
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
        label: getRule("insurance-lapsed").label,
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

// classifyCargoInsurance used to live here. It was never wired into
// analyze() because FMCSA's bulk-file cargo-on-file flag has too many
// false positives — large carriers commonly self-insure cargo and file
// COIs direct with brokers, not with FMCSA. Removed during the fixture
// pass when the orphaned rule failed its regression test. Bring it back
// when there's a cleaner cargo signal available.

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
        label: getRule("new-authority").label,
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
      label: getRule("recent-enforcement").label,
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

export type SiblingStatus = {
  kind: "active" | "inactive" | "revoked";
  date: string | null;
};

// Window for treating a linked authority's involuntary revocation as a live
// chameleon-successor signal. FMCSA's status flag lags (a carrier can show
// "Active" for months after its authority is pulled, or briefly reinstate), so
// the revocation EVENT — not the current flag — is what we key on.
const SIBLING_REVOKE_WINDOW_DAYS = 365 * 3;

/** Authority status of a (sibling) carrier, for the linked-authority signal.
 *  "revoked" = involuntary revocation within the last 3y (the chameleon-
 *  predecessor case — its trucks reappearing under our carrier), regardless of
 *  the current status flag, which lags. "inactive" = currently not allowed to
 *  operate with no recent involuntary revocation (voluntary/dormant — benign-er). */
export function siblingStatusOf(c: FmcsaCarrier): SiblingStatus {
  const revokedDaysAgo = daysAgo(c.mostRecentInvoluntaryDate);
  if (revokedDaysAgo != null && revokedDaysAgo <= SIBLING_REVOKE_WINDOW_DAYS)
    return { kind: "revoked", date: c.mostRecentInvoluntaryDate };
  const allowed = (c.allowedToOperate ?? "").toUpperCase();
  if (allowed !== "Y" && allowed !== "") return { kind: "inactive", date: null };
  return { kind: "active", date: null };
}

function scoreCarrier(
  c: FmcsaCarrier,
  loadInfo: { loadIds: Set<string>; hazmatLoadIds: Set<string> },
  siblingStatusMap: Map<number, SiblingStatus> = new Map(),
  identitySignalsMap: Map<number, CarrierIdentityRiskSignals> = new Map()
): CarrierRow {
  const peer = peerGroupForPU(c.totalPowerUnits);

  const safety = computeSafetyScore(c, peer);
  const identitySignals = c.dotNumber == null ? undefined : identitySignalsMap.get(c.dotNumber);
  const risk = computeRiskScore(c, safety.score, identitySignals);
  // Chameleon contribution to the risk score, derived from the carrier-tier
  // chameleon findings computed below (so the score and the verdict agree).
  // Strongest single facet, with the multi-signal cluster as a 30-pt floor;
  // folded into the risk score just before the risk-score floor bump.
  let fleetRiskContribution: RiskFactorContribution | null = null;
  const setFleetRisk = (p: number, label: string, detail: string) => {
    if (!fleetRiskContribution || p > fleetRiskContribution.points) {
      fleetRiskContribution = {
        category: "Identity / chameleon",
        label,
        points: p,
        detail,
        kind: "core",
      };
    }
  };
  const crash = classifyCrash(c, peer);
  // Crash column is percentile-primary like the other BASICs: the TOP line is our
  // crash peer-percentile, the SUBTITLE is crashes-per-million-miles. The
  // percentile is the WORSE of the cpm-derived rank and the scraped Crash
  // Indicator estimate — so a high crash rate can never be masked by a bad CI
  // value (the 18-cpm carrier the scrape put at "CI* 1st" still shows ~99th).
  // Marked * because FMCSA doesn't publish a crash percentile. Color comes from
  // the (reliable) cpm-based crash status, so the number and color agree.
  let crashEstReason: Reason | null = null;
  {
    const cpm = c.crashesPerMillionMiles;
    const cpmPct = cpmToPercentile(cpm, peer);
    const ci = c.crashIndicatorPercentile;
    // cpm (crashes-per-mile) is the reliable crash signal; the scraped CI estimate
    // is noisy (per-PU, can over-flag big low-per-mile carriers like Werner, and
    // has bogus values). So trust cpm when present; the CI estimate only fills the
    // gap when there's NO cpm (no mileage on file). This catches missing-mileage
    // carriers with real crashes without false-flagging good-per-mile fleets.
    const noCpm = cpm == null;
    if (c.crashIndicatorAlert === "Y" && noCpm && statusRank(crash.cell.status) < statusRank("elevated")) {
      crash.cell.status = "elevated";
      crashEstReason = {
        label: "Estimated Crash Indicator — elevated",
        detail: `Estimated Crash Indicator at the ${ordinal(Math.round(ci ?? 0))} percentile (at/above FMCSA's intervention threshold), from ${c.crashTotal} crash(es) — no mileage on file to compute a per-mile rate. FMCSA does not publish this BASIC; treat as an estimate.`,
      };
    }
    const crashPct = cpmPct ?? ci;
    if (crashPct != null) {
      // Cell color encodes the alert standing — no ⚠ glyph in the number.
      crash.cell.display = `${ordinal(Math.round(crashPct))}*`;
      crash.cell.sub = cpm != null ? `${cpm.toFixed(2)} /mi` : undefined;
    }
    crash.cell.detail = `${crash.cell.detail ?? ""} Crash %ile* is our estimate (FMCSA does not publish Crash Indicator)${
      ci != null ? `; scraped CI estimate ${ordinal(Math.round(ci))} percentile` : ""
    }.`.trim();
  }
  const unsafeDriving = classifyOos(
    "unsafeDriving",
    c.unsafeDrivingViolations,
    c.driverInsp,
    peer,
    getRule("unsafe-driving-rate").label
  );
  const hos = classifyOos(
    "hos",
    c.hosViolations,
    c.driverInsp,
    peer,
    getRule("hos-compliance-rate").label
  );
  const driver = classifyOos(
    "driverOos",
    c.driverOosInsp,
    c.driverInsp,
    peer,
    getRule("driver-oos-rate").label
  );
  const vehicle = classifyOos(
    "vehicleOos",
    c.vehicleOosInsp,
    c.vehicleInsp,
    peer,
    getRule("vehicle-oos-rate").label
  );
  const hazmat = classifyOos(
    "hazmatOos",
    c.hazmatOosInsp,
    c.hazmatInsp,
    peer,
    getRule("hazmat-oos-rate").label
  );
  // NB: we do NOT let the HM Compliance estimate drive the hazmat tier. Unlike
  // crash (where missing mileage leaves no reliable signal), an HM percentile
  // implies the carrier has hazmat inspections, so the OOS rate is available and
  // reliable — letting the severity-weighted HM estimate override it just
  // over-flags big carriers (e.g. Werner runs hazmat at scale). HM stays as a
  // displayed percentile + Safety-score input + tooltip context.
  const hmEstReason: Reason | null = null;

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

  // FMCSA publishes real percentiles for these four BASICs, so the published
  // percentile + alert is AUTHORITATIVE for both display and tier — our cruder
  // violations÷inspections rate is only the fallback when FMCSA hasn't scored
  // the carrier (data-insufficient). This stops a carrier FMCSA itself rates
  // clean (e.g. ARAB CARTAGE: HOS 62nd, no alert) from being flagged on our raw
  // rate, and keeps the visible cell and the carrier tier in agreement. Built
  // after the enrichment above so the cell detail carries the FMCSA measure.
  const udCell = basicPctCell(c.unsafeDrivingPercentile, c.unsafeDrivingAlert, unsafeDriving.cell, "Unsafe Driving");
  const hosCell = basicPctCell(c.hosPercentile, c.hosAlert, hos.cell, "HOS Compliance");
  const driverCell = basicPctCell(c.driverFitnessPercentile, c.driverFitnessAlert, driver.cell, "Driver Fitness");
  const vehicleCell = basicPctCell(c.vehicleMaintenancePercentile, c.vehicleMaintenanceAlert, vehicle.cell, "Vehicle Maintenance");
  // The reason for a percentile-backed BASIC is derived from the authoritative
  // cell, so a flag and its explanation always agree (no "clean cell, flagged
  // reason" mismatch — and an alert with a low raw rate still produces a reason).
  const pctReason = (cell: AxisCell, ruleId: string): Reason | null =>
    cell.status === "clean" || cell.status === "na" || cell.status === "info"
      ? null
      : { label: getRule(ruleId).label, detail: cell.detail ?? "" };
  const udReason = pctReason(udCell, "unsafe-driving-rate");
  const hosReason = pctReason(hosCell, "hos-compliance-rate");
  const driverReason = pctReason(driverCell, "driver-oos-rate");
  const vehicleReason = pctReason(vehicleCell, "vehicle-oos-rate");

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
    // priorRevokeFlag is the signal; the predecessor DOT is just for the detail.
    // It's often recorded as 0 (unknown) — flag the chameleon either way, but
    // don't print "prior DOT: 0".
    revocation.cell.status = "critical";
    const detail = c.priorRevokeDotNumber > 0
      ? `FMCSA flags this DOT as a re-incarnation of a previously-revoked predecessor (prior DOT: ${c.priorRevokeDotNumber}).`
      : `FMCSA flags this DOT as a re-incarnation of a previously-revoked carrier (predecessor DOT not recorded).`;
    revocation.cell.detail = revocation.cell.detail
      ? `${revocation.cell.detail}\n${detail}`
      : detail;
    revocation.reasons.push({ label: getRule("chameleon-prior-revoke").label, detail });
  }

  // A2. Rapid cancel+replace insurance pattern is a chameleon signal ONLY
  // when paired with ≥3 true cancellations in 24 months. A single cancel +
  // replace within 30 days is the normal pattern for routine insurer
  // renewals — flagging on that alone produces too many false positives
  // (verified against production carriers). The combined pattern (rapid
  // replace AND repeated cancellations) is the actual re-incarnation move.
  if (c.rapidReplaceFlag && c.insuranceCancellations24mo >= 3) {
    insurance.cell.status = "critical";
    const detail = `Insurance policy cancelled and replaced within ~30 days, alongside ${c.insuranceCancellations24mo} distinct policies cancelled in 24 months — re-incarnation pattern.`;
    insurance.cell.detail = insurance.cell.detail ? `${insurance.cell.detail}\n${detail}` : detail;
    insurance.reason = { label: getRule("insurance-rapid-replace").label, detail };
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
  // A3. Insurance cancellation churn, graduated by national-population rarity.
  // The distribution is heavily zero-inflated (90% of active carriers have 0
  // cancellations in 24mo), so the "top X%" labels in the detail strings are
  // computed from the empirical distribution and bucketed per count rather
  // than approximated against round percentiles. May 2026 snapshot:
  //   3 cancellations  ≈ top 2.3% (P97.7)
  //   4 cancellations  ≈ top 1.2%
  //   5 cancellations  ≈ top 0.7% (P99.3)
  //   6 cancellations  ≈ top 0.4%
  //   7 cancellations  ≈ top 0.25%
  // Tier mapping stays at the original thresholds:
  //   ≥7 cancellations → Severe (≈ top 0.25%)
  //   3-6 cancellations → Elevated
  // Skipped when rapid_replace_flag already fired (A2 sets a stronger tier
  // with the same evidence).
  if (!c.rapidReplaceFlag) {
    const n = c.insuranceCancellations24mo;
    if (n >= 5) {
      if (statusRank(insurance.cell.status) < statusRank("severe")) {
        insurance.cell.status = "severe";
      }
      if (!insurance.reason) {
        insurance.reason = {
          label: getRule("insurance-severe-churn").label,
          detail: `${n} distinct policies cancelled in last 24 months — ${cancelChurnPercentileText(n)} of carriers nationally. Carrier is on the edge of insurer dropout.`,
        };
      }
    } else if (n >= 3) {
      if (statusRank(insurance.cell.status) < statusRank("elevated")) {
        insurance.cell.status = "elevated";
      }
      if (!insurance.reason) {
        insurance.reason = {
          label: getRule("insurance-churn").label,
          detail: `${n} distinct policies cancelled in last 24 months — ${cancelChurnPercentileText(n)} of active carriers nationally. Verify carrier is on a stable policy before tendering.`,
        };
      }
    }
  }

  // Insurance rules added after the primary classification (A0/A1/A2/A3). These
  // can coexist with the primary insurance reason — e.g. a carrier can be both
  // currently lapsed AND historically sub-minimum, both signals deserve their
  // own row. Pushed into a local array and merged into `reasons` at collection
  // time.
  const extraInsuranceReasons: Reason[] = [];

  // A4. Sub-minimum BIPD coverage. Federal minimum for general-freight property
  // carriers is $750k. Filed coverage below that — when not zero ($0 = lapsed,
  // already covered by A0) — means the carrier has under-stated coverage on
  // file. Brokers cannot legally tender loads requiring higher coverage to a
  // carrier filing below that load's minimum.
  if (c.bipdInsuranceOnFile > 0 && c.bipdInsuranceOnFile < 750 && c.allowedToOperate === "Y") {
    if (statusRank(insurance.cell.status) < statusRank("severe")) {
      insurance.cell.status = "severe";
    }
    extraInsuranceReasons.push({
      label: getRule("insurance-sub-minimum-bipd").label,
      detail: `Filed BIPD is $${c.bipdInsuranceOnFile}k, below the federal $750k minimum for general-freight property carriers.`,
    });
  }

  // A5. All-cancel insurance pattern — multiple distinct policies in 24mo with
  // zero Replaced events. Indicates the carrier is shopping a new insurer each
  // policy term rather than renewing with the same one. Distinct from churn
  // (raw cancellation count) and rapid-replace (cancel + immediate re-bind).
  if (
    c.insuranceDistinctPolicies24mo >= 3 &&
    c.insuranceReplaces24mo === 0 &&
    !c.rapidReplaceFlag
  ) {
    const distinct = c.insuranceDistinctPolicies24mo;
    const tier: "high" | "caution" = distinct >= 5 ? "high" : "caution";
    const newStatus: AxisStatus = tier === "high" ? "severe" : "elevated";
    if (statusRank(insurance.cell.status) < statusRank(newStatus)) {
      insurance.cell.status = newStatus;
    }
    extraInsuranceReasons.push({
      label: getRule("insurance-all-cancel-pattern").label,
      detail: `${distinct} distinct BIPD policies in 24 months with zero recorded renewals — every policy ended as a cancellation. Carrier is shopping insurers each term rather than renewing, which usually means the prior insurer declined to continue.`,
    });
  }

  // C1b. FAST Act §5305 High-Risk — 2+ of {Unsafe Driving, Crash Indicator,
  // HOS, Vehicle Maintenance} at ≥90th percentile: FMCSA's own threshold for
  // targeting a carrier for an onsite investigation. Precomputed in the parquet
  // (fastActHighRisk). Individual BASIC alerts still surface on their own axes;
  // this is the only multi-BASIC aggregate signal (FMCSA's actual rule).
  const fastActBasicNames: Record<string, string> = {
    UD: "Unsafe Driving", CI: "Crash Indicator",
    HOS: "Hours-of-Service", VM: "Vehicle Maintenance",
  };
  const fastActReason: Reason | null = c.fastActHighRisk
    ? {
        label: getRule("fast-act-high-risk").label,
        detail: `${(c.fastActHighRiskBasics ?? "")
          .split("+")
          .map((code) => fastActBasicNames[code] ?? code)
          .join(" + ")} at ≥90th percentile — the bar FMCSA uses under the FAST Act (§5305) to prioritize a carrier for onsite investigation.`,
      }
    : null;

  // C1c. Serious Violations — acute/critical violations cited during an FMCSA
  // investigation in the last 12 months (scraped per-carrier). Direct evidence
  // of non-compliance found in an audit; FMCSA's ISS forces the affected BASIC
  // to the 100th percentile. Critical when broad (2+ BASICs).
  const svBasicNames: Record<string, string> = {
    UD: "Unsafe Driving", CI: "Crash Indicator", HOS: "Hours-of-Service",
    DF: "Driver Fitness", CS: "Controlled Substances", VM: "Vehicle Maintenance",
    HM: "Hazmat",
  };
  const svBasicCodes = (c.seriousViolationBasics ?? "").split("+").filter(Boolean);
  const seriousViolationReason: Reason | null = c.hasSeriousViolation
    ? {
        label: getRule("serious-violations").label,
        detail: `FMCSA investigation in the last 12 months cited ${c.seriousViolationCount} acute/critical violation${c.seriousViolationCount === 1 ? "" : "s"}${
          svBasicCodes.length
            ? ` in ${svBasicCodes.map((x) => svBasicNames[x] ?? x).join(" + ")}`
            : ""
        }. These are findings from an on-site/off-site audit — FMCSA's ISS forces the affected BASIC to the 100th percentile. Verify corrective action before tendering.`,
      }
    : null;

  // C2. Imminent BIPD lapse — the carrier STILL shows active BIPD coverage but
  // its last/only policy has a cancellation filed with no replacement, so it's
  // about to lose the insurance that authorizes it to operate. Gated on
  // bipdInsuranceOnFile >= 1 so it does NOT double-report with the standard
  // "$0 BIPD on file" insurance check (which already covers carriers that have
  // already lapsed to zero). This rule is the forward-looking early warning.
  const lapseReason: Reason | null =
    c.bipdImminentLapse && c.bipdInsuranceOnFile >= 1
      ? {
          label: getRule("insurance-imminent-lapse").label,
          detail:
            `Last BIPD liability policy is cancelling (effective ${c.bipdPendingCancelDate})${
              c.bipdDaysToLapse != null
                ? c.bipdDaysToLapse >= 0
                  ? ` — about ${c.bipdDaysToLapse} day(s) out`
                  : ` — already past due`
                : ""
            }, with no replacement filed and no other active BIPD coverage. The carrier is at imminent risk of losing operating authority. (Insurance data as of the latest snapshot — confirm against live FMCSA before relying on it.)`,
        }
      : null;
  if (lapseReason) {
    const d = c.bipdDaysToLapse;
    // Within 2 weeks of losing its only BIPD policy with no replacement → treat
    // as Critical (red). The carrier is insured today but you can't safely tender
    // a load that picks up after the lapse date. 15-45 days out → Elevated warning.
    // Because insurance.cell.status feeds the row's worst-status, marking it
    // "critical" here floors the whole row at Critical.
    const within2wk = d != null && d <= 14;
    const newStatus: AxisStatus = within2wk ? "critical" : "elevated";
    if (statusRank(insurance.cell.status) < statusRank(newStatus)) {
      insurance.cell.status = newStatus;
    }
    // Surface the countdown in the cell itself, next to the coverage amount.
    insurance.cell.sub =
      d == null ? "lapse pending"
      : d < 0 ? "lapse overdue"
      : d === 0 ? "lapses today"
      : `lapses in ${d}d`;
  }
  // Show the BIPD cancellation count under the amount — churn is a leading
  // instability/fraud signal even when the carrier is currently insured.
  if (c.insuranceCancellations24mo > 0) {
    const cx = `${c.insuranceCancellations24mo} cancel${c.insuranceCancellations24mo === 1 ? "" : "s"}/24mo`;
    insurance.cell.sub = insurance.cell.sub ? `${insurance.cell.sub} · ${cx}` : cx;
  }

  // FMCSA ISS-CSA score — surfaced as CONTEXT only (not a tier driver: ISS is
  // FMCSA's roadside-inspection-priority score, which over-weights large
  // carriers with inspection exposure and under-weights data-poor small ones,
  // so the underlying alerts/rules drive our tier, not ISS). Show only the
  // top "Inspect" tier — Optional/Pass are too noisy to surface per-audit.
  const issReason: Reason | null =
    c.issTier === "Inspect" && c.issScore != null
      ? {
          label: "ISS — Inspect (top inspection priority)",
          detail: `Estimated ISS ≈ ${c.issScore}/100${
            c.issGroup ? ` · ${c.issGroup}` : ""
          }.`,
        }
      : null;

  // Collect reasons (for tooltip/expand)
  const reasons: Reason[] = [];
  if (issReason) reasons.push(issReason);
  if (insurance.reason) reasons.push(insurance.reason);
  reasons.push(...extraInsuranceReasons);
  if (lapseReason) reasons.push(lapseReason);
  // Insurer reputation — surface high-risk-specialist insurers in the issue list.
  {
    const insr = lookupInsurerRisk(c.bipdInsurerName);
    if (insr && insr.tier === "high") {
      reasons.push({
        label: "High-risk insurer",
        detail: `Insured by ${c.bipdInsurerName} — carriers it covers are revoked ${insr.lift}× more often than the national average (surplus-lines / high-risk-specialist insurer). Not disqualifying on its own, but verify coverage and standing before tendering.`,
      });
    }
  }
  reasons.push(...authority.reasons);
  if (seriousViolationReason) reasons.push(seriousViolationReason);
  if (fastActReason) reasons.push(fastActReason);
  if (crash.reason) reasons.push(crash.reason);
  if (crashEstReason) reasons.push(crashEstReason);
  if (hmEstReason) reasons.push(hmEstReason);
  if (udReason) reasons.push(udReason);
  if (hosReason) reasons.push(hosReason);
  if (driverReason) reasons.push(driverReason);
  if (vehicleReason) reasons.push(vehicleReason);
  if (hazmat.reason) reasons.push(hazmat.reason);
  reasons.push(...revocation.reasons);
  if (enforcement.reason) reasons.push(enforcement.reason);

  // Compute overall risk tier
  // Start with the worst per-axis status
  const cellStatuses: AxisStatus[] = [
    crash.cell.status,
    udCell.status,
    hosCell.status,
    driverCell.status,
    vehicleCell.status,
    hazmat.cell.status,
    revocation.cell.status,
    authority.cell.status,
    insurance.cell.status,
  ];
  let worst: AxisStatus = "clean";
  for (const s of cellStatuses) {
    if (statusRank(s) > statusRank(worst)) worst = s;
  }
  let level: RiskLevel = statusToRiskLevel(worst);

  // Bumps for compound signals
  const isSignal = (s: AxisStatus) => s !== "clean" && s !== "na" && s !== "info";
  const hasStatisticalSignal =
    isSignal(crash.cell.status) ||
    isSignal(udCell.status) ||
    isSignal(hosCell.status) ||
    isSignal(driverCell.status) ||
    isSignal(vehicleCell.status) ||
    isSignal(hazmat.cell.status);
  if (revocation.recent && hasStatisticalSignal) {
    // Recent revocation + any statistical signal → Critical
    level = "Critical";
  }

  // FAST Act High-Risk tier bump → Critical. This is FMCSA's own onsite-
  // investigation bar (2+ crash-correlated BASICs at ≥90th) and is now the
  // safety path to Critical: a single alerted BASIC tops out at High (see
  // basicPctCell), and only this multi-signal pattern escalates to Critical.
  if (fastActReason) {
    level = "Critical";
  }

  // Serious Violations tier bump — acute/critical violations found in an FMCSA
  // investigation are direct non-compliance findings. Broad (2+ BASICs) →
  // Critical; any → floor at High.
  if (seriousViolationReason) {
    if (svBasicCodes.length >= 2) {
      level = "Critical";
    } else if (level !== "Critical") {
      level = "High";
    }
  }
  // (Chronic lifetime-count bump removed — see classifyRevocation. Carriers
  // are flagged only on actual activity in the last 24 months.)

  // D10. Chameleon-pattern cluster — if 2+ independent chameleon signals fire,
  // escalate row tier to Critical minimum. Any single signal on its own is
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
    chameleonSignals.push(
      c.priorRevokeDotNumber > 0
        ? `FMCSA prior-revoke flag (prior DOT ${c.priorRevokeDotNumber})`
        : `FMCSA prior-revoke flag (predecessor not recorded)`
    );
  }
  // Insurance signals are bucketed together — rapid-replace and ≥2 cancellations
  // are both views of the same churn evidence, not independent corroboration.
  // Counting both as separate chameleon signals causes the "we said the same
  // thing twice" effect (DJI EXPRESS showed both "Rapid replace + cancellation
  // history" and "Chameleon-pattern cluster" with the same insurance evidence).
  // We emit ONE insurance-derived signal that names whichever sub-pattern fired
  // (preferring the more specific rapid-replace label when both apply).
  if (c.rapidReplaceFlag) {
    chameleonSignals.push(
      c.insuranceCancellations24mo >= 2
        ? `Insurance cancel+replace within 30 days + ${c.insuranceCancellations24mo} cancellations in 24mo`
        : "Insurance cancel+replace within 30 days"
    );
  } else if (c.insuranceCancellations24mo >= 2) {
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
      reasons.push({ label: addrRule.label, detail });
      // Contribute to the multi-signal chameleon-cluster escalator below.
      chameleonSignals.push(`${oos} OOS DOTs at same address`);
      // Direct level escalation: critical-tier address cluster floors the
      // carrier at Critical; high-tier floors at High; caution alone doesn't
      // escalate level (it just appears as a reason on the carrier audit row).
      if (addrTier === "critical") {
        level = "Critical";
      } else if (addrTier === "high" && level !== "Critical") {
        level = "High";
      }
      addRiskContribution(risk, {
        category: "Identity / chameleon",
        label: "Address OOS cluster",
        points: addrTier === "critical" ? 18 : addrTier === "high" ? 13 : 8,
        detail: `${oos} out-of-service DOTs share this carrier's physical address.`,
        kind: "core",
      });
    }
  }

  // Tracks whether the shared-fleet rule contributed a chameleon-cluster
  // signal. Used by the diffuse-equipment rule (D10d) to avoid double-counting
  // the same VIN overlaps: when both rules fire, the concentrated 76%-with-
  // single-sibling overlap is a subset of the diffuse 86%-across-N-siblings
  // count, so they describe overlapping evidence. We still surface both as
  // separate reasons (they tell different stories to the broker), but only
  // one of them counts toward the cluster threshold.
  let firedFleetSharingClusterSignal = false;
  // The single named shared-fleet sibling (top concentrated VIN-overlap partner),
  // captured when the chameleon-shared-fleet reason fires so the API route can
  // score it and show its own verdict alongside this carrier's.
  let siblingRef: { dot: number; name: string | null } | null = null;
  // The named sibling's authority status (filled when siblingRef is set + the
  // status map has an entry). A "revoked" sibling whose fleet now runs here is
  // the chameleon-successor tell — it escalates the verdict + fraud score below.
  let siblingStatusKind: "active" | "inactive" | "revoked" | null = null;
  let siblingRevokedDate: string | null = null;

  // D10c. Chameleon shared-fleet — % of inspected VINs that also appear under
  // another active DOT. Per the chameleon-shared-fleet rule in the registry:
  //   critical: ≥50% overlap AND sibling at same address
  //   high:     ≥80% overlap (any address) OR ≥50% with similar name
  //   caution:  ≥50% overlap, no address/name correlation
  {
    const fleetRule = getRule("chameleon-shared-fleet");
    const pct = c.largestSiblingOverlapPct;
    const shared = c.largestSiblingSharedVins;
    const siblingDot = c.largestSiblingDot;
    const siblingName = c.largestSiblingLegalName;
    // Data sufficiency scales with fleet size: a SMALL fleet needs ≥5 inspected
    // VINs, but a LARGE fleet (>20 PU) needs ≥30 — large carriers share VINs
    // legitimately (leased owner-operators, intermodal chassis, multi-DOT
    // structures), so the overlap % is only trustworthy on a rich sample. This
    // catches the real large shared-fleet ring (DK MAX: 60 PU, 140 VINs, 107
    // shared) while dropping the thin-sample false positive (HIGHLIGHT: 80 PU,
    // 10 VINs, 19-yr, all-clean — leasing, not a ring). Plus ≥5 shared VINs.
    const minVins = c.totalPowerUnits <= 20 ? 5 : 30;
    if (siblingDot && pct >= 50 && shared >= 5 && c.largestSiblingTotalVins >= minVins) {
      // Name-similarity check: do the two DOTs share a meaningful name root?
      // Cheap heuristic — first significant word matches (skip stop words).
      const stopWords = new Set(["INC", "LLC", "CORP", "CO", "COMPANY", "LTD", "INCORPORATED", "THE"]);
      const firstSig = (name: string | null): string => {
        if (!name) return "";
        return name.toUpperCase().split(/\s+/).find((w) => w.length >= 3 && !stopWords.has(w)) ?? "";
      };
      const myRoot = firstSig(c.legalName);
      const sibRoot = firstSig(siblingName);
      const similarName = !!myRoot && myRoot === sibRoot;

      // Same-address check would ideally compare normalized phy_street + zip,
      // but those columns aren't in the main parquet (they're in
      // carrier_identity.parquet for size reasons). We approximate via name
      // similarity here; the Critical tier requires same-building AND
      // similar-name in practice, but our test for that is name-only. The
      // Polars build_aggregates pipeline could add a sibling_same_address
      // boolean column later if we want stricter tier mapping.
      let fleetTier: "critical" | "high" | "caution" | null = null;
      if (pct >= 50 && similarName) fleetTier = "critical";
      else if (pct >= 80) fleetTier = "high";
      else if (pct >= 50) fleetTier = "caution";

      if (fleetTier) {
        // Concise detail — the broker only needs to know who the sibling is,
        // the overlap, and the read. Tier-specific copy lives in the rule
        // registry's thresholds map (for methodology pages); the detail
        // string itself stays one or two sentences.
        const sibling = siblingName ?? `DOT ${siblingDot}`;
        const sameBuilding = fleetTier === "critical" ? " out of the same building" : "";
        const read =
          fleetTier === "critical"
            ? "Same operator with two authorities."
            : fleetTier === "high"
              ? "Likely related entity — verify the sibling's audit before tendering."
              : "Worth verifying the corporate relationship before tendering.";
        const detail =
          `${pct.toFixed(0)}% of this carrier's VINs (${shared}/${c.largestSiblingTotalVins}) ` +
          `also run under DOT ${siblingDot} (${sibling})${sameBuilding}. ${read}`;
        reasons.push({ label: fleetRule.label, detail });
        chameleonSignals.push(`${pct.toFixed(0)}% VIN overlap with active DOT ${siblingDot}`);
        firedFleetSharingClusterSignal = true;
        siblingRef = { dot: siblingDot, name: siblingName };
        if (fleetTier === "critical") {
          level = "Critical";
        } else if (fleetTier === "high" && level !== "Critical") {
          level = "High";
        }
        setFleetRisk(
          fleetTier === "caution" ? 8 : 28,
          "Shared fleet with another DOT",
          `${pct.toFixed(0)}% of inspected VINs shared with active DOT ${siblingDot}.`
        );
        // Linked-authority status: a concentrated fleet shared with a sibling
        // whose authority was involuntarily REVOKED is the chameleon-successor
        // pattern (the dead carrier's trucks reappearing here) → force Critical
        // and make it the dominant fraud-score facet.
        const sStat = siblingStatusMap.get(siblingDot);
        if (sStat) {
          siblingStatusKind = sStat.kind;
          siblingRevokedDate = sStat.date;
          if (sStat.kind === "revoked") {
            level = "Critical";
            addRiskContribution(risk, {
              category: "Identity / chameleon",
              label: "Linked authority revoked",
              points: 24,
              detail: `Runs the fleet of DOT ${siblingDot}, whose authority was involuntarily revoked${
                sStat.date ? ` ${sStat.date}` : ""
              }.`,
              kind: "core",
            });
          }
        }
      }
    }
  }

  // D10d. Chameleon diffuse equipment sharing. Distinct from chameleon-shared-fleet
  // which catches concentrated two-DOT pairs — this catches operators who spread
  // the same trucks across 2+ other active DOTs. Min total VINs floor prevents
  // 1-2 VIN artifacts (e.g. a single inspection under a giant legit fleet).
  //
  // Concentration guard: require the largest single sibling to share enough of
  // this carrier's VINs to distinguish a real ring from a leasing pool. Default
  // floor is 10% — a Cincinnati carrier running Ryder rentals will have a high
  // diffuse % across 100+ siblings, but no single sibling (including Ryder)
  // holds more than a handful of VINs.
  //
  // Empirical relaxation: when this carrier already shows a chameleon-specific
  // signal (prior-revoke, recent involuntary revocation, rapid-replace, lapsed
  // BIPD, address cluster, or the all-cancel insurance pattern), drop the floor
  // to 5%. Reasoning: the 10% guard exists to suppress legit leasing
  // operations, but a carrier that's already showing other chameleon evidence
  // is clearly not a clean leasing operation. The 5% floor is still well above
  // the NOOR-style pure-rental noise floor (~4%) — see /tmp/concentration_*
  // distributions: 5% is roughly the 2-3rd percentile of real-ring carriers
  // but well above the 1st percentile of clean-diffuse leasing carriers.
  const hasChameleonSpecificSignal =
    c.priorRevokeFlag ||
    revocation.recent ||
    c.rapidReplaceFlag ||
    (c.bipdInsuranceOnFile === 0 && c.allowedToOperate === "Y") ||
    c.addressDupeOosCount >= 3 ||
    (c.insuranceDistinctPolicies24mo >= 3 && c.insuranceReplaces24mo === 0);
  const concentrationFloor = hasChameleonSpecificSignal ? 5 : 10;

  {
    const diffuseRule = getRule("chameleon-diffuse-equipment");
    const diffPct = c.diffuseVinSharePct;
    const nSibs = c.diffuseVinShareNSiblings;
    const totalVins = c.largestSiblingTotalVins;
    const topConcentration = c.largestSiblingOverlapPct;
    // Same PU-scaled VIN floor as shared-fleet: small fleets need ≥5 inspected
    // VINs, large fleets (>20 PU) need ≥30 — large carriers spread VINs across
    // DOTs legitimately (leasing / intermodal), so a thin sample (e.g. 10 VINs
    // for an 80-PU carrier) produces a meaningless diffuse %.
    const minVinsDiffuse = c.totalPowerUnits <= 20 ? 5 : 30;
    if (totalVins >= minVinsDiffuse && diffPct >= 25 && nSibs >= 2 && topConcentration >= concentrationFloor) {
      let diffuseTier: "critical" | "high" | "caution" | null = null;
      if (diffPct >= 50 && nSibs >= 5) diffuseTier = "critical";
      else if (diffPct >= 30 && nSibs >= 3) diffuseTier = "high";
      else if (diffPct >= 25 && nSibs >= 2) diffuseTier = "caution";

      if (diffuseTier) {
        const read =
          diffuseTier === "critical"
            ? "Equipment laundered across a ring of active authorities."
            : diffuseTier === "high"
              ? "Operator likely controls multiple authorities sharing the same fleet."
              : "Worth verifying which authority each truck operates under.";
        // Name the single largest of the N siblings (the only one we store) so
        // the broker has a concrete authority to check — and set siblingRef so
        // the UI can show ITS own verdict. The other N-1 siblings aren't stored
        // individually (would need a top-N pipeline column); this is the biggest.
        const topSib = c.largestSiblingDot
          ? ` Largest overlap: ${c.largestSiblingLegalName ?? `DOT ${c.largestSiblingDot}`} (DOT ${c.largestSiblingDot}).`
          : "";
        const detail =
          `${diffPct.toFixed(0)}% of this carrier's VINs also run under ${nSibs} other active DOTs. ${read}${topSib}`;
        reasons.push({ label: diffuseRule.label, detail });
        if (!siblingRef && c.largestSiblingDot) {
          siblingRef = { dot: c.largestSiblingDot, name: c.largestSiblingLegalName };
        }
        if (!firedFleetSharingClusterSignal) {
          chameleonSignals.push(`${diffPct.toFixed(0)}% diffuse VIN overlap across ${nSibs} DOTs`);
        }
        if (diffuseTier === "critical" || diffuseTier === "high") {
          // Diffuse equipment-sharing alone caps at High. Spreading VINs across
          // many DOTs is indistinguishable from a leasing / owner-operator pool
          // without corroboration, so it must NOT hard-gate Critical — that
          // over-fired on low-concentration cases (DEFUZE/SHER-TRANS at ~17-25%
          // top overlap scored 28-29 yet were forced Critical). Critical for a
          // diffuse carrier now comes only from corroboration: a revoked linked
          // sibling (below), concentrated shared-fleet + name match (other rule),
          // or the additive score reaching 80.
          if (level !== "Critical") level = "High";
        } else if (
          diffuseTier === "caution" &&
          level !== "Critical" &&
          level !== "High"
        ) {
          level = "Medium";
        }
        setFleetRisk(
          diffuseTier === "caution" ? 8 : 24,
          "Diffuse equipment sharing",
          `${diffPct.toFixed(0)}% of inspected VINs spread across ${nSibs} other active DOTs.`
        );
        // Largest of the diffuse siblings is a revoked authority → chameleon-
        // successor tell. Milder than the concentrated case (diffuse is noisier):
        // escalate to at least High rather than forcing Critical. Only when the
        // shared-fleet block above didn't already capture this sibling's status.
        if (siblingRef && siblingStatusKind === null) {
          const sStat = siblingStatusMap.get(siblingRef.dot);
          if (sStat) {
            siblingStatusKind = sStat.kind;
            siblingRevokedDate = sStat.date;
            if (sStat.kind === "revoked") {
              if (level !== "Critical") level = "High";
              addRiskContribution(risk, {
                category: "Identity / chameleon",
                label: "Linked authority revoked",
                points: 24,
                detail: `Largest linked authority DOT ${siblingRef.dot} was involuntarily revoked${
                  sStat.date ? ` ${sStat.date}` : ""
                }.`,
                kind: "core",
              });
            }
          }
        }
      }
    }
  }

  // Chameleon-pattern CLUSTER removed: the "2+ independent re-incarnation
  // signals → Critical" escalator over-called on weak combos (e.g. 2 insurance
  // cancellations + 33% diffuse VIN on an insured, established carrier → false
  // Critical). Carriers now flag on their strongest INDIVIDUAL chameleon signal
  // (shared-fleet / diffuse-equipment / address-cluster, each with PU-scaled VIN
  // floors) and on the hard regulatory/fraud signals — no loose combined escalator.
  if (enforcement.hit) {
    if (enforcement.large) {
      // Large settlement floor at High
      if (level !== "Critical") level = "High";
    } else if (level !== "Critical" && level !== "Low") {
      // Bump existing tier up one for non-large enforcement
      level = bumpUp(level);
    }
  }

  // Fold the strongest equipment-sharing signal into the carrier risk score.
  // Address clusters and revoked-linked authorities are added independently
  // above because they are different evidence, not the same VIN-overlap facet.
  if (fleetRiskContribution) {
    addRiskContribution(risk, fleetRiskContribution);
  }
  addWeakIdentityContext(risk, identitySignals);

  // Risk-score floor — the balanced bands drive the row tier only upward. Hard
  // regulatory gates can still force a row Critical even when their standalone
  // point contribution is below 80, because a legal tendering gate is not the
  // same thing as a learned fraud-proxy weight.
  const hasNonSafetyCoreRisk = risk.contributions.some(
    (f) => f.kind === "core" && f.category !== "Safety / compliance"
  );
  if (risk.score >= 80) {
    level = "Critical";
  } else if (risk.score >= 60 && level !== "Critical") {
    level = "High";
  } else if (risk.score >= 15 && hasNonSafetyCoreRisk && level === "Low") {
    level = "Medium";
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

  // Reconciliation note: when we flag a carrier but its FMCSA SMS/ISS scores
  // look clean, the two are answering different questions and it reads as a
  // contradiction without a word of explanation. This fires only when the tier
  // is driven by NON-safety signals (regulatory / insurance / identity) AND no
  // on-road safety signal is visible — the exact divergence case (e.g. a
  // chameleon shell with few inspections, or an insurance lapse).
  const smsSafetyVisible =
    hasStatSignal ||
    c.issTier === "Inspect" ||
    [
      c.unsafeDrivingAlert, c.hosAlert, c.driverFitnessAlert,
      c.controlledSubstancesAlert, c.vehicleMaintenanceAlert, c.crashIndicatorAlert,
    ].some((a) => a === "Y") ||
    [
      c.unsafeDrivingPercentile, c.hosPercentile, c.driverFitnessPercentile,
      c.vehicleMaintenancePercentile, c.crashIndicatorPercentile,
    ].some((p) => p != null && p >= 75);
  if ((level === "Critical" || level === "High") && !smsSafetyVisible) {
    reasons.push({
      label: "Why the FMCSA SMS scores look clean",
      detail:
        "This carrier is flagged on regulatory, insurance, or identity signals above — not on-road safety. " +
        "Its FMCSA SMS percentiles and ISS rank within normal range, which is common for recently-formed or " +
        "low-inspection carriers (including chameleon shells). The SMS columns rank crash and violation history " +
        "against peers; they don't capture authority, insurance, or fraud red flags.",
    });
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
    issScore: c.issScore,
    issTier: c.issTier,
    issGroup: c.issGroup,
    safetyScore: safety.score,
    safetyTier: safety.tier,
      riskScore: risk.score,
      riskTier: risk.tier,
      riskFactors: risk.factors,
      riskContributions: risk.contributions,
      siblingDot: siblingRef?.dot ?? null,
    siblingName: siblingRef?.name ?? null,
    siblingTier: null,
    siblingStatus: siblingStatusKind,
    siblingRevokedDate,
    carrier: c,
    axes: {
      crash: crash.cell,
      // UD/HOS/Driver Fitness/Vehicle Maintenance: the FMCSA-percentile cell is
      // authoritative for both display and tier (computed once, above), with the
      // raw OOS rate as the data-insufficient fallback baked into basicPctCell.
      unsafeDriving: udCell,
      hos: hosCell,
      driverOos: driverCell,
      // Controlled Substances (drug/alcohol). Sparse — "—" for carriers without
      // enough relevant inspections to be data-sufficient. Display-only.
      controlledSubstances: basicPctCell(
        c.controlledSubstancesPercentile, c.controlledSubstancesAlert,
        { status: "na", display: "—", detail: "Not data-sufficient for a Controlled Substances percentile." },
        "Controlled Substances"
      ),
      vehicleOos: vehicleCell,
      // Hazmat Compliance percentile (estimate — FMCSA doesn't publish it),
      // falling back to the hazmat OOS rate when not data-sufficient.
      hazmatOos: basicPctCell(
        c.hmCompliancePercentile, c.hmComplianceAlert, hazmat.cell, "Hazmat Compliance", true
      ),
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
  carriers: Map<number, FmcsaCarrier>,
  siblingStatusMap: Map<number, SiblingStatus> = new Map(),
  identitySignalsMap: Map<number, CarrierIdentityRiskSignals> = new Map()
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
    rows.push(scoreCarrier(c, g, siblingStatusMap, identitySignalsMap));
  }

  const SORT_ORDER: RiskLevel[] = ["Critical", "High", "Medium", "Low"];
  // Sort: tier first, then WITHIN tier by a worst-first severity composite so
  // the review queue (Critical + High) surfaces the most-actionable carriers at
  // the top. Severity = Risk score (fraud/distress, 0–100) + ISS (safety
  // inspection priority, 1–100) — a carrier extreme on EITHER axis floats up.
  // Remaining ties broken by on-road axis magnitude, then load count.
  const severity = (r: CarrierRow) => r.riskScore + (r.issScore ?? 0);
  rows.sort((a, b) => {
    const td =
      SORT_ORDER.indexOf(a.riskLevel) - SORT_ORDER.indexOf(b.riskLevel);
    if (td !== 0) return td;
    // Worst-first within tier: Risk + ISS composite.
    const sv = severity(b) - severity(a);
    if (sv !== 0) return sv;
    // Tiebreak: statistical-signal carriers, then worst axis rank / magnitude.
    if (a.sortMeta.hasStatSignal !== b.sortMeta.hasStatSignal) {
      return a.sortMeta.hasStatSignal ? -1 : 1;
    }
    const ar = b.sortMeta.worstAxisRank - a.sortMeta.worstAxisRank;
    if (ar !== 0) return ar;
    const am = b.sortMeta.worstAxisMagnitude - a.sortMeta.worstAxisMagnitude;
    if (am !== 0) return am;
    return b.loadCount - a.loadCount;
  });
  rows.forEach((r, i) => (r.rank = i + 1));

  const bySeverity: Record<Exclude<RiskLevel, "Low">, number> = {
    Critical: 0,
    High: 0,
    Medium: 0,
  };
  for (const r of rows) {
    if (r.riskLevel !== "Low") bySeverity[r.riskLevel] += 1;
  }
  const flaggedCarriers = rows.filter((r) => r.riskLevel !== "Low").length;

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
