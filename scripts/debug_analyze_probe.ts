/**
 * Diagnostic: the 26 fixture failures reproduce ONLY on a GitHub runner.
 *
 * Already ruled out by reproduction, not reasoning: macOS vs Linux (clean in a
 * node:20 container), pnpm 9 vs 10, the Blob token, TZ=UTC, a shallow clone,
 * LFS, and the pnpm store cache. debug_env_parity.mjs proved the runner reads
 * byte-identical parquet data — same sizes, row counts and per-carrier values.
 * duckdb (1.4.4) and tsx (4.22.2) match too.
 *
 * So the inputs are identical and the outputs differ, which means the divergence
 * is inside fetchCarriers()/analyze(). This probe walks that exact path — the
 * one test_rules.ts uses — and prints what each stage produced, so a CI run can
 * be diffed against a local one line by line.
 */
import { fetchCarriers } from "../lib/fmcsa";
import { analyze } from "../lib/analyzer";

const DOTS = [3621624, 4514820, 2763893, 784547, 53467];

async function main() {
  console.log(`platform=${process.platform} node=${process.version} TZ=${Intl.DateTimeFormat().resolvedOptions().timeZone}`);

  // BATCH, as this probe originally did.
  const carriers = await fetchCarriers(DOTS);
  console.log(`fetchCarriers(batch) -> ${carriers.size}/${DOTS.length} resolved`);

  // SINGLE, which is what test_rules.ts actually does: fetchCarriers([dot]) per
  // fixture. If the two disagree, that is the whole bug — a one-DOT lookup can
  // take the "single-check bucket" path, and parquet-source.ts records that
  // those blobs went stale/corrupt. It cannot differ locally if the bucket
  // blobs are unreachable, which would explain a runner-only failure.
  // FULL object diff. An earlier version of this compared four fields, saw
  // "SAME", and wrongly cleared the single-DOT path. In the same CI job the
  // batch fetch scored DOT 784547 Critical with 5 reasons while the harness's
  // single fetch scored it High with 1 — so the difference is real and lives in
  // a field that comparison never printed.
  console.log("FULL batch-vs-single field diff (harness uses single):");
  for (const dot of DOTS) {
    const one = await fetchCarriers([dot]);
    const a: any = carriers.get(dot);
    const b: any = one.get(dot);
    if (!a || !b) { console.log(`   DOT ${dot}: missing (batch=${!!a} single=${!!b})`); continue; }
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)])).sort();
    const diffs = keys.filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    console.log(`   DOT ${dot}: ${diffs.length} field(s) differ`);
    for (const k of diffs.slice(0, 14)) {
      console.log(`      ${k}: batch=${JSON.stringify(a[k])} single=${JSON.stringify(b[k])}`);
    }
  }
  console.log("");

  for (const dot of DOTS) {
    const c = carriers.get(dot);
    if (!c) {
      console.log(`DOT ${dot}: NOT RESOLVED by fetchCarriers`);
      continue;
    }
    // The specific fields the failing chameleon/insurance rules gate on. If
    // these differ from local, the problem is in the read; if they match but
    // the reasons differ, it is in the scoring.
    console.log(
      `DOT ${dot} ${c.legalName ?? "?"}\n` +
        `   diffuseVinSharePct=${c.diffuseVinSharePct} ` +
        `shutdownSiblingCount=${c.shutdownSiblingCount} ` +
        `addressDupeOosCount=${c.addressDupeOosCount}\n` +
        `   largestSiblingDot=${c.largestSiblingDot} ` +
        `bipdImminentLapse=${c.bipdImminentLapse} ` +
        `totalPowerUnits=${c.totalPowerUnits}`
    );

    const res = analyze([{ dot, loadId: `probe-${dot}` }], carriers, new Map(), new Map());
    const row = res.rows[0];
    console.log(
      `   -> riskLevel=${row?.riskLevel} score=${row?.riskScore} ` +
        `reasons=${row?.reasons?.length ?? 0}`
    );
    for (const r of row?.reasons ?? []) console.log(`      - ${r.label}`);
    console.log("");
  }
}

main().catch((e) => {
  console.error("probe failed:", e);
  process.exit(1);
});
