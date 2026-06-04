/**
 * Upload the large FMCSA parquets to Vercel Blob so the serverless functions can
 * fetch them at runtime instead of bundling them (bundling both + duckdb busts
 * Vercel's 250MB per-function limit — see lib/parquet-source.ts).
 *
 * Uploads BOTH full files the /api/check route resolves from Blob:
 *   - carrier_identity.parquet  (never bundled into any function)
 *   - carrier_aggregates.parquet (bundled into /api/analyze & /api/email, but
 *     NOT into /api/check — which needs it from Blob as the authoritative
 *     fallback when a single-check bucket is missing/corrupt)
 *
 * Run this after EVERY monthly data refresh (allowOverwrite keeps the same
 * stable pathname → same URL, so no env changes needed). The single-check
 * buckets are uploaded separately by upload_single_check_buckets.mjs.
 *
 * Setup:
 *   pnpm add -D @vercel/blob
 *   # Blob store connected in the Vercel dashboard injects the token; or:
 *   vercel env pull .env.vercel --environment=production
 *   export BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
 *   node scripts/upload-identity-blob.mjs
 */
import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";

const FILES = ["carrier_identity.parquet", "carrier_aggregates.parquet"];

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Set BLOB_READ_WRITE_TOKEN first (Vercel dashboard → Storage → Blob → tokens).");
  process.exit(1);
}

for (const name of FILES) {
  const body = await readFile(`data/${name}`);
  const { url, pathname } = await put(name, body, {
    access: "private", // private store; runtime reads it back with get({access:'private'})
    addRandomSuffix: false, // stable pathname so the runtime can fetch by name
    allowOverwrite: true, // monthly refresh overwrites in place
    multipart: true, // reliable for the ~100MB payloads
    token: process.env.BLOB_READ_WRITE_TOKEN,
  });
  console.log(`Uploaded private blob: pathname="${pathname}"\n  url=${url}`);
}

console.log("\nRuntime fetches these by pathname via @vercel/blob get() — no env var needed.\n");
