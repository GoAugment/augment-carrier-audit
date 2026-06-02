#!/usr/bin/env node
/**
 * Build DuckDB-free single-check artifacts.
 *
 * These compact tables are for one-carrier API lookups on serverless runtimes:
 *
 *   single-check-compact/
 *     carriers/bucket=330.json.gz       [columns[], rows[][]]
 *     identities/bucket=330.json.gz     [columns[], rows[][]]
 *     mc/prefix=677.json.gz             [["mc","DOT_NUMBER"], rows]
 *     phone/prefix=9843.json.gz         [["ph","DOT_NUMBER"], rows]
 *
 * DOT remains the canonical key. MC and phone artifacts are only secondary
 * indexes that resolve to DOTs.
 */
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import duckdb from "duckdb";

const root = process.cwd();
const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[i + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    i += 1;
  } else {
    args.set(key, "true");
  }
}

const bucketParquets = path.resolve(root, args.get("bucket-parquets") ?? "data/single-check-buckets");
const out = path.resolve(root, args.get("out") ?? ".context/single-check-compact");
const mcPrefixLen = Number(args.get("mc-prefix-len") ?? 3);
const phonePrefixLen = Number(args.get("phone-prefix-len") ?? 4);

if (!fs.existsSync(bucketParquets)) {
  throw new Error(`Missing parquet bucket directory: ${bucketParquets}`);
}
if (!Number.isInteger(mcPrefixLen) || mcPrefixLen <= 0) {
  throw new Error(`Invalid --mc-prefix-len ${mcPrefixLen}`);
}
if (!Number.isInteger(phonePrefixLen) || phonePrefixLen <= 0) {
  throw new Error(`Invalid --phone-prefix-len ${phonePrefixLen}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "carriers"), { recursive: true });
fs.mkdirSync(path.join(out, "identities"), { recursive: true });
fs.mkdirSync(path.join(out, "mc"), { recursive: true });
fs.mkdirSync(path.join(out, "phone"), { recursive: true });

const db = new duckdb.Database(":memory:");
const all = (sql, params = []) =>
  new Promise((resolve, reject) => db.all(sql, ...params, (err, rows) => (err ? reject(err) : resolve(rows))));

function sqlPath(p) {
  return p.replace(/'/g, "''");
}

function jsonReplacer(_key, value) {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return value;
}

function parseCarrierColumns() {
  const source = fs.readFileSync(path.join(root, "lib", "fmcsa-parquet.ts"), "utf8");
  const match = source.match(/const CARRIER_SELECT_COLUMNS = `([\s\S]*?)`;/);
  if (!match) throw new Error("Could not find CARRIER_SELECT_COLUMNS in lib/fmcsa-parquet.ts");
  return match[1].split(",").map((s) => s.trim()).filter(Boolean);
}

function quoteIdent(name) {
  return `"${name.replace(/"/g, '""')}"`;
}

function tableFromRows(columns, rows) {
  return [columns, rows.map((row) => columns.map((col) => row[col] ?? null))];
}

function writeCompact(file, columns, rows) {
  const body = Buffer.from(JSON.stringify(tableFromRows(columns, rows), jsonReplacer));
  const gz = zlib.gzipSync(body, { level: 6 });
  fs.writeFileSync(file, gz);
  return gz.length;
}

function findBucketFiles(kind) {
  const base = path.join(bucketParquets, kind);
  if (!fs.existsSync(base)) throw new Error(`Missing bucket kind: ${base}`);
  const out = [];
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".parquet")) {
      const bucket = Number(entry.name.replace(/\.parquet$/, ""));
      if (Number.isFinite(bucket)) out.push({ bucket, file: path.join(base, entry.name) });
    } else if (entry.isDirectory()) {
      const match = entry.name.match(/^bucket=(\d+)$/);
      if (!match) continue;
      const dir = path.join(base, entry.name);
      for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
        if (child.isFile() && child.name.endsWith(".parquet")) {
          out.push({ bucket: Number(match[1]), file: path.join(dir, child.name) });
        }
      }
    }
  }
  return out.sort((a, b) => a.bucket - b.bucket);
}

