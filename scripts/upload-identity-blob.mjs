/**
 * One-time (and per-monthly-refresh) upload of carrier_identity.parquet to
 * Vercel Blob. The serverless functions fetch it from the resulting URL at
 * runtime (see lib/parquet-source.ts) instead of bundling the 96MB file, which
 * would blow Vercel's 250MB per-function limit.
 *
 * Setup:
 *   pnpm add -D @vercel/blob
 *   # create a Blob store in the Vercel dashboard (Storage → Blob), then:
 *   export BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...
 *   node scripts/upload-identity-blob.mjs
 *
 * Then set the printed URL as BLOB_IDENTITY_URL in the project's env vars
 * (Production + Preview) and redeploy. Re-run this script after each monthly
 * data refresh (allowOverwrite keeps the same pathname → same URL).
 */
import { put } from "@vercel/blob";
import { readFile } from "node:fs/promises";

const FILE = "data/carrier_identity.parquet";

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Set BLOB_READ_WRITE_TOKEN first (Vercel dashboard → Storage → Blob → tokens).");
  process.exit(1);
}

const body = await readFile(FILE);
const { url, pathname } = await put("carrier_identity.parquet", body, {
  access: "private", // private store; runtime reads it back with get({access:'private'})
  addRandomSuffix: false, // stable pathname so the runtime can fetch by name
  allowOverwrite: true, // monthly refresh overwrites in place
  multipart: true, // reliable for the ~96MB payload
  token: process.env.BLOB_READ_WRITE_TOKEN,
});

console.log(`\nUploaded private blob: pathname="${pathname}"\n  url=${url}`);
console.log("Runtime fetches it by pathname via @vercel/blob get() — no env var needed.\n");
