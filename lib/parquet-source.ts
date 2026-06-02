/**
 * Resolves the on-disk path to a FMCSA parquet, fetching it from Vercel Blob
 * at runtime when it isn't present locally.
 *
 * Why: the two parquets are ~95MB each. Bundling both into a serverless
 * function (via includeFiles) + duckdb (62MB) busts Vercel's 250MB limit.
 * So the large monthly parquets can be hosted in a PRIVATE Vercel Blob store,
 * streamed to /tmp on the first request per instance, and cached for the
 * instance's life (Fluid Compute reuse amortizes the download). Single-carrier
 * checks can also use smaller DOT-bucket parquet blobs first and only fall back
 * to the full files when those buckets are absent.
 *
 * Resolution per file: if `data/<name>.parquet` exists locally, use it — covers
 * local dev, tests, the pipeline, and the still-bundled aggregates on Vercel.
 * Otherwise (identity parquet on Vercel) fetch it from Blob by pathname using
 * `@vercel/blob get({access:'private'})` with BLOB_READ_WRITE_TOKEN (injected
 * into every Vercel environment when the store is connected). No URL env var
 * needed — the pathname is stable (uploaded with addRandomSuffix:false).
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const AGGREGATES = "carrier_aggregates.parquet";
const IDENTITY = "carrier_identity.parquet";
// Small (~4MB) precomputed identity-risk signals — bundled into the functions,
// so /api/analyze reads it locally instead of fetching the 96MB identity
// parquet from Blob and running a 2M-row self-join on every request. Built
// offline by scripts/build_risk_signals.cjs (re-run on the monthly refresh).
const RISK_SIGNALS = "carrier_risk_signals.parquet";
export const DOT_BUCKET_SIZE = 10_000;

// One in-flight (or resolved) download per file. Concurrent requests on a cold
// instance share a single download; warm requests reuse the /tmp file. A
// rejected promise is evicted so a later request can retry.
const inflight = new Map<string, Promise<string>>();

async function resolveSource(name: string): Promise<string> {
  const local = path.join(process.cwd(), "data", name);
  try {
    if (fs.statSync(local).size > 0) return local;
  } catch {
    /* not bundled here — fall through to Blob */
  }

  const existing = inflight.get(name);
  if (existing) return existing;

  const job = (async () => {
    const dest = path.join(os.tmpdir(), name);
    try {
      if (fs.statSync(dest).size > 0) return dest; // already pulled on this instance
    } catch {
      /* not downloaded yet */
    }
    const { get } = await import("@vercel/blob");
    const result = await get(name, {
      access: "private",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });
    if (!result || result.statusCode !== 200) {
      throw new Error(
        `Blob get for ${name} failed (status ${result?.statusCode ?? "not found"})`
      );
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const partial = `${dest}.${process.pid}.part`;
    await pipeline(Readable.fromWeb(result.stream as never), fs.createWriteStream(partial));
    await fs.promises.rename(partial, dest);
    return dest;
  })();

  inflight.set(name, job);
  job.catch(() => inflight.delete(name));
  return job;
}

async function resolveOptionalSource(name: string): Promise<string | null> {
  const local = path.join(process.cwd(), "data", name);
  try {
    if (fs.statSync(local).size > 0) return local;
  } catch {
    /* not bundled here — fall through */
  }

  const dest = path.join(os.tmpdir(), name);
  try {
    if (fs.statSync(dest).size > 0) return dest;
  } catch {
    /* not downloaded yet */
  }

  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    return await resolveSource(name);
  } catch {
    return null;
  }
}

function bucketForDot(dot: number): number {
  return Math.floor(dot / DOT_BUCKET_SIZE);
}

function localBucketGlob(kind: "carriers" | "identities", bucket: number): string | null {
  const base = path.join(process.cwd(), "data", "single-check-buckets", kind);
  const flat = path.join(base, `${bucket}.parquet`);
  try {
    if (fs.statSync(flat).size > 0) return flat;
  } catch {
    /* no local flat bucket */
  }
  const dir = path.join(base, `bucket=${bucket}`);
  try {
    if (fs.statSync(dir).isDirectory()) return path.join(dir, "*.parquet");
  } catch {
    /* no local bucket directory */
  }
  return null;
}

async function resolveBucketSource(
  kind: "carriers" | "identities",
  dot: number
): Promise<string | null> {
  const bucket = bucketForDot(dot);
  const localGlob = localBucketGlob(kind, bucket);
  if (localGlob) return localGlob;
  const partitioned = await resolveOptionalSource(
    `single-check-buckets/${kind}/bucket=${bucket}/data_0.parquet`
  );
  if (partitioned) return partitioned;
  return resolveOptionalSource(`single-check-buckets/${kind}/${bucket}.parquet`);
}

export const getAggregatesParquetPath = (): Promise<string> => resolveSource(AGGREGATES);
export const getIdentityParquetPath = (): Promise<string> => resolveSource(IDENTITY);
export const getRiskSignalsParquetPath = (): Promise<string> => resolveSource(RISK_SIGNALS);
export const getCarrierBucketParquetPath = (dot: number): Promise<string | null> =>
  resolveBucketSource("carriers", dot);
export const getIdentityBucketParquetPath = (dot: number): Promise<string | null> =>
  resolveBucketSource("identities", dot);
export const getMcIndexParquetPath = (): Promise<string | null> =>
  resolveOptionalSource("single-check-buckets/mc_index.parquet");
export const getPhoneIndexParquetPath = (): Promise<string | null> =>
  resolveOptionalSource("single-check-buckets/phone_index.parquet");
