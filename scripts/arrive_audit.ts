/**
 * One-off: run today's Arrive-Logistics DOTs (from /tmp/arrive_dots_*.txt)
 * through the real analyze pipeline (mirrors app/api/analyze/route.ts) and
 * print a risk-ranked shortlist. Offline carrier-vetting only — not shipped.
 *
 *   pnpm tsx --env-file=.env.local scripts/arrive_audit.ts /tmp/arrive_dots_2026-06-01.txt
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  analyze,
  siblingStatusOf,
  type CarrierIdentityRiskSignals,
  type SiblingStatus,
} from "../lib/analyzer";
import { fetchCarriers, type FmcsaCarrier } from "../lib/fmcsa";

async function main() {
  const path = process.argv[2] ?? "/tmp/arrive_dots_2026-06-01.txt";
  const dots = readFileSync(path, "utf8")
    .split(/\s+/)
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);

  const carriers = await fetchCarriers(dots);

  let identitySignals = new Map<number, CarrierIdentityRiskSignals>();
  try {
    const { fetchIdentityRiskSignals } = await import("../lib/fmcsa-identity");
    identitySignals = await fetchIdentityRiskSignals(dots);
  } catch (err) {
    console.warn("identity risk signals unavailable", err);
  }

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

  const loads = dots.map((dot) => ({ dot, isHazmat: false }));
  const result = analyze(loads, carriers, siblingStatusMap, identitySignals);

  const rows = [...result.rows].sort(
    (a, b) => b.riskScore - a.riskScore || (b.issScore ?? 0) - (a.issScore ?? 0)
  );
  const tierCounts: Record<string, number> = {};
  for (const r of rows) tierCounts[r.riskLevel] = (tierCounts[r.riskLevel] ?? 0) + 1;
  const notInData = dots.filter((d) => !result.rows.some((r) => r.dot === d));

  console.log(`\n=== Arrive loads ${path} — ${dots.length} carriers ===`);
  console.log(
    `Critical ${tierCounts["Critical"] ?? 0} · High ${tierCounts["High"] ?? 0} · Medium ${tierCounts["Medium"] ?? 0} · Clean ${tierCounts["Low"] ?? 0} · not-in-FMCSA ${notInData.length}\n`
  );
  console.log("=== Review queue (Critical + High + Medium), risk-ranked ===");
  for (const r of rows) {
    if (r.riskLevel === "Low") continue;
    const top = r.riskContributions
      .slice()
      .sort((a, b) => b.points - a.points)
      .slice(0, 3)
      .map((f) => `+${f.points} ${f.label}`)
      .join(" | ");
    console.log(
      `  ${r.riskLevel.padEnd(8)} ${String(r.riskScore).padStart(3)}  DOT ${String(r.dot).padStart(8)}  ${(r.carrierName ?? "?").slice(0, 32).padEnd(32)}  ${top}`
    );
  }
  if (notInData.length)
    console.log(`\nNot in FMCSA parquet (${notInData.length}): ${notInData.join(", ")}`);

  const out = "/tmp/arrive_audit_2026-06-01.json";
  writeFileSync(
    out,
    JSON.stringify(
      rows.map((r) => ({
        dot: r.dot,
        carrier: r.carrierName,
        riskScore: r.riskScore,
        riskLevel: r.riskLevel,
        riskTier: r.riskTier,
        issScore: r.issScore,
        contributions: r.riskContributions.map((f) => `+${f.points} [${f.category}] ${f.label}`),
      })),
      null,
      2
    )
  );
  console.log(`\nFull detail → ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
