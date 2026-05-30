import { NextRequest, NextResponse } from "next/server";
import { parseInput, analyze } from "@/lib/analyzer";
import { fetchCarriers } from "@/lib/fmcsa";
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
  const t1 = Date.now();

  const result = analyze(loads, carriers);

  // Second pass: score each carrier's named shared-fleet sibling so the UI can
  // show the linked authority's OWN verdict (a carrier sharing 53% of its VINs
  // with another DOT is far more alarming if that sibling is itself Critical).
  // Most siblings aren't in the broker's pasted list, so fetch + score the ones
  // we don't already have; reuse the first pass for any that are.
  const alreadyScored = new Map(result.rows.map((r) => [r.dot, r.riskLevel]));
  const siblingDots = Array.from(
    new Set(
      result.rows
        .map((r) => r.siblingDot)
        .filter((d): d is number => d != null && !alreadyScored.has(d))
    )
  );
  if (siblingDots.length) {
    const siblingCarriers = await fetchCarriers(siblingDots);
    const siblingResult = analyze(
      siblingDots.map((dot) => ({ dot, isHazmat: false })),
      siblingCarriers
    );
    for (const sr of siblingResult.rows) alreadyScored.set(sr.dot, sr.riskLevel);
  }
  for (const r of result.rows) {
    if (r.siblingDot != null) {
      r.siblingTier = alreadyScored.get(r.siblingDot) ?? null;
    }
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
