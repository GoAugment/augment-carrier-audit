/**
 * Resolves the on-disk path to a FMCSA parquet, fetching it from Vercel Blob
 * at runtime when it isn't present locally.
 *
 * Why: the two parquets are ~95MB each. Bundling both into a serverless
 * function (via includeFiles) + duckdb (62MB) busts Vercel's 250MB limit.
 * So `carrier_aggregates.parquet` stays bundled (95+62 = 157MB, under cap) and
 * `carrier_identity.parquet` is hosted in a PRIVATE Vercel Blob store, streamed
 * to /tmp on the first request per instance and cached for the instance's life
 * (Fluid Compute reuse amortizes the ~1-3s download).
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
    const partial = `${dest}.${process.pid}.part`;
    await pipeline(Readable.fromWeb(result.stream as never), fs.createWriteStream(partial));
    await fs.promises.rename(partial, dest);
    return dest;
  })();

  inflight.set(name, job);
  job.catch(() => inflight.delete(name));
  return job;
}

export const getAggregatesParquetPath = (): Promise<string> => resolveSource(AGGREGATES);
export const getIdentityParquetPath = (): Promise<string> => resolveSource(IDENTITY);
