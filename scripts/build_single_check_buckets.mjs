#!/usr/bin/env node
/**
 * Build DOT-bucketed parquet artifacts for low-latency single-carrier checks.
 *
 * The main monthly parquet files are excellent for batch analytics but slow for
 * one-DOT Vercel requests because they are large and not sorted by DOT. These
 * artifacts keep parquet compression while splitting rows into 10k-DOT buckets:
 *
 *   single-check-buckets/
 *     carriers/bucket=330/*.parquet
 *     identities/bucket=330/*.parquet
 *     mc_index.parquet
 *     phone_index.parquet
 *
 * Runtime lookup computes floor(DOT / 10000), reads that one small parquet file,
 * and falls back to the full monthly parquet when buckets are absent.
 */
import fs from "node:fs";
import path from "node:path";
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

const aggregate = path.resolve(root, args.get("aggregate") ?? "data/carrier_aggregates.parquet");
const identity = path.resolve(root, args.get("identity") ?? "data/carrier_identity.parquet");
const out = path.resolve(root, args.get("out") ?? ".context/single-check-buckets");
const bucketSize = Number(args.get("bucket-size") ?? 10_000);

if (!Number.isInteger(bucketSize) || bucketSize <= 0) {
  throw new Error(`Invalid --bucket-size ${bucketSize}`);
}
for (const file of [aggregate, identity]) {
  if (!fs.existsSync(file)) throw new Error(`Missing input: ${file}`);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

const db = new duckdb.Database(":memory:");
const run = (sql) =>
  new Promise((resolve, reject) => db.run(sql, (err) => (err ? reject(err) : resolve())));
const all = (sql) =>
  new Promise((resolve, reject) => db.all(sql, (err, rows) => (err ? reject(err) : resolve(rows))));

function sqlPath(p) {
  return p.replace(/'/g, "''");
}

async function timed(label, fn) {
  const t0 = Date.now();
  await fn();
  console.log(`${label}: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

await timed("carrier buckets", () =>
  run(`
    COPY (
      SELECT floor(DOT_NUMBER / ${bucketSize})::INTEGER AS bucket, *
      FROM read_parquet('${sqlPath(aggregate)}')
      ORDER BY bucket, DOT_NUMBER
    )
    TO '${sqlPath(path.join(out, "carriers"))}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000, PARTITION_BY (bucket))
  `)
);

await timed("identity buckets", () =>
  run(`
    COPY (
      SELECT floor(DOT_NUMBER / ${bucketSize})::INTEGER AS bucket, *
      FROM read_parquet('${sqlPath(identity)}')
      ORDER BY bucket, DOT_NUMBER
    )
    TO '${sqlPath(path.join(out, "identities"))}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000, PARTITION_BY (bucket))
  `)
);

await timed("mc index", () =>
  run(`
    COPY (
      SELECT TRY_CAST(REGEXP_REPLACE(mc_number, '[^0-9]', '', 'g') AS BIGINT) AS mc,
             DOT_NUMBER
      FROM read_parquet('${sqlPath(aggregate)}')
      WHERE mc_number IS NOT NULL AND mc_number <> ''
      ORDER BY mc
    )
    TO '${sqlPath(path.join(out, "mc_index.parquet"))}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
  `)
);

await timed("phone index", () =>
  run(`
    COPY (
      SELECT REGEXP_REPLACE(phone, '[^0-9]', '', 'g') AS ph, DOT_NUMBER
      FROM read_parquet('${sqlPath(identity)}')
      WHERE phone IS NOT NULL AND phone <> ''
      ORDER BY ph
    )
    TO '${sqlPath(path.join(out, "phone_index.parquet"))}'
    (FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 10000)
  `)
);

const [carrierCount] = await all(`SELECT count(*)::BIGINT AS n FROM read_parquet('${sqlPath(aggregate)}')`);
const [identityCount] = await all(`SELECT count(*)::BIGINT AS n FROM read_parquet('${sqlPath(identity)}')`);
const metadata = {
  bucketSize,
  aggregate: path.relative(root, aggregate),
  identity: path.relative(root, identity),
  carriers: Number(carrierCount.n),
  identities: Number(identityCount.n),
  builtAt: new Date().toISOString(),
};
fs.writeFileSync(path.join(out, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

console.log(`wrote ${path.relative(root, out)}`);
