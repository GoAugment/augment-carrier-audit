/**
 * Tier-based thresholds for the four statistical safety axes. Each axis has
 * three cutoffs (P85, P90, P95) that map to risk tiers:
 *
 *   - P85 → Elevated (worse than 85% of US carriers — operator awareness)
 *   - P90 → High     (worse than 90% — needs documented override)
 *   - P95 → Severe   (worse than 95% — refuse unless extraordinary reason)
 *
 * OOS-rate percentiles are derived from the May 2026 FMCSA SMS bulk snapshot
 * (2.08M carriers, 214K with ≥3 driver inspections, 155K with ≥3 vehicle).
 *
 * Crashes/truck does NOT use percentile cutoffs because the distribution is
 * zero-dominated (P90 of all US carriers = 0 crashes/24mo). Instead we use
 * fixed thresholds that still correspond to ~top 1% of the population:
 *   - 0.10 → meaningful concern (Elevated)
 *   - 0.20 → severe concern    (High)
 *   - 0.40 → catastrophic       (Severe)
 *   - any fatal crash          → Severe (override)
 */

export interface TierCutoffs {
  /** P85 — Elevated tier (worse than 85% of US carriers) */
  p85: number;
  /** P90 — High tier (worse than 90% of US carriers) */
  p90: number;
  /** P95 — Severe tier (worse than 95% of US carriers) */
  p95: number;
}

export const tierThresholds = {
  driverOos: { p85: 0.25, p90: 0.33, p95: 0.4 } satisfies TierCutoffs,
  vehicleOos: { p85: 0.5, p90: 0.6, p95: 0.67 } satisfies TierCutoffs,
  hazmatOos: { p85: 0.06, p90: 0.12, p95: 0.24 } satisfies TierCutoffs,
  crashPerTruck: { p85: 0.1, p90: 0.2, p95: 0.4 } satisfies TierCutoffs,
} as const;

/** Minimum power units before a non-fatal crash rate counts (small-fleet guard). */
export const MIN_PU_FOR_CRASH = 5;

export const maxLoadsPerSubmission = Number(
  process.env.MAX_LOADS_PER_SUBMISSION ?? 1000
);

export type TierThresholds = typeof tierThresholds;
