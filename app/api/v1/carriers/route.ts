import { NextRequest, NextResponse } from "next/server";
import {
  analyze,
  siblingStatusOf,
  type CarrierIdentityRiskSignals,
  type SiblingStatus,
} from "@/lib/analyzer";
import { fetchCarriers, fetchDotByMc, type FmcsaCarrier } from "@/lib/fmcsa";
import { authenticate, authConfigured } from "@/lib/api-auth";
import { logEvent } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * Customer-facing carrier lookup. API-key required.
 *
 * DELIBERATELY SEPARATE from /api/analyze, which is the public marketing
 * widget's endpoint. Two reasons:
 *   1. /api/analyze must stay keyless or the embedded tool breaks, so a key there
 *      would be attribution rather than access control.
 *   2. The moment a key is issued, this response is a contract. Keeping it apart
 *      means the widget's payload can be reshaped freely without breaking a
 *      paying integration.
 *
 *   GET  /api/v1/carriers?dot=53467
 *   GET  /api/v1/carriers?mc=MC-67717
 *   POST /api/v1/carriers   {"dots":[53467,80806]}
 *
 * Auth: `Authorization: Bearer <key>` (or `x-api-key: <key>`).
 *
 * Data is PUBLIC FMCSA data plus our derived scoring. Note the 7 BASIC
 * percentiles are OURS — FMCSA publishes none post-FAST-Act — computed to their
 * published methodology. A null percentile means NOT RATED (their data
 * sufficiency unmet), never "clean"; most carriers populate only 2-3 of the 7.
 */
const MAX_BATCH = Number(process.env.AUDIT_API_MAX_BATCH ?? 100);

function unauthorized(detail: string) {
  return NextResponse.json(
    { error: "Unauthorized.", detail },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } }
  );
}

async function handle(req: NextRequest, dots: number[], mcInput: string | null) {
  const caller = authenticate(req);
  if (!caller) {
    // Distinguish a deployment with no keys configured from a bad key: same
    // answer to the client, very different thing to page someone about.
    if (!authConfigured()) {
      console.error("[api/v1] AUDIT_API_KEYS is not configured — all calls will 401");
      return unauthorized("API key required.");
    }
    return unauthorized("API key missing or invalid.");
  }

  if (!dots.length) {
    return NextResponse.json(
      { error: "Provide ?dot=<number>, ?mc=<number>, or POST {\"dots\":[...]}." },
      { status: 400 }
    );
  }
  if (dots.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Too many DOTs (${dots.length}). Limit is ${MAX_BATCH} per request.` },
      { status: 413 }
    );
  }

  const t0 = Date.now();
  const carriers = await fetchCarriers(dots);

  let identitySignals = new Map<number, CarrierIdentityRiskSignals>();
  try {
    const { fetchIdentityRiskSignals } = await import("@/lib/fmcsa-identity");
    identitySignals = await fetchIdentityRiskSignals(dots);
  } catch (err) {
    // Identity signals are enrichment, not the core verdict. Degrade rather than
    // fail the customer's request.
    console.warn("[api/v1] identity risk signals unavailable", err);
  }

  // Same sibling pre-resolution as /api/analyze: a VIN-sharing sibling whose
  // authority was revoked is the chameleon-successor tell and must be known
  // BEFORE scoring, or the verdict is computed without it.
  const dotSet = new Set(dots);
  const siblingDots = Array.from(
    new Set(
      Array.from(carriers.values())
        .map((c) => c.largestSiblingDot)
        .filter((d): d is number => typeof d === "number" && d > 0 && !dotSet.has(d))
    )
  );
  const siblingCarriers: Map<number, FmcsaCarrier> = siblingDots.length
    ? await fetchCarriers(siblingDots)
    : new Map();
  const siblingStatusMap = new Map<number, SiblingStatus>();
  for (const c of [...carriers.values(), ...siblingCarriers.values()]) {
    if (c.dotNumber != null) siblingStatusMap.set(c.dotNumber, siblingStatusOf(c));
  }

  const result = analyze(
    dots.map((dot) => ({ dot, loadId: `api-${dot}` })),
    carriers,
    siblingStatusMap,
    identitySignals
  );

  const unresolved = dots.filter((d) => !carriers.has(d));
  const ms = Date.now() - t0;

  logEvent("api_carrier_lookup", {
    // Label only — never the key itself.
    caller: caller.label,
    nRequested: dots.length,
    nResolved: dots.length - unresolved.length,
    nUnresolved: unresolved.length,
    mcInput,
    ms,
  });

  return NextResponse.json(
    {
      carriers: result.rows.map((r) => ({
        dot: r.dot,
        legalName: r.carrierName,
        riskLevel: r.riskLevel,
        riskScore: r.riskScore,
        issScore: r.issScore,
        issTier: r.issTier,
        /** The 7 FMCSA SMS BASICs. percentile null = NOT RATED, not clean. */
        basics: r.basics,
        reasons: r.reasons.map((x) => ({ label: x.label, detail: x.detail })),
        carrier: r.carrier,
      })),
      unresolved,
      meta: { count: result.rows.length, ms },
    },
    {
      // Never let a shared cache hold a keyed response.
      headers: { "Cache-Control": "private, no-store" },
    }
  );
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const mc = sp.get("mc");
  let dots = sp
    .getAll("dot")
    .flatMap((v) => v.split(","))
    .map((v) => Number(String(v).replace(/\D/g, "")))
    .filter((n) => Number.isInteger(n) && n > 0);

  if (!dots.length && mc) {
    // Resolve MC -> DOT before auth-gated work; a bad MC is a 404, not a 401.
    const caller = authenticate(req);
    if (!caller) return unauthorized("API key missing or invalid.");
    const resolved = await fetchDotByMc(mc);
    if (!resolved) {
      return NextResponse.json(
        { error: `No carrier found for MC ${mc}.` },
        { status: 404 }
      );
    }
    dots = [resolved];
  }
  return handle(req, Array.from(new Set(dots)), mc);
}

export async function POST(req: NextRequest) {
  let body: { dots?: unknown; dot?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const raw = Array.isArray(body.dots) ? body.dots : body.dot != null ? [body.dot] : [];
  const dots = Array.from(
    new Set(
      raw
        .map((v) => Number(String(v).replace(/\D/g, "")))
        .filter((n) => Number.isInteger(n) && n > 0)
    )
  );
  return handle(req, dots, null);
}
