/**
 * Carrier risk analyzer. Port of the Python script from the T1/Zeal audit work.
 *
 * Methodology:
 * - For each safety axis (crash rate, driver OOS, vehicle OOS, hazmat OOS),
 *   compute the Wilson 95% CI lower bound for the carrier's observed rate.
 * - Flag only if the CI lower bound exceeds the threshold — small-sample
 *   noise (e.g., 1-of-1 inspections) does not trigger.
 * - Score = sum of (CI lower bound / threshold) across flagged axes, plus a
 *   bonus when 2+ axes are flagged.
 * - Risk label: Severe (>=2x), High (>=1.5x), Elevated (<1.5x).
 */
import type { FmcsaCarrier } from "./fmcsa";
import { thresholds } from "./thresholds";

export type RiskLevel = "Severe" | "High" | "Elevated";

export interface LoadInput {
  dot: number;
  loadId?: string;
  isHazmat?: boolean;
}

export interface CarrierFlag {
  rank: number;
  riskLevel: RiskLevel;
  riskScore: number;
  dot: number;
  carrierName: string | null;
  loadCount: number;
  loadIds: string[];
  hazmatLoadIds: string[];
  reasons: string[];
  hasFatalCrash: boolean;
}

export interface AuditResult {
  totalLoads: number;
  totalCarriers: number;
  flaggedCarriers: number;
  bySeverity: Record<RiskLevel, number>;
  flags: CarrierFlag[];
  thresholdsUsed: typeof thresholds;
  unresolvedDots: number[]; // DOTs we couldn't find in FMCSA
}

function wilsonLower(k: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

function riskLabel(score: number): RiskLevel {
  if (score >= 2.0) return "Severe";
  if (score >= 1.5) return "High";
  return "Elevated";
}

function fmtCrash(
  crashes: number,
  units: number,
  cpu: number,
  fatal: number,
  injury: number,
  tow: number,
  p85: number
): string {
  const sev: string[] = [];
  if (fatal > 0) sev.push(`${fatal} fatal`);
  if (injury > 0) sev.push(`${injury} injury`);
  if (tow > 0) sev.push(`${tow} tow`);
  const s = sev.length ? ` (${sev.join(", ")})` : "";
  return `Crashes: ${cpu.toFixed(2)}/truck (cutoff ${p85.toFixed(2)}) — ${crashes} crashes on ${units} trucks${s}`;
}

function fmtOos(label: string, oos: number, insp: number, p85: number): string {
  const pct = (oos / insp) * 100;
  return `${label}: ${pct.toFixed(0)}% (cutoff ${(p85 * 100).toFixed(0)}%) — ${oos} of ${insp} inspections`;
}

export function analyze(
  loads: LoadInput[],
  carriers: Map<number, FmcsaCarrier>
): AuditResult {
  // Group loads by carrier (DOT)
  const byCarrier = new Map<number, { loadIds: Set<string>; hazmatLoadIds: Set<string> }>();
  for (let i = 0; i < loads.length; i++) {
    const load = loads[i];
    const id = load.loadId ?? `row-${i + 1}`;
    const g = byCarrier.get(load.dot) ?? { loadIds: new Set(), hazmatLoadIds: new Set() };
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
    const reasons: string[] = [];
    let score = 0;
    let axes = 0;

    const units = c.totalPowerUnits;
    const crashes = c.crashTotal;
    if (units > 0) {
      const cpu = crashes / units;
      const lo = wilsonLower(crashes, units);
      if (lo >= thresholds.crashPerTruck) {
        score += lo / thresholds.crashPerTruck;
        axes += 1;
        reasons.push(
          fmtCrash(crashes, units, cpu, c.fatalCrash, c.injCrash, c.towawayCrash, thresholds.crashPerTruck)
        );
      }
    }

    if (c.driverInsp >= 3) {
      const lo = wilsonLower(c.driverOosInsp, c.driverInsp);
      if (lo >= thresholds.driverOos) {
        score += lo / thresholds.driverOos;
        axes += 1;
        reasons.push(fmtOos("Driver OOS", c.driverOosInsp, c.driverInsp, thresholds.driverOos));
      }
    }
    if (c.vehicleInsp >= 3) {
      const lo = wilsonLower(c.vehicleOosInsp, c.vehicleInsp);
      if (lo >= thresholds.vehicleOos) {
        score += lo / thresholds.vehicleOos;
        axes += 1;
        reasons.push(fmtOos("Vehicle OOS", c.vehicleOosInsp, c.vehicleInsp, thresholds.vehicleOos));
      }
    }
    if (c.hazmatInsp >= 3) {
      const lo = wilsonLower(c.hazmatOosInsp, c.hazmatInsp);
      if (lo >= thresholds.hazmatOos) {
        score += lo / thresholds.hazmatOos;
        axes += 1;
        reasons.push(fmtOos("Hazmat OOS", c.hazmatOosInsp, c.hazmatInsp, thresholds.hazmatOos));
      }
    }
    // PHMSA registration is load-conditional — flagged for hazmat loads as a
    // manual-check reminder (we can't programmatically verify in serverless).
    if (g.hazmatLoadIds.size > 0) {
      reasons.push(
        "⚠ Hazmat load — verify PHMSA registration manually at portal.phmsa.dot.gov"
      );
    }
    if (axes >= 2) score += axes;

    if (score > 0) {
      flags.push({
        riskLevel: riskLabel(score),
        riskScore: score,
        dot,
        carrierName: c.legalName,
        loadCount: g.loadIds.size,
        loadIds: Array.from(g.loadIds).sort(),
        hazmatLoadIds: Array.from(g.hazmatLoadIds).sort(),
        reasons,
        hasFatalCrash: c.fatalCrash > 0,
      });
    }
  }

  flags.sort((a, b) => b.riskScore - a.riskScore);
  const ranked: CarrierFlag[] = flags.map((f, i) => ({ rank: i + 1, ...f }));
  const bySeverity: Record<RiskLevel, number> = { Severe: 0, High: 0, Elevated: 0 };
  for (const f of ranked) bySeverity[f.riskLevel] += 1;

  return {
    totalLoads: loads.length,
    totalCarriers: byCarrier.size,
    flaggedCarriers: ranked.length,
    bySeverity,
    flags: ranked,
    thresholdsUsed: thresholds,
    unresolvedDots,
  };
}

/**
 * Parse the user's pasted input. One load per line. Tolerates several formats:
 *   3621624
 *   3621624, INF31459-18990
 *   3621624 INF31459-18990 HAZMAT
 *   3621624,INF31459-18990,HAZMAT
 */
export function parseInput(raw: string): { loads: LoadInput[]; errors: string[] } {
  const loads: LoadInput[] = [];
  const errors: string[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (line.startsWith("#")) continue; // comment
    const tokens = line
      .split(/[,\s\t]+/)
      .map((t) => t.trim())
      .filter(Boolean);
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
