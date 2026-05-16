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
  allowedToOperate: string | null;
  statusCode: string | null;
  safetyRating: string | null;
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
  /** Cargo insurance on file (in thousands of dollars). */
  cargoInsuranceOnFile: number;
  /** Whether FMCSA marks cargo insurance as required for this carrier. */
  cargoInsuranceRequired: boolean;
  mcs150Mileage: number;
  /** Physical state from FMCSA Census (2-letter abbreviation), e.g. "TX", "NJ". */
  physicalState: string | null;
  /** Date the USDOT number was issued (YYYY-MM-DD), parsed from FMCSA ADD_DATE. */
  dotAddDate: string | null;
  // Parquet-only signals (zero/null when fetched via the API path).
  revocationsTotal: number;
  involuntaryRevocations: number;
  mostRecentInvoluntaryDate: string | null;
  enforcementCasesCount: number;
  enforcementTotalSettled: number;
  enforcementRecentDate: string | null;
  /** SMS-style Crash Indicator measure: severity × time-weighted crashes ÷ PU. */
  crashMeasure: number;
  /** Industry-standard crashes per million miles (raw count ÷ VMT). */
  crashesPerMillionMiles: number | null;
  /** Annual mileage from MCS-150 (in miles). */
  annualMileage: number;
  /** Fleet-size bucket string ("micro" | "small" | ... | "unknown"). */
  peerGroup: string;
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
