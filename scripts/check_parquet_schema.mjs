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
