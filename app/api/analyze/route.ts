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
  const t2 = Date.now();

  const ipHash = await hashIp(
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null
  );

  logEvent("audit_submitted", {
    ipHash,
    nLoads: result.totalLoads,
    nCarriers: result.totalCarriers,
    nFlagged: result.flaggedCarriers,
    severe: result.bySeverity.Severe,
    high: result.bySeverity.High,
    elevated: result.bySeverity.Elevated,
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
