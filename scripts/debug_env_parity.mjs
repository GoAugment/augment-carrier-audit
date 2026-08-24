/**
 * Diagnostic: why does `pnpm test` pass locally and in a Linux container, but
 * fail 26 fixtures on a GitHub-hosted runner, against the SAME committed data?
 *
 * Ruled out already: macOS vs Linux (reproduced clean in a node:20 container),
 * pnpm 9 vs 10, the Blob token, timezone, a shallow clone, and LFS (not used).
 * check_committed_data.py passes in CI, so carrier_aggregates.parquet agrees
 * with refresh_metrics.json there.
 *
 * That leaves the files that check does NOT cover — carrier_identity.parquet
 * and carrier_risk_signals.parquet — which is also exactly how the failures
 * split: rules reading only carrier_aggregates pass, rules that also need
 * identity/risk-signal data fail.
 *
 * Prints per-file size and row count plus a probe of the specific carriers
 * behind failing fixtures, so the CI output can be diffed against a local run.
 */
import fs from "node:fs";
import path from "node:path";
import duckdb from "duckdb";

// duckdb returns BIGINT as JS BigInt, which JSON.stringify refuses to touch.
const j = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? Number(v) : v));

const FILES = [
  "carrier_aggregates.parquet",
  "carrier_identity.parquet",
  "carrier_risk_signals.parquet",
];

// One carrier per failing rule family, plus a passing-rule control.
const PROBES = [
  [3621624, "chameleon-diffuse-equipment / shared-fleet (FAILS in CI)"],
  [4514820, "chameleon-shutdown-predecessor (FAILS in CI)"],
  [2763893, "chameleon-address-cluster (FAILS in CI)"],
  [784547, "insurance-imminent-lapse (FAILS in CI)"],
  [53467, "Werner — control, passes in CI"],
];

const db = new duckdb.Database(":memory:");
const conn = db.connect();
const q = (sql) =>
  new Promise((res, rej) => conn.all(sql, (e, r) => (e ? rej(e) : res(r))));

console.log(`platform=${process.platform} node=${process.version} cwd=${process.cwd()}`);
console.log("");

for (const f of FILES) {
  const p = path.join(process.cwd(), "data", f);
  let size = "MISSING";
  try {
    size = `${(fs.statSync(p).size / 1048576).toFixed(1)} MB`;
  } catch {}
  let rows = "-";
  let cols = "-";
  try {
    const r = await q(`SELECT count(*) n FROM read_parquet('${p}')`);
    rows = Number(r[0].n).toLocaleString();
    const c = await q(`SELECT * FROM read_parquet('${p}') LIMIT 0`);
    cols = Object.keys(c[0] ?? {}).length || (await q(
      `SELECT count(*) n FROM (DESCRIBE SELECT * FROM read_parquet('${p}'))`
    ))[0].n;
  } catch (e) {
    rows = `READ FAILED: ${String(e.message).slice(0, 90)}`;
  }
  console.log(`${f.padEnd(34)} ${String(size).padStart(9)}  rows=${rows}  cols=${cols}`);
}

console.log("\n--- probes (aggregates) ---");
const agg = path.join(process.cwd(), "data", "carrier_aggregates.parquet");
for (const [dot, why] of PROBES) {
  try {
    const r = await q(`
      SELECT DOT_NUMBER, diffuse_vin_share_pct, shutdown_sibling_count,
             address_dupe_oos_count, bipd_imminent_lapse, largest_sibling_dot,
             unsafe_driving_percentile, crash_indicator_percentile
      FROM read_parquet('${agg}') WHERE DOT_NUMBER = ${dot}`);
    console.log(`DOT ${dot} — ${why}`);
    console.log(`   ${r.length ? j(r[0]) : "NOT PRESENT"}`);
  } catch (e) {
    console.log(`DOT ${dot} — query failed: ${String(e.message).slice(0, 120)}`);
  }
}

console.log("\n--- risk signals ---");
const rs = path.join(process.cwd(), "data", "carrier_risk_signals.parquet");
try {
  const cols = await q(`DESCRIBE SELECT * FROM read_parquet('${rs}')`);
  console.log("columns:", cols.map((c) => c.column_name).join(", "));
  for (const [dot] of PROBES) {
    const r = await q(`SELECT * FROM read_parquet('${rs}') WHERE DOT_NUMBER = ${dot}`);
    console.log(`   DOT ${dot}: ${r.length ? j(r[0]).slice(0, 200) : "no row"}`);
  }
} catch (e) {
  console.log("risk signals read failed:", String(e.message).slice(0, 160));
}

conn.close();
