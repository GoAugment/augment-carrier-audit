/**
 * Peer-group-aware percentile thresholds, loaded from the precomputed
 * national_thresholds.json that ships alongside the parquet.
 *
 * Methodology mirrors FMCSA SMS BASIC alerts:
 *   - Carriers are bucketed by fleet size into peer groups (Safety Event Group
 *     analog). A 5-truck carrier is compared against other 5-truck carriers,
 *     not against Schneider.
 *   - For each axis (Driver OOS, Vehicle OOS, Hazmat OOS, Crash measure)
 *     we compute P85/P90/P95 cutoffs *within each peer group* from the
 *     May 2026 FMCSA snapshot.
 *   - Risk tier mapping (Elevated/High/Severe = P85/P90/P95) is identical
 *     to before — the cutoffs just adjust to peer-group norms.
 *
 * Falls back to the national cutoffs when a carrier's peer group can't be
 * resolved (e.g. no power_units on file).
 */
import thresholdsJson from "@/data/national_thresholds.json";

export type PeerGroup =
  | "owner_op"
  | "small"
  | "mid"
  | "large"
  | "mega"
  | "unknown";

export interface TierCutoffs {
  /** P85 — Elevated tier (worse than 85% of peer-group carriers) */
  p85: number;
  /** P90 — High tier */
  p90: number;
  /** P95 — Severe tier */
  p95: number;
}

/**
 * Bucket a power-unit count into a peer group using industry-standard fleet
 * size classes:
 *   Owner-op  = 1 PU
 *   Small     = 2-50 PU
 *   Mid       = 51-250 PU
 *   Large     = 251-1000 PU
 *   Mega      = 1000+ PU
 */
export function peerGroupForPU(pu: number | null | undefined): PeerGroup {
  if (pu == null || pu <= 0) return "unknown";
  if (pu === 1) return "owner_op";
  if (pu <= 50) return "small";
  if (pu <= 250) return "mid";
  if (pu <= 1000) return "large";
  return "mega";
}

/** Friendly label for the peer group, used in reason text and methodology copy. */
export const peerGroupLabel: Record<PeerGroup, string> = {
  owner_op: "Owner-op (1 PU)",
  small: "Small (2-50)",
  mid: "Mid (51-250)",
  large: "Large (251-1000)",
  mega: "Mega (1000+)",
  unknown: "fleet size unknown",
};

interface PercentileBlock {
  n: number;
  p50?: number;
  p75?: number;
  p85?: number;
  p90?: number;
  p95?: number;
}

interface ThresholdsFile {
  snapshot_date: number;
  window_start: number;
  carrier_count_total: number;
  driver_oos_rate: PercentileBlock;
  vehicle_oos_rate: PercentileBlock;
  hazmat_oos_rate: PercentileBlock;
  crashes_per_truck: PercentileBlock;
  crash_measure: PercentileBlock;
  crashes_per_million_miles: PercentileBlock;
  unsafe_driving_rate: PercentileBlock;
  hos_rate: PercentileBlock;
  peer_groups: Record<
    Exclude<PeerGroup, "unknown">,
    {
      carriers_in_group: number;
      driver_oos_rate: PercentileBlock;
      vehicle_oos_rate: PercentileBlock;
      hazmat_oos_rate: PercentileBlock;
      crash_measure: PercentileBlock;
      crashes_per_million_miles: PercentileBlock;
      unsafe_driving_rate: PercentileBlock;
      hos_rate: PercentileBlock;
    }
  >;
}

const data = thresholdsJson as unknown as ThresholdsFile;

function toCutoffs(b: PercentileBlock | undefined): TierCutoffs {
  return {
    p85: b?.p85 ?? 0,
    p90: b?.p90 ?? 0,
    p95: b?.p95 ?? 0,
  };
}

export type AxisKey =
  | "driverOos"
  | "vehicleOos"
  | "hazmatOos"
  | "crashMeasure"
  | "crashesPerMillionMiles"
  | "unsafeDriving"
  | "hos";

const AXIS_TO_JSON_KEY: Record<AxisKey, keyof ThresholdsFile["peer_groups"][keyof ThresholdsFile["peer_groups"]]> = {
  driverOos: "driver_oos_rate",
  vehicleOos: "vehicle_oos_rate",
  hazmatOos: "hazmat_oos_rate",
  crashMeasure: "crash_measure",
  crashesPerMillionMiles: "crashes_per_million_miles",
  unsafeDriving: "unsafe_driving_rate",
  hos: "hos_rate",
};

const NATIONAL_FALLBACK: Record<AxisKey, PercentileBlock> = {
  driverOos: data.driver_oos_rate as PercentileBlock,
  vehicleOos: data.vehicle_oos_rate as PercentileBlock,
  hazmatOos: data.hazmat_oos_rate as PercentileBlock,
  crashMeasure: data.crash_measure as PercentileBlock,
  crashesPerMillionMiles: data.crashes_per_million_miles as PercentileBlock,
  unsafeDriving: data.unsafe_driving_rate as PercentileBlock,
  hos: data.hos_rate as PercentileBlock,
};

/** Get the {p85,p90,p95} cutoffs for a given axis and peer group. */
export function getCutoffs(axis: AxisKey, peer: PeerGroup): TierCutoffs {
  if (peer === "unknown") return toCutoffs(NATIONAL_FALLBACK[axis]);
  const group = data.peer_groups[peer];
  if (!group) return toCutoffs(NATIONAL_FALLBACK[axis]);
  return toCutoffs(group[AXIS_TO_JSON_KEY[axis]] as PercentileBlock);
}

/** National cutoffs (used by the methodology display + analytics fallback). */
export const nationalThresholds = {
  driverOos: toCutoffs(data.driver_oos_rate),
  vehicleOos: toCutoffs(data.vehicle_oos_rate),
  hazmatOos: toCutoffs(data.hazmat_oos_rate),
  crashMeasure: toCutoffs(data.crash_measure),
};

/** Minimum power units before the crash axis is considered. */
export const MIN_PU_FOR_CRASH = 5;
/** Minimum inspections before an OOS axis is considered. */
export const MIN_INSP_FOR_OOS = 3;

export const maxLoadsPerSubmission = Number(
  process.env.MAX_LOADS_PER_SUBMISSION ?? 1000
);
