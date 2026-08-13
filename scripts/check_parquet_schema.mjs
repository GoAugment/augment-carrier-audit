import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const duckdb = require("duckdb");

const root = process.cwd();
const parquetPath = path.join(root, "data", "carrier_aggregates.parquet");
const adapterPath = path.join(root, "lib", "fmcsa-parquet.ts");
const exact = process.argv.includes("--exact");

function appProjectionColumns() {
  const source = fs.readFileSync(adapterPath, "utf8");
  const matches = [...source.matchAll(/SELECT\s+([\s\S]*?)\s+FROM read_parquet/g)];
  if (matches.length === 0) {
    throw new Error(`No SELECT ... FROM read_parquet block found in ${adapterPath}`);
  }

  const body = matches
    .map((match) => match[1])
    .sort((a, b) => b.length - a.length)[0]
    .replace(/--.*$/gm, "");

  const cols = body
    .split(",")
    .map((part) => part.trim())
    .filter((part) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(part));

  if (cols.length === 0) {
    throw new Error(`No projected columns parsed from ${adapterPath}`);
  }
  return cols;
}

function describeParquet() {
  const db = new duckdb.Database(":memory:");
  const sql = `DESCRIBE SELECT * FROM read_parquet('${parquetPath.replaceAll("'", "''")}')`;
  return new Promise((resolve, reject) => {
    db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function diffList(a, b) {
  const bSet = new Set(b);
  return a.filter((x) => !bSet.has(x));
}

const expected = appProjectionColumns();
const schema = await describeParquet();
const actual = schema.map((row) => row.column_name);

const missing = diffList(expected, actual);
const extra = diffList(actual, expected);

if (missing.length || (exact && extra.length)) {
  console.error("carrier_aggregates.parquet does not match lib/fmcsa-parquet.ts projection.");
  if (missing.length) console.error(`Missing columns: ${missing.join(", ")}`);
  if (exact && extra.length) console.error(`Extra columns: ${extra.join(", ")}`);
  if (exact) console.error("Run: uv run pipeline/fmcsa-aggregate/prune_app_parquet.py");
  process.exit(1);
}

const suffix = extra.length
  ? `; ${extra.length} build-only columns present`
  : "";
console.log(`✓ carrier_aggregates.parquet contains all app projection columns (${expected.length} required, ${actual.length} total${suffix})`);

// --- reference carriers -----------------------------------------------------
// Known-good values on large, stable carriers. These catch the class of bug that
// aggregate statistics hide: during the 2026-08 Motus insurance migration, two
// separate wrong results looked fine on every distribution check and were caught
// only here. bipd_insurance_on_file is $-THOUSANDS (Werner 5000 = $5M) —
// the Motus feed is in whole dollars, so a missed unit conversion inflates it
// 1000x, and summing superseded policy layers over-counts (Werner read 6000).
const REFERENCE_CARRIERS = [
  { dot: 53467, name: "Werner", bipd: 5000 },   // 4M excess + 1M self-insured
  { dot: 80806, name: "JB Hunt", bipd: 3500 },  // 2.5M excess + 1M self-insured
  { dot: 264184, name: "Schneider", bipd: 1000 }, // no BMC-91 in Motus; keeps L&I value
];

const refRows = await new Promise((resolve, reject) => {
  const refDb = new duckdb.Database(":memory:");
  const dots = REFERENCE_CARRIERS.map((c) => c.dot).join(",");
  refDb.all(
    `SELECT DOT_NUMBER, bipd_insurance_on_file FROM read_parquet('${parquetPath.replaceAll("'", "''")}')
     WHERE DOT_NUMBER IN (${dots})`,
    (err, rows) => (err ? reject(err) : resolve(rows)),
  );
});

const refBad = [];
for (const c of REFERENCE_CARRIERS) {
  const row = refRows.find((r) => Number(r.DOT_NUMBER) === c.dot);
  if (!row) {
    refBad.push(`${c.name} (DOT ${c.dot}) missing from parquet`);
  } else if (Number(row.bipd_insurance_on_file) !== c.bipd) {
    refBad.push(
      `${c.name} (DOT ${c.dot}) bipd_insurance_on_file = ${row.bipd_insurance_on_file}, expected ${c.bipd} ($-thousands)`,
    );
  }
}
if (refBad.length) {
  console.error("\n✗ reference-carrier check FAILED — the insurance data is wrong:");
  for (const m of refBad) console.error(`   ${m}`);
  console.error("See merge_motus.merge_insurance (units + superseded-layer de-dup).");
  process.exit(1);
}
console.log(`✓ reference carriers correct (${REFERENCE_CARRIERS.map((c) => c.name).join(", ")})`);
