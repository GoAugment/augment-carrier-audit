import { NextRequest, NextResponse } from "next/server";
import { parseInput, analyze, siblingStatusOf, type SiblingStatus } from "@/lib/analyzer";
import { fetchCarriers, type FmcsaCarrier } from "@/lib/fmcsa";
import { nationalThresholds, maxLoadsPerSubmission } from "@/lib/thresholds";
import { logEvent, hashIp } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 60; // Vercel Pro: 60s
// Force-dynamic so Next.js doesn't try to load duckdb (native libstdc++
// binary) during the build container's static-page-data step.
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: { input?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.input || typeof body.input !== "string") {
    return NextResponse.json({ error: "Missing 'input' string." }, { status: 400 });
  }

  const { loads, errors } = parseInput(body.input);
  if (!loads.length) {
    return NextResponse.json(
      { error: "No valid DOT numbers found in input.", parseErrors: errors },
      { status: 400 }
    );
  }
  if (loads.length > maxLoadsPerSubmission) {
    return NextResponse.json(
      {
        error: `Too many loads (${loads.length}). Limit is ${maxLoadsPerSubmission}. Reach out to augment for the unlimited daily-audit version.`,
      },
      { status: 413 }
    );
  }

  const t0 = Date.now();
  const dots = Array.from(new Set(loads.map((l) => l.dot)));
  const carriers = await fetchCarriers(dots);

  // Pre-fetch every carrier's largest cross-DOT VIN-overlap sibling (a raw field
  // on the FMCSA record) so we know each sibling's authority STATUS before
  // scoring. A sibling whose authority was involuntarily revoked — its trucks
  // now running here — is the chameleon-successor tell, and we want it to drive
  // this carrier's verdict + fraud score (handled inside analyze).
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
  const t1 = Date.now();

  const siblingStatusMap = new Map<number, SiblingStatus>();
  for (const c of [...carriers.values(), ...siblingCarriers.values()]) {
    if (c.dotNumber != null) siblingStatusMap.set(c.dotNumber, siblingStatusOf(c));
  }

  const result = analyze(loads, carriers, siblingStatusMap);

  // Score the named siblings for the DISPLAY tier chip (shown only when the
  // sibling is still active; revoked/inactive siblings show their status
  // instead). Reuse the already-fetched sibling records + the input carriers'
  // own verdicts.
  const tierByDot = new Map<number, (typeof result.rows)[number]["riskLevel"]>();
  for (const r of result.rows) tierByDot.set(r.dot, r.riskLevel);
  if (siblingCarriers.size) {
    const siblingResult = analyze(
      Array.from(siblingCarriers.keys()).map((dot) => ({ dot, isHazmat: false })),
      siblingCarriers
    );
    for (const sr of siblingResult.rows) tierByDot.set(sr.dot, sr.riskLevel);
  }
  for (const r of result.rows) {
    if (r.siblingDot != null) r.siblingTier = tierByDot.get(r.siblingDot) ?? null;
  }
  const t2 = Date.now();

  const ipHash = await hashIp(
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null
  );

  logEvent("audit_submitted", {
    ipHash,
    nLoads: result.totalLoads,
    nCarriers: result.totalCarriers,
    nFlagged: result.flaggedCarriers,
    critical: result.bySeverity.Critical,
    high: result.bySeverity.High,
    medium: result.bySeverity.Medium,
    nUnresolved: result.unresolvedDots.length,
    nParseErrors: errors.length,
    fmcsaCacheMissMs: t1 - t0,
    analyzeMs: t2 - t1,
    thresholds: nationalThresholds,
  });

  return NextResponse.json({
    ...result,
    parseErrors: errors,
  });
}
