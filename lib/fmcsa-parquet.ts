/**
 * Parquet-backed FMCSA lookup. Reads from the bundled snapshot of FMCSA's
 * public bulk files (Census, Crashes, Inspections, Carrier authority,
 * Revocations, Enforcement) refreshed monthly.
 */
import type { Database } from "duckdb";

import type { FmcsaCarrier } from "./fmcsa";
import { getAggregatesParquetPath } from "./parquet-source";

// Lazy-load duckdb so Next.js doesn't try to bind the native binary during
// the build container's static-page-data collection (Vercel's build image
// is missing GLIBCXX_3.4.30 that duckdb 1.4 requires).
let _db: Database | null = null;

function db(): Database {
  if (_db) return _db;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const duckdb = require("duckdb");
  _db = new duckdb.Database(":memory:");
  return _db!;
}

function runQuery<T>(sql: string, params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    db().all(sql, ...params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as T[]);
    });
  });
}

interface ParquetRow {
  DOT_NUMBER: number | bigint;
  LEGAL_NAME: string | null;
  DBA_NAME: string | null;
  mc_number: string | null;
  additional_dockets: string | null;
  operation_classification: string | null;
  business_org_type: string | null;
  has_property_authority: boolean | null;
  has_passenger_authority: boolean | null;
  has_hhg_authority: boolean | null;
  has_private_authority: boolean | null;
  has_enterprise_authority: boolean | null;
  has_broker_authority: boolean | null;
  status_code: string | null;
  safety_rating: string | null;
  safety_rating_date: string | null;
  power_units: number | bigint | null;
  drivers: number | bigint | null;
  driver_inspections_24mo: number | bigint | null;
  driver_oos_24mo: number | bigint | null;
  vehicle_inspections_24mo: number | bigint | null;
  vehicle_oos_24mo: number | bigint | null;
  hazmat_inspections_24mo: number | bigint | null;
  hazmat_oos_24mo: number | bigint | null;
  crashes_24mo: number | bigint | null;
  fatal_crashes_24mo: number | bigint | null;
  injury_crashes_24mo: number | bigint | null;
  tow_crashes_24mo: number | bigint | null;
  bipd_insurance_required: string | null;
  bipd_insurance_on_file: number | null;
  bipd_required_amount: number | null;
  bipd_insurer_name: string | null;
  bipd_policy_effective_date: string | null;
  cargo_insurer_name: string | null;
  revocations_total: number | bigint | null;
  involuntary_revocations: number | bigint | null;
  most_recent_involuntary_date: string | null;
  enforcement_cases_count: number | bigint | null;
  enforcement_total_settled: number | bigint | null;
  enforcement_recent_date: string | null;
  insurance_cancellations_24mo: number | bigint | null;
  most_recent_cancel_date: string | null;
  most_recent_cancel_reason: string | null;
  rapid_replace_flag: boolean | null;
  crash_measure: number | null;
  peer_group: string | null;
  crashes_per_million_miles: number | null;
  annual_mileage: number | bigint | null;
  unsafe_driving_violations_24mo: number | bigint | null;
  hos_violations_24mo: number | bigint | null;
  cargo_on_file_flag: boolean | null;
  cargo_required_flag: boolean | null;
  physical_state: string | null;
  phy_zip: string | null;
  // Identity / contact columns dropped from parquet — see FmcsaCarrier for re-enable path.
  // phy_street: string | null;
  // phy_city: string | null;
  // phone: string | null;
  // email_address: string | null;
  // company_officer_1: string | null;
  // company_officer_2: string | null;
  /** Parquet stores already-formatted YYYY-MM-DD string. */
  dot_add_date: string | null;
  mcs150_date: string | null;
  review_date: string | null;
  review_type: string | null;
  prior_revoke_flag: boolean | null;
  prior_revoke_dot_number: number | bigint | null;
  recordable_crash_rate: number | null;
  fleet_size_flag: string | null;
  inspections_per_pu: number | null;
  unsafe_driving_measure: number | null;
  hos_measure: number | null;
  driver_fitness_measure: number | null;
  controlled_substances_measure: number | null;
  vehicle_maintenance_measure: number | null;
  unsafe_driving_percentile: number | null;
  hos_percentile: number | null;
  driver_fitness_percentile: number | null;
  controlled_substances_percentile: number | null;
  vehicle_maintenance_percentile: number | null;
  unsafe_driving_alert: string | null;
  hos_alert: string | null;
  driver_fitness_alert: string | null;
  controlled_substances_alert: string | null;
  vehicle_maintenance_alert: string | null;
  // Chameleon-cluster counters from Company Census self-join. Counts OTHER
  // DOTs sharing this carrier's normalized physical address, split by status.
  // See lib/rules/index.ts > chameleon-address-cluster for definition.
  address_dupe_active_count: number | bigint | null;
  address_dupe_oos_count: number | bigint | null;
  // Fleet-sharing signal from inspection-file VIN cross-DOT join. For each
  // carrier, the OTHER active DOT that shares the most VINs in inspections.
  // See lib/rules/index.ts > chameleon-shared-fleet for definition.
  largest_sibling_dot: number | bigint | null;
  largest_sibling_legal_name: string | null;
  largest_sibling_shared_vins: number | bigint | null;
  largest_sibling_total_vins: number | bigint | null;
  largest_sibling_overlap_pct: number | null;
  diffuse_vin_share_pct: number | null;
  diffuse_vin_share_n_siblings: number | bigint | null;
  insurance_replaces_24mo: number | bigint | null;
  insurance_distinct_policies_24mo: number | bigint | null;
  crash_indicator_measure: number | null;
  crash_indicator_percentile: number | null;
  crash_indicator_alert: string | null;
  crash_indicator_seg_group: string | null;
  hm_compliance_percentile: number | null;
  hm_compliance_alert: string | null;
  pu_vins_inspected: number | bigint | null;
  fast_act_high_risk: boolean | null;
  fast_act_high_risk_n: number | bigint | null;
  fast_act_high_risk_basics: string | null;
  iss_score: number | bigint | null;
  iss_tier: string | null;
  iss_group: string | null;
  has_serious_violation: boolean | null;
  serious_violation_count: number | bigint | null;
  serious_violation_basics: string | null;
  bipd_imminent_lapse: boolean | null;
  bipd_days_to_lapse: number | bigint | null;
  bipd_pending_cancel_date: string | null;
}

