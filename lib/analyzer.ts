/**
 * Carrier risk analyzer — tier-based scoring.
 *
 * Risk tiers, top-down:
 *   - Critical — binary regulatory failure (insurance lapsed, unsatisfactory
 *     rating, OOS order, not allowed to operate). Refuse to tender.
 *   - Severe   — at least one statistical axis above its P95 cutoff, OR any
 *     fatal crash on a flagged carrier.
 *   - High     — at least one axis above its P90 cutoff.
 *   - Elevated — at least one axis above its P85 cutoff.
 *
 * OOS rates (driver/vehicle/hazmat) use Wilson 95% CI lower bound so a 1-of-1
 * sample doesn't trigger. Crash rate uses the raw point estimate, gated by a
 * minimum-fleet guard (≥5 power units) unless a fatal/injury crash exists.
 */
import type { FmcsaCarrier } from "./fmcsa";
import { tierThresholds, MIN_PU_FOR_CRASH, type TierCutoffs } from "./thresholds";

export type RiskLevel = "Critical" | "Severe" | "High" | "Elevated";
export type Tier = RiskLevel | null;

export interface LoadInput {
  dot: number;
  loadId?: string;
  isHazmat?: boolean;
}

/**
 * A single reason line. The UI renders `label` bold and `detail` plain
 * so each reason scans as a category-first headline rather than prose.
 */
export interface Reason {
  label: string;
  detail: string;
}

export interface CarrierFlag {
  rank: number;
  riskLevel: RiskLevel;
  dot: number;
  carrierName: string | null;
  loadCount: number;
  loadIds: string[];
  hazmatLoadIds: string[];
  reasons: Reason[];
  hasFatalCrash: boolean;
  hasCriticalFailure: boolean;
}

export interface AuditResult {
  totalLoads: number;
  totalCarriers: number;
  flaggedCarriers: number;
  bySeverity: Record<RiskLevel, number>;
  flags: CarrierFlag[];
  thresholdsUsed: typeof tierThresholds;
  unresolvedDots: number[];
}

const TIER_ORDER: RiskLevel[] = ["Critical", "Severe", "High", "Elevated"];

const RECENT_REVOCATION_WINDOW_DAYS = 730; // 24 months
const CHRONIC_REVOCATION_THRESHOLD = 3;
const RECENT_ENFORCEMENT_WINDOW_DAYS = 730;
const ENFORCEMENT_LARGE_SETTLEMENT = 25_000; // $ — solo High trigger

function daysAgo(isoDate: string | null): number | null {
  if (!isoDate) return null;
  const d = Date.parse(isoDate.slice(0, 10));
  if (Number.isNaN(d)) return null;
  return (Date.now() - d) / (1000 * 60 * 60 * 24);
}

function bumpUp(level: Tier): Tier {
  if (level === "Elevated") return "High";
  if (level === "High") return "Severe";
  if (level === "Severe") return "Severe";
  return level;
}

function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

/** Map a value to a tier (P95→Severe, P90→High, P85→Elevated, else null). */
function statTier(value: number, cuts: TierCutoffs): Tier {
  if (value >= cuts.p95) return "Severe";
  if (value >= cuts.p90) return "High";
  if (value >= cuts.p85) return "Elevated";
  return null;
}

/** Return the more severe of two tiers (Critical > Severe > High > Elevated). */
function worse(a: Tier, b: Tier): Tier {
  if (!a) return b;
  if (!b) return a;
  return TIER_ORDER.indexOf(a) < TIER_ORDER.indexOf(b) ? a : b;
}

/** Compact label combining the tier name with its national-percentile band. */
function tierBand(tier: Tier): string {
  if (tier === "Severe") return "Severe/P95";
  if (tier === "High") return "High/P90";
  if (tier === "Elevated") return "Elevated/P85";
  return "";
}

/**
 * Unified template: shows the observed rate, the conservative statistical
 * floor (what we actually compare against the cutoff), and which percentile
 * band it landed in. The "statistical floor" wording replaces "Wilson95-low"
 * because the term is opaque to non-statisticians.
 *
 * The statistical floor is the 95% confidence lower bound on the true OOS
 * rate, calculated via Wilson's score interval. We compare *it* (not the raw
 * observed rate) against the cutoff so that a single 1-of-1 inspection doesn't
 * trigger a flag — only carriers where even the carrier-favorable estimate is
 * above the cutoff get surfaced.
 */
