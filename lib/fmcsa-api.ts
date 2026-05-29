/**
 * Legacy FMCSA QCMobile API client. One carrier per DOT.
 *
 * This file is the original implementation that hit the live FMCSA API. It is
 * retained as an opt-in fallback — set FMCSA_WEBKEY in env to use it instead
 * of the bundled parquet snapshot. The parquet path is the default because it
 * is faster, free, and includes signals the API doesn't expose (revocations,
 * enforcement). The API path is kept for cases where freshness on insurance /
 * OOS status matters more than the extra signals.
 *
 * No caching here — the in-memory map returned per request is enough for the
 * 100-load submission limit.
 */

const BASE = "https://mobile.fmcsa.dot.gov/qc/services/carriers";

import type { FmcsaCarrier } from "./fmcsa";

function asInt(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

async function fetchOne(
  dot: number,
  webKey: string
): Promise<FmcsaCarrier | null> {
  const url = `${BASE}/${dot}?webKey=${encodeURIComponent(webKey)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "augment-carrier-audit", Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: unknown };
  let content = body.content;
  if (Array.isArray(content)) content = content[0];
  if (!content || typeof content !== "object") return null;
  const carrier = (content as { carrier?: Record<string, unknown> }).carrier;
  if (!carrier) return null;

  return {
    dotNumber: typeof carrier.dotNumber === "number" ? carrier.dotNumber : null,
    legalName: (carrier.legalName as string) ?? null,
    dbaName: (carrier.dbaName as string) ?? null,
    // QCMobile API doesn't expose dockets / authority-type flags directly.
    // The parquet path has these; API path leaves them null/false so the
    // FmcsaCarrier shape stays consistent.
    mcNumber: null,
    additionalDockets: null,
    operationClassification: null,
    businessOrgType: null,
    hasPropertyAuthority: false,
    hasPassengerAuthority: false,
    hasHhgAuthority: false,
    hasPrivateAuthority: false,
    hasEnterpriseAuthority: false,
    hasBrokerAuthority: false,
    allowedToOperate: (carrier.allowedToOperate as string) ?? null,
    statusCode: (carrier.statusCode as string) ?? null,
    safetyRating: (carrier.safetyRating as string) ?? null,
    oosDate: (carrier.oosDate as string) ?? null,
    totalDrivers: asInt(carrier.totalDrivers),
    totalPowerUnits: asInt(carrier.totalPowerUnits),
    driverInsp: asInt(carrier.driverInsp),
    driverOosInsp: asInt(carrier.driverOosInsp),
    vehicleInsp: asInt(carrier.vehicleInsp),
    vehicleOosInsp: asInt(carrier.vehicleOosInsp),
    hazmatInsp: asInt(carrier.hazmatInsp),
    hazmatOosInsp: asInt(carrier.hazmatOosInsp),
    // API doesn't expose BASIC violation counts directly
    unsafeDrivingViolations: 0,
    hosViolations: 0,
    crashTotal: asInt(carrier.crashTotal),
    fatalCrash: asInt(carrier.fatalCrash),
    injCrash: asInt(carrier.injCrash),
    towawayCrash: asInt(carrier.towawayCrash),
    safetyRatingDate: null,
    bipdInsuranceRequired: (carrier.bipdInsuranceRequired as string) ?? null,
    bipdInsuranceOnFile: asInt(carrier.bipdInsuranceOnFile),
    bipdRequiredAmount: asInt(carrier.bipdRequiredAmount),
    bipdInsurerName: null,
    bipdPolicyEffectiveDate: null,
    cargoInsurerName: null,
    // API doesn't expose cargo, physical state, or DOT add date directly.
    cargoInsuranceOnFile: false,
    cargoInsuranceRequired: false,
    physicalState: null,
    // Identity/contact fields dropped from FmcsaCarrier — see lib/fmcsa.ts.
    // phyStreet: null, phyCity: null, phyZip: null,
    // phone: null, emailAddress: null,
    // companyOfficer1: null, companyOfficer2: null,
    dotAddDate: null,
    mcs150Date: null,
    reviewDate: null,
    reviewType: null,
    priorRevokeFlag: false,
    priorRevokeDotNumber: null,
    recordableCrashRate: null,
    mcs150Mileage: asInt(carrier.mcs150Mileage),
    // The API doesn't expose these — leave as zero/null so the analyzer's
    // revocation/enforcement/cancellation rules become no-ops when running
    // on API data.
    revocationsTotal: 0,
    involuntaryRevocations: 0,
    mostRecentInvoluntaryDate: null,
    enforcementCasesCount: 0,
    enforcementTotalSettled: 0,
    enforcementRecentDate: null,
    insuranceCancellations24mo: 0,
    mostRecentCancelDate: null,
    mostRecentCancelReason: null,
    rapidReplaceFlag: false,
    crashMeasure: 0,
    crashesPerMillionMiles: null,
    annualMileage: asInt(carrier.mcs150Mileage),
    peerGroup: "unknown",
    fleetSizeFlag: null,
    inspectionsPerPu: null,
    unsafeDrivingMeasure: null,
    hosMeasure: null,
    driverFitnessMeasure: null,
    controlledSubstancesMeasure: null,
    vehicleMaintenanceMeasure: null,
    unsafeDrivingAlert: null,
    hosAlert: null,
    driverFitnessAlert: null,
    controlledSubstancesAlert: null,
    vehicleMaintenanceAlert: null,
    // SAFER API fallback has no address dedup or fleet-sharing data; treat
    // as "nothing to flag." These are only computed during the parquet build.
    addressDupeActiveCount: 0,
    addressDupeOosCount: 0,
    largestSiblingDot: null,
    largestSiblingLegalName: null,
    largestSiblingSharedVins: 0,
    largestSiblingTotalVins: 0,
    largestSiblingOverlapPct: 0,
    diffuseVinSharePct: 0,
    diffuseVinShareNSiblings: 0,
    insuranceReplaces24mo: 0,
    insuranceDistinctPolicies24mo: 0,
    // FAST Act high-risk needs BASIC percentiles, computed only in the parquet
    // build. The SAFER API fallback can't determine it.
    fastActHighRisk: false,
    fastActHighRiskN: 0,
    fastActHighRiskBasics: null,
    // ISS / Serious Violations / imminent-lapse are parquet-build-only signals.
    issScore: null,
    issTier: null,
    issGroup: null,
    hasSeriousViolation: false,
    seriousViolationCount: 0,
    seriousViolationBasics: null,
    bipdImminentLapse: false,
    bipdDaysToLapse: null,
    bipdPendingCancelDate: null,
  };
}

export async function fetchCarriersFromApi(
  dots: number[],
  webKey: string,
  concurrency = 10
): Promise<Map<number, FmcsaCarrier>> {
  const unique = Array.from(new Set(dots));
  const result = new Map<number, FmcsaCarrier>();

  const queue = [...unique];
  async function worker() {
    while (queue.length) {
      const dot = queue.shift();
      if (dot === undefined) return;
      try {
        const c = await fetchOne(dot, webKey);
        if (c) result.set(dot, c);
      } catch {
        // Skip carriers that error out — they just won't appear in results.
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker)
  );

  return result;
}