function asInt(v: number | bigint | null | undefined): number {
  if (v == null) return 0;
  if (typeof v === "bigint") return Number(v);
  return Math.floor(v);
}

/** Normalize a DuckDB DATE (returned as a JS Date) or string to YYYY-MM-DD. */
function asDateStr(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v);
  return s.length >= 10 ? s.slice(0, 10) : s;
}


function rowToCarrier(r: ParquetRow): FmcsaCarrier {
  const status = (r.status_code ?? "").toUpperCase();
  const allowedToOperate = status === "A" ? "Y" : status ? "N" : null;
  return {
    dotNumber: asInt(r.DOT_NUMBER),
    legalName: r.LEGAL_NAME,
    dbaName: r.DBA_NAME,
    mcNumber: r.mc_number,
    additionalDockets: r.additional_dockets,
    operationClassification: r.operation_classification,
    businessOrgType: r.business_org_type,
    hasPropertyAuthority: r.has_property_authority === true,
    hasPassengerAuthority: r.has_passenger_authority === true,
    hasHhgAuthority: r.has_hhg_authority === true,
    hasPrivateAuthority: r.has_private_authority === true,
    hasEnterpriseAuthority: r.has_enterprise_authority === true,
    hasBrokerAuthority: r.has_broker_authority === true,
    allowedToOperate,
    statusCode: r.status_code,
    safetyRating: r.safety_rating,
    safetyRatingDate: r.safety_rating_date,
    oosDate: null,
    totalDrivers: asInt(r.drivers),
    totalPowerUnits: asInt(r.power_units),
    driverInsp: asInt(r.driver_inspections_24mo),
    driverOosInsp: asInt(r.driver_oos_24mo),
    vehicleInsp: asInt(r.vehicle_inspections_24mo),
    vehicleOosInsp: asInt(r.vehicle_oos_24mo),
    hazmatInsp: asInt(r.hazmat_inspections_24mo),
    hazmatOosInsp: asInt(r.hazmat_oos_24mo),
    crashTotal: asInt(r.crashes_24mo),
    fatalCrash: asInt(r.fatal_crashes_24mo),
    injCrash: asInt(r.injury_crashes_24mo),
    towawayCrash: asInt(r.tow_crashes_24mo),
    bipdInsuranceRequired: r.bipd_insurance_required,
    bipdInsuranceOnFile: asInt(r.bipd_insurance_on_file),
    bipdRequiredAmount: asInt(r.bipd_required_amount),
    bipdInsurerName: r.bipd_insurer_name,
    bipdPolicyEffectiveDate: r.bipd_policy_effective_date,
    cargoInsurerName: r.cargo_insurer_name,
    mcs150Mileage: 0,
    mcs150Date: r.mcs150_date,
    revocationsTotal: asInt(r.revocations_total),
    involuntaryRevocations: asInt(r.involuntary_revocations),
    mostRecentInvoluntaryDate: r.most_recent_involuntary_date,
    enforcementCasesCount: asInt(r.enforcement_cases_count),
    enforcementTotalSettled: asInt(r.enforcement_total_settled),
    enforcementRecentDate: r.enforcement_recent_date,
    insuranceCancellations24mo: asInt(r.insurance_cancellations_24mo),
    mostRecentCancelDate: r.most_recent_cancel_date,
    mostRecentCancelReason: r.most_recent_cancel_reason,
    rapidReplaceFlag: r.rapid_replace_flag === true,
    crashMeasure: r.crash_measure ?? 0,
    crashesPerMillionMiles: r.crashes_per_million_miles,
    annualMileage: asInt(r.annual_mileage),
    peerGroup: r.peer_group ?? "unknown",
    unsafeDrivingViolations: asInt(r.unsafe_driving_violations_24mo),
    hosViolations: asInt(r.hos_violations_24mo),
    cargoInsuranceOnFile: r.cargo_on_file_flag === true,
    cargoInsuranceRequired: r.cargo_required_flag === true,
    physicalState: r.physical_state,
    physicalZip: r.phy_zip ?? null,
    // Identity/contact fields dropped from parquet:
    // phyStreet: r.phy_street, phyCity: r.phy_city, phyZip: r.phy_zip,
    // phone: r.phone, emailAddress: r.email_address,
    // companyOfficer1: r.company_officer_1, companyOfficer2: r.company_officer_2,
    dotAddDate: r.dot_add_date,
    reviewDate: r.review_date,
    reviewType: r.review_type,
    priorRevokeFlag: r.prior_revoke_flag === true,
    priorRevokeDotNumber: r.prior_revoke_dot_number == null ? null : asInt(r.prior_revoke_dot_number),
    recordableCrashRate: r.recordable_crash_rate,
    fleetSizeFlag: r.fleet_size_flag,
    inspectionsPerPu: r.inspections_per_pu,
    unsafeDrivingMeasure: r.unsafe_driving_measure,
    hosMeasure: r.hos_measure,
    unsafeDrivingPercentile: r.unsafe_driving_percentile,
    hosPercentile: r.hos_percentile,
    driverFitnessPercentile: r.driver_fitness_percentile,
    controlledSubstancesPercentile: r.controlled_substances_percentile,
    vehicleMaintenancePercentile: r.vehicle_maintenance_percentile,
    driverFitnessMeasure: r.driver_fitness_measure,
    controlledSubstancesMeasure: r.controlled_substances_measure,
    vehicleMaintenanceMeasure: r.vehicle_maintenance_measure,
    unsafeDrivingAlert: r.unsafe_driving_alert,
    hosAlert: r.hos_alert,
    driverFitnessAlert: r.driver_fitness_alert,
    controlledSubstancesAlert: r.controlled_substances_alert,
    vehicleMaintenanceAlert: r.vehicle_maintenance_alert,
    addressDupeActiveCount: asInt(r.address_dupe_active_count),
    addressDupeOosCount: asInt(r.address_dupe_oos_count),
    largestSiblingDot: r.largest_sibling_dot == null ? null : asInt(r.largest_sibling_dot),
    largestSiblingLegalName: r.largest_sibling_legal_name,
    largestSiblingSharedVins: asInt(r.largest_sibling_shared_vins),
    largestSiblingTotalVins: asInt(r.largest_sibling_total_vins),
    largestSiblingOverlapPct: r.largest_sibling_overlap_pct ?? 0,
    diffuseVinSharePct: r.diffuse_vin_share_pct ?? 0,
    diffuseVinShareNSiblings: asInt(r.diffuse_vin_share_n_siblings),
    insuranceReplaces24mo: asInt(r.insurance_replaces_24mo),
    insuranceDistinctPolicies24mo: asInt(r.insurance_distinct_policies_24mo),
    fastActHighRisk: r.fast_act_high_risk === true,
    fastActHighRiskN: asInt(r.fast_act_high_risk_n),
    fastActHighRiskBasics: r.fast_act_high_risk_basics,
    issScore: r.iss_score == null ? null : asInt(r.iss_score),
    issTier: r.iss_tier,
    issGroup: r.iss_group,
    hasSeriousViolation: r.has_serious_violation === true,
    seriousViolationCount: asInt(r.serious_violation_count),
    seriousViolationBasics: r.serious_violation_basics,
    bipdImminentLapse: r.bipd_imminent_lapse === true,
    bipdDaysToLapse: r.bipd_days_to_lapse == null ? null : asInt(r.bipd_days_to_lapse),
    // DuckDB returns DATE as a JS Date; normalize to a plain YYYY-MM-DD string.
    bipdPendingCancelDate: asDateStr(r.bipd_pending_cancel_date),
    // Estimated Crash Indicator BASIC. FMCSA does not publish CI percentiles;
    // these are our reproduction (severity/time-weighted crashes ÷ Avg-PU×UF),
    // populated only for the ~21k crash-sufficient carriers we have the scraped
    // Avg-PU/utilization factor for. Null elsewhere → the crash axis falls back
    // to crashes-per-million-miles.
    crashIndicatorPercentile: r.crash_indicator_percentile,
    crashIndicatorAlert: r.crash_indicator_alert,
    // Estimated Hazmat Compliance BASIC (FMCSA doesn't publish it either).
    // Populated only for carriers with enough hazmat inspections; null elsewhere.
    hmCompliancePercentile: r.hm_compliance_percentile,
    hmComplianceAlert: r.hm_compliance_alert,
    // Distinct power-unit VINs seen in inspections — phantom-fleet / rented-
    // authority signal (compared against reported power units in the analyzer).
    puVinsInspected: asInt(r.pu_vins_inspected),
  };
}

