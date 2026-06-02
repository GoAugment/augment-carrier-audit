#!/usr/bin/env node
/**
 * Upload the generated single-check bucket parquet artifacts to Vercel Blob.
 *
 * Runtime paths are intentionally stable and match lib/parquet-source.ts:
 *   single-check-buckets/carriers/bucket=330/data_0.parquet
 *   single-check-buckets/identities/bucket=330/data_0.parquet
 *   single-check-buckets/mc_index.parquet
 *   single-check-buckets/phone_index.parquet
 */
import { put } from "@vercel/blob";
import fs from "node:fs";
import path from "node:path";

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

const src = path.resolve(root, args.get("src") ?? "data/single-check-buckets");
const prefix = String(args.get("prefix") ?? "single-check-buckets").replace(/\/+$/, "");
const dryRun = args.has("dry-run");
const concurrency = Number(args.get("concurrency") ?? 8);

if (!Number.isInteger(concurrency) || concurrency <= 0) {
  throw new Error(`Invalid --concurrency ${concurrency}`);
}
if (!fs.existsSync(src)) throw new Error(`Missing bucket directory: ${src}`);
if (!dryRun && !process.env.BLOB_READ_WRITE_TOKEN) {
  throw new Error("Set BLOB_READ_WRITE_TOKEN before uploading.");
}

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && (entry.name.endsWith(".parquet") || entry.name === "metadata.json")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(src).sort();
const totalBytes = files.reduce((sum, file) => sum + fs.statSync(file).size, 0);
console.log(
  `${dryRun ? "would upload" : "uploading"} ${files.length} files (${(totalBytes / 1024 / 1024).toFixed(
    1
  )} MB) to ${prefix}/`
);

let next = 0;
let uploaded = 0;
let uploadedBytes = 0;
let lastLog = Date.now();

async function worker() {
  for (;;) {
    const index = next++;
    if (index >= files.length) return;
    const file = files[index];
    const rel = path.relative(src, file).split(path.sep).join("/");
    const pathname = `${prefix}/${rel}`;
    const size = fs.statSync(file).size;

    if (!dryRun) {
      await put(pathname, fs.createReadStream(file), {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: file.endsWith(".json") ? "application/json" : "application/octet-stream",
        multipart: size > 8 * 1024 * 1024,
        token: process.env.BLOB_READ_WRITE_TOKEN,
      });
    }

    uploaded += 1;
    uploadedBytes += size;
    const now = Date.now();
    if (now - lastLog > 5000 || uploaded === files.length) {
      lastLog = now;
      console.log(
        `${uploaded}/${files.length} (${(uploadedBytes / 1024 / 1024).toFixed(1)} MB)`
      );
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
console.log("done");
