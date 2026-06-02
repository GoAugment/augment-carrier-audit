/**
 * Single-carrier check page — the modern, Scorecard-styled audit for one DOT,
 * the target for the bookmarklet / future extension (open in a new tab).
 *
 *   /check/{dot}
 *
 * Mirrors app/api/analyze/route.ts data-build (identity signals + sibling
 * status/tier) and renders the same <Scorecard> the website uses, so it stays
 * on-design automatically. The email reply preview lives at /check/{dot}/email.
 */
import {
  analyze,
  siblingStatusOf,
  type SiblingStatus,
  type RiskLevel,
  type CarrierIdentityRiskSignals,
} from "@/lib/analyzer";
import { fetchCarriers, type FmcsaCarrier } from "@/lib/fmcsa";
import { fetchIdentityRiskSignals } from "@/lib/fmcsa-identity";
import { Scorecard } from "@/components/Scorecard";

export const dynamic = "force-dynamic";

export default async function CheckPage({
  params,
}: {
  params: { dot: string };
}) {
  const dot = parseInt(params.dot, 10);
  if (!Number.isFinite(dot) || dot <= 0) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16 text-ink-700">
        Invalid DOT number.
      </main>
    );
  }

  const carriers = await fetchCarriers([dot]);
  if (!carriers.has(dot)) {
    return (
      <main className="mx-auto max-w-2xl px-6 py-16">
        <h1 className="text-lg font-semibold text-ink-900">DOT {dot}</h1>
        <p className="mt-2 text-ink-600">
          Not found in the current FMCSA snapshot. Double-check the number, or it
          may be a brand-new or deregistered authority.
        </p>
      </main>
    );
  }

  let identitySignals = new Map<number, CarrierIdentityRiskSignals>();
  try {
    identitySignals = await fetchIdentityRiskSignals([dot]);
  } catch {
    /* identity parquet optional */
  }

  const siblingDots = Array.from(
    new Set(
      Array.from(carriers.values())
        .map((c) => c.largestSiblingDot)
        .filter((d): d is number => typeof d === "number" && d > 0 && d !== dot)
    )
  );
  const siblingCarriers: Map<number, FmcsaCarrier> = siblingDots.length
    ? await fetchCarriers(siblingDots)
    : new Map();

  const siblingStatusMap = new Map<number, SiblingStatus>();
  for (const c of [...carriers.values(), ...siblingCarriers.values()]) {
    if (c.dotNumber != null) siblingStatusMap.set(c.dotNumber, siblingStatusOf(c));
  }

  const result = analyze([{ dot, isHazmat: false }], carriers, siblingStatusMap, identitySignals);

  // Sibling display tier (same as the API route): score the named siblings so
  // the panel can show the linked authority's own verdict.
  const tierByDot = new Map<number, RiskLevel>();
  for (const r of result.rows) tierByDot.set(r.dot, r.riskLevel);
  if (siblingCarriers.size) {
    const sib = analyze(
      Array.from(siblingCarriers.keys()).map((d) => ({ dot: d, isHazmat: false })),
      siblingCarriers
    );
    for (const sr of sib.rows) tierByDot.set(sr.dot, sr.riskLevel);
  }
  for (const r of result.rows) {
    if (r.siblingDot != null) r.siblingTier = tierByDot.get(r.siblingDot) ?? null;
  }

  return (
    <main className="min-h-screen bg-ink-50">
      <div className="mx-auto max-w-7xl px-6 py-10">
        <Scorecard rows={result.rows} result={result} />
      </div>
    </main>
  );
}
