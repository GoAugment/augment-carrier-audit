/**
 * FMCSA carrier lookup — dispatches between the bundled parquet snapshot
 * (default) and the live QCMobile API (opt-in fallback when FMCSA_WEBKEY is
 * configured).
 *
 * Parquet path (default): single in-process query against the May 2026 bulk
 * snapshot. Includes revocations + enforcement cases that the API doesn't
 * expose. ~1ms per query, no rate limit, no key.
 *
 * API path (opt-in): legacy live API. Use when freshness on insurance / OOS
 * status matters more than the extra parquet-only signals. Slower (network
 * RTT per DOT), key-gated.
 *
 * Shape is identical either way — `FmcsaCarrier` includes the parquet-only
 * fields (revocations, enforcement); the API path leaves them as zero/null.
 */

export interface FmcsaCarrier {
  dotNumber: number | null;
  legalName: string | null;
  dbaName: string | null;
  /**
   * Primary MC/MX/FF docket — e.g. "MC-133655", "FF-51075". Brokers reference
   * this alongside the DOT number on every load contract. Null for carriers
   * without a published docket (intrastate-only, registration-only, etc.).
   */
  mcNumber: string | null;
  /** Secondary docket(s), pipe-separated. Null when carrier has only one. */
  additionalDockets: string | null;
  /**
   * FMCSA operation classification — semicolon-separated descriptions like
   * "AUTHORIZED FOR HIRE", "AUTHORIZED FOR HIRE;U. S. MAIL;OTHER-IEP",
   * or "PRIVATE PROPERTY (BUSINESS)". Raw value from Census CLASSDEF.
   */
  operationClassification: string | null;
  /** Census BUSINESS_ORG_DESC — e.g. "CORPORATION", "LIMITED LIABILITY". */
  businessOrgType: string | null;
  // Authority-type flags from Carrier_All_With_History. Y → carrier holds
  // that type of operating authority on at least one of their dockets.
  hasPropertyAuthority: boolean;
  hasPassengerAuthority: boolean;
  hasHhgAuthority: boolean;
  hasPrivateAuthority: boolean;
  hasEnterpriseAuthority: boolean;
  hasBrokerAuthority: boolean;
  allowedToOperate: string | null;
  statusCode: string | null;
  safetyRating: string | null;
  /** YYYY-MM-DD date the current safety rating was issued. Old ratings (>10y)
   *  should not be treated as a positive signal — surface the age. */
  safetyRatingDate: string | null;
  oosDate: string | null;
  totalDrivers: number;
  totalPowerUnits: number;
  driverInsp: number;
  driverOosInsp: number;
  vehicleInsp: number;
  vehicleOosInsp: number;
  hazmatInsp: number;
  hazmatOosInsp: number;
  /** Driver inspections with any Unsafe Driving violation (24mo). */
  unsafeDrivingViolations: number;
  /** Driver inspections with any HOS Compliance violation (24mo). */
  hosViolations: number;
  crashTotal: number;
  fatalCrash: number;
  injCrash: number;
  towawayCrash: number;
  bipdInsuranceRequired: string | null;
  bipdInsuranceOnFile: number;
  bipdRequiredAmount: number;
  /** Current BIPD insurer name (from ActPendInsur). May be "SELF-INSURED". */
  bipdInsurerName: string | null;
  /** Effective date of current BIPD policy (raw MM/DD/YYYY string). */
  bipdPolicyEffectiveDate: string | null;
  /** Current cargo insurer name. */
  cargoInsurerName: string | null;
  /**
   * Cargo insurance on file (boolean — Carrier-AllWithHistory's CARGO_FILE
   * is a Y/N flag, not an amount. Actual cargo policy amounts live in
   * ActPendInsur but we don't currently pull them.)
   */
  cargoInsuranceOnFile: boolean;
  /** Whether FMCSA marks cargo insurance as required for this carrier. */
  cargoInsuranceRequired: boolean;
  mcs150Mileage: number;
  /** YYYY-MM-DD date the carrier last filed an MCS-150. >24mo = out of
   *  compliance with FMCSA's biennial filing rule; also means
   *  `crashesPerMillionMiles` is computed from a stale mileage denominator. */
  mcs150Date: string | null;
  /** Physical state from FMCSA Census (2-letter abbreviation), e.g. "TX", "NJ". */
  physicalState: string | null;
  // -- Identity / contact fields, dropped from the parquet to keep the file
  //    under GitHub's 100MB blob limit. The data is still in source CSVs;
  //    re-enable by uncommenting these + adding back to scripts/build_aggregates.py
  //    SELECT, fmcsa-parquet.ts ParquetRow + SELECT + rowToCarrier, and
  //    fmcsa-api.ts. Originally added for chameleon-clustering UI (not built).
  // phyStreet: string | null;
  // phyCity: string | null;
  // phyZip: string | null;
  // phone: string | null;
  // emailAddress: string | null;
  // companyOfficer1: string | null;
  // companyOfficer2: string | null;
  /** Date the USDOT number was issued (YYYY-MM-DD), parsed from FMCSA ADD_DATE. */
  dotAddDate: string | null;
  /**
   * Date of the rating-context compliance review (the one that produced
   * `safetyRating`). NOT the most-recent review — SAFER's "Review Date" comes
   * from a separate dataset we don't have bulk access to.
   */
  reviewDate: string | null;
  reviewType: string | null;
  /** Chameleon-detection: FMCSA's own flag that this DOT is linked to a
   *  previously-revoked predecessor DOT. The strongest single chameleon
   *  signal — no inference required. */
  priorRevokeFlag: boolean;
  priorRevokeDotNumber: number | null;
  /** FMCSA-computed recordable crash rate. Sparse (~1% of carriers, populated
   *  only after a compliance review). Independent of our `crashesPerMillionMiles`. */
  recordableCrashRate: number | null;
  // Parquet-only signals (zero/null when fetched via the API path).
  revocationsTotal: number;
  involuntaryRevocations: number;
  mostRecentInvoluntaryDate: string | null;
  enforcementCasesCount: number;
  enforcementTotalSettled: number;
  enforcementRecentDate: string | null;
  /** Insurance cancellation events in last 24 months (from InsHist). High
   *  count + `rapidReplaceFlag` is the classic chameleon-carrier pattern. */
  insuranceCancellations24mo: number;
  mostRecentCancelDate: string | null;
  mostRecentCancelReason: string | null;
  /** True if any cancel+replace pair within ~30 days exists in the carrier's
   *  insurance history (textbook re-incarnation signal). */
  rapidReplaceFlag: boolean;
  /** SMS-style Crash Indicator measure: severity × time-weighted crashes ÷ PU. */
  crashMeasure: number;
  /** Industry-standard crashes per million miles (raw count ÷ VMT). */
  crashesPerMillionMiles: number | null;
  /** Annual mileage from MCS-150 (in miles). */
  annualMileage: number;
  /** Fleet-size bucket string ("micro" | "small" | ... | "unknown"). */
  peerGroup: string;
  /** Fleet plausibility heuristic from add_plausibility.py — "plausible" |
   *  "low-activity" | "tiny" | "unknown". "low-activity" means inflated PU. */
  fleetSizeFlag: string | null;
  /** inspections_24mo / power_units. ~2-6 is typical for an operating truck. */
  inspectionsPerPu: number | null;
  // FMCSA's own pre-computed BASIC measures + alerts. The measures fold in
  // severity + time-recency weights; the alerts are FMCSA's binary "this
  // carrier is over the intervention threshold for this BASIC."
  unsafeDrivingMeasure: number | null;
  hosMeasure: number | null;
  driverFitnessMeasure: number | null;
  controlledSubstancesMeasure: number | null;
  vehicleMaintenanceMeasure: number | null;
  unsafeDrivingAlert: string | null;
  hosAlert: string | null;
  driverFitnessAlert: string | null;
  controlledSubstancesAlert: string | null;
  vehicleMaintenanceAlert: string | null;
  /** # of OTHER active-status DOTs sharing this carrier's normalized
   *  physical address. Context for the chameleon-address-cluster rule. */
  addressDupeActiveCount: number;
  /** # of OTHER out-of-service DOTs sharing this carrier's normalized
   *  physical address. Primary signal for chameleon-address-cluster. */
  addressDupeOosCount: number;
  /** Active DOT that shares the most inspected VINs with this carrier
   *  (24-month window). Null when no sibling shares ≥1 VIN. */
  largestSiblingDot: number | null;
  /** Legal name of the largest-sibling DOT, surfaced in evaluator details. */
  largestSiblingLegalName: string | null;
  /** # of VINs shared with the largest sibling. */
  largestSiblingSharedVins: number;
  /** Total # of distinct VINs inspected under this carrier in 24mo.
   *  Denominator for the overlap percentage. */
  largestSiblingTotalVins: number;
  /** Overlap as a percentage of this carrier's inspected fleet (0-100).
   *  Drives the chameleon-shared-fleet rule tier. */
  largestSiblingOverlapPct: number;
  /** % of this carrier's inspected VINs that have ALSO run under any other
   *  active DOT (24-month window). Diffuse equipment-sharing signal —
   *  catches carriers whose trucks are spread thin across many siblings
   *  rather than concentrated on one. */
  diffuseVinSharePct: number;
  /** Count of distinct other-DOTs that share at least one VIN with this
   *  carrier. Pairs with diffuseVinSharePct to distinguish leasing
   *  (1 sibling) from chameleon laundering (multiple siblings). */
  diffuseVinShareNSiblings: number;
  /** Count of 'Replaced' events on BIPD policies in last 24mo. Zero means
   *  the carrier has never recorded a continuous policy renewal. */
  insuranceReplaces24mo: number;
  /** Count of distinct BIPD policy numbers in last 24mo. Combined with
   *  insuranceReplaces24mo == 0 detects annual carrier-shopping. */
  insuranceDistinctPolicies24mo: number;
  /** FMCSA FAST Act §5305 High-Risk flag: 2+ of {Unsafe Driving, Crash
   *  Indicator, HOS, Vehicle Maintenance} at >=90th percentile — the
   *  threshold FMCSA uses to target a carrier for an onsite investigation.
   *  Single-snapshot percentile component only (we don't apply the
   *  two-consecutive-months persistence test or the recent-investigation
   *  exclusion). Crash Indicator percentile is sparse, so CI-driven
   *  high-risk is undercounted. See lib/rules > fast-act-high-risk. */
  fastActHighRisk: boolean;
  /** Count of the four FAST Act BASICs at >=90th percentile (0-4). */
  fastActHighRiskN: number;
  /** Which BASICs are at >=90th percentile, e.g. "UD+VM" ("" if none). */
  fastActHighRiskBasics: string | null;
  /** FMCSA ISS-CSA inspection-priority score (1-100), or null if unscored.
   *  Surfaced as context, not a tier driver — ISS over-weights large carriers
   *  with inspection exposure and under-weights data-poor small carriers. */
  issScore: number | null;
  /** ISS recommendation tier: "Inspect" / "Optional" / "Pass". */
  issTier: string | null;
  /** ISS group label, e.g. "Group 1 (high-risk)". */
  issGroup: string | null;
  /** Carrier has >=1 acute/critical Serious Violation from an FMCSA
   *  investigation in the last 12 months (scraped per-carrier; only populated
   *  for carriers in the investigation-scrape candidate set). */
  hasSeriousViolation: boolean;
  /** Count of Serious Violations in the last 12 months. */
  seriousViolationCount: number;
  /** Which BASICs the Serious Violations hit, e.g. "HOS+VM" ("" if none). */
  seriousViolationBasics: string | null;
  /** BIPD insurance is about to lapse (terminal cancellation, no replacement,
   *  carrier left with no other active BIPD). Most freshness-sensitive signal. */
  bipdImminentLapse: boolean;
  /** Days from the data snapshot to the lapse (negative = already lapsed). */
  bipdDaysToLapse: number | null;
  /** Effective date of the terminal BIPD cancellation (YYYY-MM-DD). */
  bipdPendingCancelDate: string | null;
}

export async function fetchCarriers(
  dots: number[]
): Promise<Map<number, FmcsaCarrier>> {
  const webKey = process.env.FMCSA_WEBKEY;
  if (webKey) {
    const { fetchCarriersFromApi } = await import("./fmcsa-api");
    return fetchCarriersFromApi(dots, webKey);
  }
  const { fetchCarriersFromParquet } = await import("./fmcsa-parquet");
  return fetchCarriersFromParquet(dots);
}

/** Resolve MC → DOT. Parquet-only — the live FMCSA API doesn't expose a
 *  fast MC lookup, so this falls back to the snapshot regardless of
 *  FMCSA_WEBKEY. Returns null when no carrier matches. */
export async function fetchDotByMc(mc: string): Promise<number | null> {
  const { fetchDotByMc: impl } = await import("./fmcsa-parquet");
  return impl(mc);
}
