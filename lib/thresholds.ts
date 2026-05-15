/**
 * Risk thresholds. Defaults are derived from FMCSA SMS Methodology v3.0.4 §4.6
 * (Crash Indicator BASIC P85 framework), rounded to defensible whole numbers
 * from a 1,356-carrier industry sample.
 *
 * Each carrier's statistical floor (Wilson 95% CI lower bound) is compared
 * against these cutoffs. A carrier is flagged only when we have 95% confidence
 * its true rate exceeds the cutoff — small-sample noise is excluded.
 */
export const thresholds = {
  crashPerTruck: Number(process.env.THRESHOLD_CRASH_PER_TRUCK ?? 0.2),
  driverOos: Number(process.env.THRESHOLD_DRIVER_OOS ?? 0.1),
  vehicleOos: Number(process.env.THRESHOLD_VEHICLE_OOS ?? 0.4),
  hazmatOos: Number(process.env.THRESHOLD_HAZMAT_OOS ?? 0.05),
} as const;

export const maxLoadsPerSubmission = Number(
  process.env.MAX_LOADS_PER_SUBMISSION ?? 100
);

export type Thresholds = typeof thresholds;