async function timed(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return result;
}

const carrierColumns = parseCarrierColumns();
const carrierFiles = findBucketFiles("carriers");
const identityFiles = findBucketFiles("identities");
if (carrierFiles.length === 0 || identityFiles.length === 0) {
  throw new Error("No carrier/identity bucket parquet files found");
}

const identityDescribe = await all(
  `DESCRIBE SELECT * FROM read_parquet('${sqlPath(identityFiles[0].file)}')`
);
const identityColumns = identityDescribe
  .map((row) => row.column_name)
  .filter((name) => name !== "bucket");

let carrierBytes = 0;
let identityBytes = 0;
let carrierRowsTotal = 0;
let identityRowsTotal = 0;

await timed("carrier compact buckets", async () => {
  for (const { bucket, file } of carrierFiles) {
    const rows = await all(
      `SELECT ${carrierColumns.map(quoteIdent).join(", ")}
       FROM read_parquet('${sqlPath(file)}')
       ORDER BY DOT_NUMBER`
    );
    carrierRowsTotal += rows.length;
    carrierBytes += writeCompact(
      path.join(out, "carriers", `bucket=${bucket}.json.gz`),
      carrierColumns,
      rows
    );
  }
});

await timed("identity compact buckets", async () => {
  for (const { bucket, file } of identityFiles) {
    const rows = await all(
      `SELECT ${identityColumns.map(quoteIdent).join(", ")}
       FROM read_parquet('${sqlPath(file)}')
       ORDER BY DOT_NUMBER`
    );
    identityRowsTotal += rows.length;
    identityBytes += writeCompact(
      path.join(out, "identities", `bucket=${bucket}.json.gz`),
      identityColumns,
      rows
    );
  }
});

function writePrefixTables(rows, key, prefixLen, dir) {
  const groups = new Map();
  for (const row of rows) {
    const raw = String(row[key] ?? "");
    if (!raw) continue;
    const prefix = raw.slice(0, Math.min(prefixLen, raw.length));
    const group = groups.get(prefix) ?? [];
    group.push(row);
    groups.set(prefix, group);
  }
  let bytes = 0;
  for (const [prefix, group] of groups) {
    bytes += writeCompact(path.join(out, dir, `prefix=${prefix}.json.gz`), [key, "DOT_NUMBER"], group);
  }
  return { groups: groups.size, bytes };
}

const mcStats = await timed("mc compact index", async () => {
  const rows = await all(
    `SELECT CAST(mc AS VARCHAR) AS mc, DOT_NUMBER
     FROM read_parquet('${sqlPath(path.join(bucketParquets, "mc_index.parquet"))}')
     WHERE mc IS NOT NULL
     ORDER BY mc`
  );
  return { rows: rows.length, ...writePrefixTables(rows, "mc", mcPrefixLen, "mc") };
});

const phoneStats = await timed("phone compact index", async () => {
  const rows = await all(
    `SELECT ph, DOT_NUMBER
     FROM read_parquet('${sqlPath(path.join(bucketParquets, "phone_index.parquet"))}')
     WHERE ph IS NOT NULL AND length(ph) >= 7
     ORDER BY ph`
  );
  return { rows: rows.length, ...writePrefixTables(rows, "ph", phonePrefixLen, "phone") };
});

const metadata = {
  format: "compact-table-v1",
  carrierColumns: carrierColumns.length,
  identityColumns: identityColumns.length,
  carrierBuckets: carrierFiles.length,
  identityBuckets: identityFiles.length,
  carrierRows: carrierRowsTotal,
  identityRows: identityRowsTotal,
  carrierBytes,
  identityBytes,
  mcPrefixLen,
  phonePrefixLen,
  mc: mcStats,
  phone: phoneStats,
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`wrote ${path.relative(root, out)}`);