/**
 * Resolve a carrier's DOT from their MC number. Used by the email-check
 * pipeline when an inbound carrier email references only "MC-133655" without
 * a DOT — common in small-carrier outreach. Normalizes MC to digits-only so
 * "MC-133655", "MC 133655", "MC#133655" all match the same record.
 *
 * Returns null when no carrier has that MC on file. Returns the first match
 * when (rarely) multiple DOTs share an MC — usually that's an
 * authority-transfer artifact and the most-recent active carrier is the
 * intended match.
 */
export async function fetchDotByMc(mc: string): Promise<number | null> {
  const digits = mc.replace(/\D/g, "");
  if (!digits) return null;
  const parquet = await getAggregatesParquetPath();
  const sql = `
    SELECT DOT_NUMBER FROM read_parquet('${parquet.replace(/'/g, "''")}')
    WHERE REGEXP_REPLACE(mc_number, '[^0-9]', '', 'g') = ?
    LIMIT 1
  `;
  const rows = await runQuery<{ DOT_NUMBER: number | bigint }>(sql, [digits]);
  if (rows.length === 0) return null;
  return asInt(rows[0].DOT_NUMBER);
}

export async function fetchCarriersFromParquet(
  dots: number[]
): Promise<Map<number, FmcsaCarrier>> {
  const unique = Array.from(new Set(dots));
  const out = new Map<number, FmcsaCarrier>();
  if (unique.length === 0) return out;

  const placeholders = unique.map(() => "?").join(",");
  const parquet = await getAggregatesParquetPath();
  const sql = `
    SELECT
      DOT_NUMBER, LEGAL_NAME, DBA_NAME,
      mc_number, additional_dockets, operation_classification, business_org_type,
      has_property_authority, has_passenger_authority, has_hhg_authority,
      has_private_authority, has_enterprise_authority, has_broker_authority,
      status_code, safety_rating, safety_rating_date,
      power_units, drivers,
      driver_inspections_24mo, driver_oos_24mo,
      vehicle_inspections_24mo, vehicle_oos_24mo,
      hazmat_inspections_24mo, hazmat_oos_24mo,
      crashes_24mo, fatal_crashes_24mo, injury_crashes_24mo, tow_crashes_24mo,
      bipd_insurance_required, bipd_insurance_on_file, bipd_required_amount,
      bipd_insurer_name, bipd_policy_effective_date, cargo_insurer_name,
      revocations_total, involuntary_revocations, most_recent_involuntary_date,
      enforcement_cases_count, enforcement_total_settled, enforcement_recent_date,
      insurance_cancellations_24mo, most_recent_cancel_date, most_recent_cancel_reason,
      rapid_replace_flag,
      crash_measure, peer_group, crashes_per_million_miles, annual_mileage,
      unsafe_driving_violations_24mo, hos_violations_24mo,
      cargo_on_file_flag, cargo_required_flag,
      physical_state, phy_zip,
      -- Identity/contact columns omitted to keep the parquet under 100MB:
      -- phy_street, phy_city, phone, email_address,
      -- company_officer_1, company_officer_2
      dot_add_date, mcs150_date, review_date, review_type,
      prior_revoke_flag, prior_revoke_dot_number, recordable_crash_rate,
      fleet_size_flag, inspections_per_pu,
      unsafe_driving_measure, hos_measure, driver_fitness_measure,
      controlled_substances_measure, vehicle_maintenance_measure,
      unsafe_driving_percentile, hos_percentile, driver_fitness_percentile,
      controlled_substances_percentile, vehicle_maintenance_percentile,
      unsafe_driving_alert, hos_alert, driver_fitness_alert,
      controlled_substances_alert, vehicle_maintenance_alert,
      address_dupe_active_count, address_dupe_oos_count,
      largest_sibling_dot, largest_sibling_legal_name,
      largest_sibling_shared_vins, largest_sibling_total_vins,
      largest_sibling_overlap_pct,
      diffuse_vin_share_pct, diffuse_vin_share_n_siblings,
      insurance_replaces_24mo, insurance_distinct_policies_24mo,
      fast_act_high_risk, fast_act_high_risk_n, fast_act_high_risk_basics,
      iss_score, iss_tier, iss_group,
      has_serious_violation, serious_violation_count, serious_violation_basics,
      bipd_imminent_lapse, bipd_days_to_lapse, bipd_pending_cancel_date,
      crash_indicator_percentile, crash_indicator_alert,
      hm_compliance_percentile, hm_compliance_alert,
      pu_vins_inspected
    FROM read_parquet('${parquet.replace(/'/g, "''")}')
    WHERE DOT_NUMBER IN (${placeholders})
  `;

  const rows = await runQuery<ParquetRow>(sql, unique);
  for (const r of rows) {
    out.set(asInt(r.DOT_NUMBER), rowToCarrier(r));
  }
  return out;
}
