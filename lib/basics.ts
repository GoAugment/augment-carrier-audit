import type { FmcsaCarrier } from "./fmcsa";

/**
 * The 7 FMCSA SMS BASICs, in one place.
 *
 * Single source of truth because two surfaces publish this block — the email/page
 * check and the audit API — and a divergence between them is exactly the kind of
 * thing nobody notices until a customer diffs the two.
 *
 * IMPORTANT, and worth stating wherever this is documented: FMCSA publishes NO
 * BASIC percentile for any carrier. The FAST Act removed public percentile
 * display; their SMS page shows the measure and the intervention threshold only.
 * These percentiles are OUR ranking of FMCSA's measures, computed to their
 * published methodology (SMS Methodology v3.20 — all 8 safety-event-group tables
 * verified to match, Aug 2026). `alert` is FMCSA's own intervention flag.
 *
 * `percentile` is null far more often than people expect, and that is correct:
 * a BASIC only gets one when the carrier clears FMCSA's data-sufficiency bar
 * (enough relevant inspections, or >=2 crashes with >=1 recent for Crash
 * Indicator). Typical carriers populate 2-3 of the 7. Null means "not rated",
 * NOT "clean" — consumers must not render it as zero.
 */
export interface BasicScore {
  /** Stable machine identifier — safe to key on in a consumer contract. */
  key:
    | "unsafe_driving"
    | "hos_compliance"
    | "driver_fitness"
    | "controlled_substances"
    | "vehicle_maintenance"
    | "crash_indicator"
    | "hm_compliance";
  /** Human label as shown in our UI. Display only; do not key on it. */
  name: string;
  /** 0-100, higher = worse. Null when FMCSA data sufficiency isn't met. */
  percentile: number | null;
  /** FMCSA's intervention-threshold flag for this BASIC. */
  alert: boolean;
  /** True when FMCSA does not publish this BASIC at all, so the measure as well
   *  as the percentile is ours (computed from their inputs). */
  derived: boolean;
}

export function basicsOf(c: FmcsaCarrier): BasicScore[] {
  return [
    {
      key: "unsafe_driving",
      name: "Unsafe Driving",
      percentile: c.unsafeDrivingPercentile,
      alert: c.unsafeDrivingAlert === "Y",
      derived: false,
    },
    {
      key: "hos_compliance",
      name: "HOS Compliance",
      percentile: c.hosPercentile,
      alert: c.hosAlert === "Y",
      derived: false,
    },
    {
      key: "driver_fitness",
      name: "Driver Fitness",
      percentile: c.driverFitnessPercentile,
      alert: c.driverFitnessAlert === "Y",
      derived: false,
    },
    {
      key: "controlled_substances",
      name: "Controlled Subs",
      percentile: c.controlledSubstancesPercentile,
      alert: c.controlledSubstancesAlert === "Y",
      derived: false,
    },
    {
      key: "vehicle_maintenance",
      name: "Vehicle Maint.",
      percentile: c.vehicleMaintenancePercentile,
      alert: c.vehicleMaintenanceAlert === "Y",
      derived: false,
    },
    // FMCSA hides these two entirely, so we compute the measure as well as the
    // rank: Crash Indicator from their Severity_Weight x Time_Weight columns over
    // the scraped Avg PU x UF, HM Compliance from the violation file.
    {
      key: "crash_indicator",
      name: "Crash Indicator",
      percentile: c.crashIndicatorPercentile,
      alert: c.crashIndicatorAlert === "Y",
      derived: true,
    },
    {
      key: "hm_compliance",
      name: "Hazmat",
      percentile: c.hmCompliancePercentile,
      alert: c.hmComplianceAlert === "Y",
      derived: true,
    },
  ];
}
