/**
 * FMCSA QCMobile API client. One carrier per DOT. Cached in Vercel KV
 * (24h TTL) to avoid re-hitting FMCSA on repeat lookups.
 */
import { kv } from "@vercel/kv";

const BASE = "https://mobile.fmcsa.dot.gov/qc/services/carriers";
const CACHE_TTL_SECONDS = 24 * 60 * 60;

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
  crashTotal: number;
  fatalCrash: number;
  injCrash: number;
  towawayCrash: number;
  bipdInsuranceRequired: string | null;
  bipdInsuranceOnFile: number;
  bipdRequiredAmount: number;
  mcs150Mileage: number;
}

function asInt(v: unknown): number {
  if (v == null) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

async function fetchOne(dot: number, webKey: string): Promise<FmcsaCarrier | null> {
  const url = `${BASE}/${dot}?webKey=${encodeURIComponent(webKey)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": "augment-carrier-audit", Accept: "application/json" },
    // Vercel functions: no caching, we manage our own KV cache
    cache: "no-store",
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { content?: unknown };
  // QCMobile sometimes returns content as object, sometimes array
  let content = body.content;
  if (Array.isArray(content)) content = content[0];
  if (!content || typeof content !== "object") return null;
  const carrier = (content as { carrier?: Record<string, unknown> }).carrier;
  if (!carrier) return null;

  return {
    dotNumber: typeof carrier.dotNumber === "number" ? carrier.dotNumber : null,
    legalName: (carrier.legalName as string) ?? null,
    dbaName: (carrier.dbaName as string) ?? null,
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
    crashTotal: asInt(carrier.crashTotal),
    fatalCrash: asInt(carrier.fatalCrash),
    injCrash: asInt(carrier.injCrash),
    towawayCrash: asInt(carrier.towawayCrash),
    bipdInsuranceRequired: (carrier.bipdInsuranceRequired as string) ?? null,
    bipdInsuranceOnFile: asInt(carrier.bipdInsuranceOnFile),
    bipdRequiredAmount: asInt(carrier.bipdRequiredAmount),
    mcs150Mileage: asInt(carrier.mcs150Mileage),
  };
}

/**
 * Fetch carrier data for a list of DOT numbers. Uses KV cache where possible.
 * Returns a map keyed by DOT number. Failed lookups are simply absent from the map.
 */
export async function fetchCarriers(
  dots: number[],
  webKey: string,
  concurrency = 10
): Promise<Map<number, FmcsaCarrier>> {
  const unique = Array.from(new Set(dots));
  const result = new Map<number, FmcsaCarrier>();

  // Try cache first
  const missing: number[] = [];
  await Promise.all(
    unique.map(async (dot) => {
      try {
        const cached = await kv.get<FmcsaCarrier>(`fmcsa:${dot}`);
        if (cached) result.set(dot, cached);
        else missing.push(dot);
      } catch {
        // KV not configured in dev — fall through to direct fetch
        missing.push(dot);
      }
    })
  );

  // Fan out the rest with bounded concurrency
  const queue = [...missing];
  async function worker() {
    while (queue.length) {
      const dot = queue.shift();
      if (dot === undefined) return;
      try {
        const c = await fetchOne(dot, webKey);
        if (c) {
          result.set(dot, c);
          try {
            await kv.set(`fmcsa:${dot}`, c, { ex: CACHE_TTL_SECONDS });
          } catch {
            // KV unavailable — that's fine, we'll just refetch next time
          }
        }
      } catch {
        // Skip carriers that error out — they just won't appear in results
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length || 1) }, worker));

  return result;
}
