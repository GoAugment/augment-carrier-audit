import { createHash, timingSafeEqual } from "node:crypto";

/**
 * API-key auth for the customer-facing carrier API.
 *
 * Keys live in the AUDIT_API_KEYS env var as comma-separated `label:key` pairs:
 *
 *   AUDIT_API_KEYS="acme:ak_live_9f2...,penske:ak_live_3c8..."
 *
 * The label is what gets logged, never the key, so usage is attributable without
 * putting credential material in the log stream.
 *
 * Deliberately behind ONE function so the store can move to Vercel Edge Config
 * (~15ms edge reads, add/revoke without a deploy) by replacing `loadKeys()` only.
 * Env vars are fine for a first customer but need a redeploy to revoke, which is
 * the wrong property for a credential.
 */
export interface ApiCaller {
  /** Human label for the key holder — safe to log. */
  label: string;
}

function loadKeys(): Map<string, string> {
  // digest -> label. We store the digest so a comparison never needs the raw key
  // in memory beyond parsing, and so lengths always match for timingSafeEqual.
  const out = new Map<string, string>();
  const raw = process.env.AUDIT_API_KEYS ?? "";
  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue; // malformed; ignore rather than half-trust it
    const label = trimmed.slice(0, idx).trim();
    const key = trimmed.slice(idx + 1).trim();
    if (!label || !key) continue;
    out.set(sha256(key), label);
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time compare of two equal-length hex digests. */
function digestsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Resolve the caller from `Authorization: Bearer <key>` or `x-api-key: <key>`.
 * Returns null when the key is absent or unrecognised — the route decides the
 * status code, since "no key" and "bad key" are the same answer to a client but
 * different things to log.
 */
export function authenticate(req: Request): ApiCaller | null {
  const auth = req.headers.get("authorization");
  const bearer = auth?.toLowerCase().startsWith("bearer ")
    ? auth.slice(7).trim()
    : null;
  const presented = bearer || req.headers.get("x-api-key")?.trim() || null;
  if (!presented) return null;

  const keys = loadKeys();
  if (keys.size === 0) return null; // nothing configured; fail closed

  const presentedDigest = sha256(presented);
  // Walk every entry rather than a map lookup: a Map.get short-circuits on the
  // first byte difference, which leaks timing. The key count is tiny.
  let label: string | null = null;
  for (const [digest, l] of keys) {
    if (digestsEqual(digest, presentedDigest)) label = l;
  }
  return label ? { label } : null;
}

/** True when any key is configured. Lets a route distinguish "misconfigured
 *  deployment" from "caller sent a bad key", which are very different bugs. */
export function authConfigured(): boolean {
  return loadKeys().size > 0;
}
