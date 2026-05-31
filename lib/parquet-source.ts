/**
 * Resolves the on-disk path to a FMCSA parquet, fetching it from Vercel Blob
 * at runtime when configured.
 *
 * Why: the two parquets are ~95MB each. Bundling them into the serverless
 * functions (via includeFiles) pushes the function past Vercel's 250MB
 * uncompressed limit once both are present. Instead we host them in Blob and
 * stream each into the function's /tmp on the first request per instance, then
 * point duckdb at the /tmp path. Fluid Compute reuses instances, so the
 * ~1-3s cold-start download amortizes across many requests.
 *
 * Local dev / pipeline: when the BLOB_*_URL env var is unset, we read the
 * committed `data/<name>.parquet` directly — no download, no Blob dependency.
 */
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

type ParquetSource = { localName: string; envUrl: string };

const AGGREGATES: ParquetSource = {
  localName: "carrier_aggregates.parquet",
  envUrl: "BLOB_AGGREGATES_URL",
};
const IDENTITY: ParquetSource = {
  localName: "carrier_identity.parquet",
  envUrl: "BLOB_IDENTITY_URL",
};

// One in-flight (or resolved) download per source, keyed by env var. Concurrent
// requests on a cold instance share a single download; warm requests reuse the
// already-resolved path. A rejected promise is evicted so a later request retries.
const inflight = new Map<string, Promise<string>>();

async function resolveSource(src: ParquetSource): Promise<string> {
  const url = process.env[src.envUrl];
  // No Blob configured → read the committed parquet (local dev, tests, pipeline).
  if (!url) return path.join(process.cwd(), "data", src.localName);

  const existing = inflight.get(src.envUrl);
  if (existing) return existing;

  const job = (async () => {
    const dest = path.join(os.tmpdir(), src.localName);
    // Already downloaded on this warm instance — reuse it.
    try {
      if (fs.statSync(dest).size > 0) return dest;
    } catch {
      /* not present yet */
    }
    const res = await fetch(url);
    if (!res.ok || !res.body) {
      throw new Error(`Blob fetch for ${src.localName} failed: HTTP ${res.status}`);
    }
    // Stream to a per-process temp file, then atomically rename — avoids a
    // partially-written file being read by a concurrent request.
    const partial = `${dest}.${process.pid}.part`;
    await pipeline(Readable.fromWeb(res.body as never), fs.createWriteStream(partial));
    await fs.promises.rename(partial, dest);
    return dest;
  })();

  inflight.set(src.envUrl, job);
  job.catch(() => inflight.delete(src.envUrl));
  return job;
}

export const getAggregatesParquetPath = (): Promise<string> => resolveSource(AGGREGATES);
export const getIdentityParquetPath = (): Promise<string> => resolveSource(IDENTITY);
