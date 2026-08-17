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
  /** 0-100, higher = worse, rounded to 1 decimal. Null when FMCSA data
   *  sufficiency isn't met. Rounded for readability only — our own threshold
   *  gates use the unrounded value, and we round HALF-UP rather than ceiling on
   *  purpose: ceiling would turn 89.96 into 90 and make a carrier look like it
   *  cleared the FAST Act >=90th bar when it hadn't. */
  percentile: number | null;
  /**
   * FMCSA's own intervention-threshold flag: true = FMCSA would prioritise this
   * carrier for intervention on this BASIC.
   *
   * NOT derivable from `percentile`, which is why it is worth a field. The
   * threshold differs per BASIC — measured on this vintage, alert cuts in at 65
   * for Unsafe Driving / HOS / Crash Indicator but 80 for Driver Fitness /
   * Controlled Substances / Vehicle Maintenance — and drops further for
   * passenger and hazmat carriers. So 70 is an alert on Unsafe Driving and not
   * on Vehicle Maintenance. Without this field a consumer has to carry FMCSA's
   * threshold table themselves and keep it current.
   */
  alert: boolean;
}

/** Half-up to 1dp; null stays null. Never ceiling — see BasicScore.percentile. */
function round1(v: number | null | undefined): number | null {
  return v == null ? null : Math.round(v * 10) / 10;
}

export function basicsOf(c: FmcsaCarrier): BasicScore[] {
  return [
    {
      key: "unsafe_driving",
      name: "Unsafe Driving",
      percentile: round1(c.unsafeDrivingPercentile),
      alert: c.unsafeDrivingAlert === "Y",
    },
    {
      key: "hos_compliance",
      name: "HOS Compliance",
      percentile: round1(c.hosPercentile),
      alert: c.hosAlert === "Y",
    },
    {
      key: "driver_fitness",
      name: "Driver Fitness",
      percentile: round1(c.driverFitnessPercentile),
      alert: c.driverFitnessAlert === "Y",
    },
    {
      key: "controlled_substances",
      name: "Controlled Subs",
      percentile: round1(c.controlledSubstancesPercentile),
      alert: c.controlledSubstancesAlert === "Y",
    },
    {
      key: "vehicle_maintenance",
      name: "Vehicle Maint.",
      percentile: round1(c.vehicleMaintenancePercentile),
      alert: c.vehicleMaintenanceAlert === "Y",
    },
    // NOTE: FMCSA publishes NEITHER of the next two at all, so for these the
    // measure is ours as well as the rank — Crash Indicator from their
    // Severity_Weight x Time_Weight columns over the scraped Avg PU x UF, HM
    // Compliance from the violation file. That used to be a `derived: true` flag
    // on every response; it is constant per key, so it belongs here and in the
    // API docs rather than repeated in every payload.
    {
      key: "crash_indicator",
      name: "Crash Indicator",
      percentile: round1(c.crashIndicatorPercentile),
      alert: c.crashIndicatorAlert === "Y",
    },
    {
      key: "hm_compliance",
      name: "Hazmat",
      percentile: round1(c.hmCompliancePercentile),
      alert: c.hmComplianceAlert === "Y",
    },
  ];
}