function fmtOosReason(
  label: string,
  oos: number,
  insp: number,
  lo: number,
  cuts: TierCutoffs,
  tier: Tier
): Reason {
  const pct = (oos / insp) * 100;
  const loPct = lo * 100;
  const cutoff =
    tier === "Severe" ? cuts.p95 : tier === "High" ? cuts.p90 : cuts.p85;
  return {
    label,
    detail: `${pct.toFixed(0)}% — ${oos} of ${insp} inspections. Statistical floor ${loPct.toFixed(0)}% exceeds the ${tierBand(tier)} cutoff (${(cutoff * 100).toFixed(0)}%).`,
  };
}

function fmtCrashReason(
  crashes: number,
  units: number,
  cpu: number,
  fatal: number,
  injury: number,
  tow: number,
  tier: Tier
): Reason {
  const sev: string[] = [];
  if (fatal > 0) sev.push(`${fatal} fatal`);
  if (injury > 0) sev.push(`${injury} injury`);
  if (tow > 0) sev.push(`${tow} tow`);
  const s = sev.length ? `, ${sev.join(", ")}` : "";
  const cuts = tierThresholds.crashPerTruck;
  const cutoff =
    tier === "Severe"
      ? cuts.p95
      : tier === "High"
        ? cuts.p90
        : tier === "Elevated"
          ? cuts.p85
          : null;
  const ratePart = cutoff
    ? `${cpu.toFixed(2)}/truck (above ${tierBand(tier)} cutoff: ${cutoff.toFixed(2)})`
    : `${cpu.toFixed(2)}/truck`;
  return {
    label: "Crashes",
    detail: `${ratePart} — ${crashes} on ${units} trucks${s}`,
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
  const flags: Omit<CarrierFlag, "rank">[] = [];

  for (const [dot, g] of byCarrier) {
    const c = carriers.get(dot);
    if (!c) {
      unresolvedDots.push(dot);
      continue;
    }
    const reasons: Reason[] = [];
    let tier: Tier = null;
    let hasCritical = false;

    // -------- CRITICAL binary checks (refuse to tender) --------
    if (
      c.bipdInsuranceRequired === "Y" &&
      c.bipdInsuranceOnFile < c.bipdRequiredAmount
    ) {
      reasons.push({
        label: "🛑 Insurance lapsed",
        detail: `$${c.bipdInsuranceOnFile}k on file vs $${c.bipdRequiredAmount}k required (BIPD liability)`,
      });
      hasCritical = true;
    }
    if (c.oosDate) {
      reasons.push({
        label: "🛑 Out-of-service order",
        detail: `Active OOS order issued ${c.oosDate}`,
      });
      hasCritical = true;
    }
    if (c.safetyRating && c.safetyRating.toUpperCase() === "UNSATISFACTORY") {
      reasons.push({
        label: "🛑 Safety rating",
        detail: "FMCSA rating: Unsatisfactory",
      });
      hasCritical = true;
    }
    if (c.allowedToOperate && c.allowedToOperate.toUpperCase() !== "Y") {
      reasons.push({
        label: "🛑 Authority",
        detail: `FMCSA not allowed to operate (allowedToOperate=${c.allowedToOperate})`,
      });
      hasCritical = true;
    }

    if (hasCritical) tier = "Critical";

    // -------- Statistical axes --------
    if (c.totalPowerUnits > 0) {
      const cpu = c.crashTotal / c.totalPowerUnits;
      // Small-fleet guard: only count if PU≥5 OR fatal/injury exists
      const passesGuard =
        c.totalPowerUnits >= MIN_PU_FOR_CRASH ||
        c.fatalCrash >= 1 ||
        c.injCrash >= 1;
      if (passesGuard && c.crashTotal >= 1) {
        const crashTier = statTier(cpu, tierThresholds.crashPerTruck);
        if (crashTier) {
          reasons.push(
            fmtCrashReason(
              c.crashTotal,
              c.totalPowerUnits,
              cpu,
              c.fatalCrash,
              c.injCrash,
              c.towawayCrash,
              crashTier
            )
          );
          tier = worse(tier, crashTier);
        }
      }
    }

    if (c.driverInsp >= 3) {
      const lo = wilsonLower(c.driverOosInsp, c.driverInsp);
      const t = statTier(lo, tierThresholds.driverOos);
      if (t) {
        reasons.push(
          fmtOosReason(
            "Driver OOS",
            c.driverOosInsp,
            c.driverInsp,
            lo,
            tierThresholds.driverOos,
            t
          )
        );
        tier = worse(tier, t);
      }
    }
    if (c.vehicleInsp >= 3) {
      const lo = wilsonLower(c.vehicleOosInsp, c.vehicleInsp);
      const t = statTier(lo, tierThresholds.vehicleOos);
      if (t) {
        reasons.push(
          fmtOosReason(
            "Vehicle OOS",
            c.vehicleOosInsp,
            c.vehicleInsp,
            lo,
            tierThresholds.vehicleOos,
            t
          )
        );
        tier = worse(tier, t);
      }
    }
    if (c.hazmatInsp >= 3) {
      const lo = wilsonLower(c.hazmatOosInsp, c.hazmatInsp);
      const t = statTier(lo, tierThresholds.hazmatOos);
      if (t) {
        reasons.push(
          fmtOosReason(
            "Hazmat OOS",
            c.hazmatOosInsp,
            c.hazmatInsp,
            lo,
            tierThresholds.hazmatOos,
            t
          )
        );
        tier = worse(tier, t);
      }
    }

    // -------- Revocation history --------
    const sinceLastInvol = daysAgo(c.mostRecentInvoluntaryDate);
    const recentRevocation =
      sinceLastInvol !== null && sinceLastInvol <= RECENT_REVOCATION_WINDOW_DAYS;
    const chronicRevocation =
      c.involuntaryRevocations >= CHRONIC_REVOCATION_THRESHOLD;

    if (recentRevocation) {
      reasons.push({
        label: "🚨 Recent revocation",
        detail: `${c.mostRecentInvoluntaryDate} — FMCSA pulled the carrier's authority within the last 24 months.`,
      });
      // Recent revocation alone → High. Combined with any statistical signal → Severe.
      const revTier: Tier = tier ? "Severe" : "High";
      tier = worse(tier, revTier);
    }
    if (chronicRevocation) {
      reasons.push({
        label: "⚠ Chronic revocations",
        detail: `${c.involuntaryRevocations} involuntary revocations on record (total ${c.revocationsTotal}).`,
      });
      // Chronic bumps the current tier up one
      tier = bumpUp(tier ?? "Elevated");
    }

    // -------- Enforcement cases --------
    const sinceLastEnf = daysAgo(c.enforcementRecentDate);
    const recentEnforcement =
      sinceLastEnf !== null &&
      sinceLastEnf <= RECENT_ENFORCEMENT_WINDOW_DAYS &&
      c.enforcementCasesCount >= 1;
    if (recentEnforcement) {
      reasons.push({
        label: "⚖ Recent enforcement",
        detail: `${c.enforcementCasesCount} closed case(s), $${c.enforcementTotalSettled.toLocaleString()} settled (latest ${c.enforcementRecentDate}).`,
      });
      if (c.enforcementTotalSettled >= ENFORCEMENT_LARGE_SETTLEMENT) {
        // Large settlement is a High on its own
        tier = worse(tier, "High");
      } else {
        // Smaller settlement bumps existing tier up one
        if (tier) tier = bumpUp(tier);
      }
    }

    if (tier) {
      flags.push({
        riskLevel: tier,
        dot,
        carrierName: c.legalName,
        loadCount: g.loadIds.size,
        loadIds: Array.from(g.loadIds).sort(),
        hazmatLoadIds: Array.from(g.hazmatLoadIds).sort(),
        reasons,
        hasFatalCrash: c.fatalCrash > 0,
        hasCriticalFailure: hasCritical,
      });
    }
  }

  flags.sort((a, b) => {
    const td = TIER_ORDER.indexOf(a.riskLevel) - TIER_ORDER.indexOf(b.riskLevel);
    if (td !== 0) return td;
    return b.loadCount - a.loadCount;
  });

  const ranked: CarrierFlag[] = flags.map((f, i) => ({ rank: i + 1, ...f }));
  const bySeverity: Record<RiskLevel, number> = {
    Critical: 0,
    Severe: 0,
    High: 0,
    Elevated: 0,
  };
  for (const f of ranked) bySeverity[f.riskLevel] += 1;

  return {
    totalLoads: loads.length,
    totalCarriers: byCarrier.size,
    flaggedCarriers: ranked.length,
    bySeverity,
    flags: ranked,
    thresholdsUsed: tierThresholds,
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
