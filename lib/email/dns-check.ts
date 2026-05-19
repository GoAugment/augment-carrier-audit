/**
 * Domain-level email-config check via DNS. Verifies whether the carrier's
 * claimed domain is set up for serious email (has MX, SPF, DMARC) — a
 * different question than "did this specific email pass auth," which we
 * can't reliably answer from forwarded mail.
 *
 * Why this is useful even when SPF can't prevent spoofing:
 *   - A real freight carrier domain almost always has MX + SPF + DMARC
 *   - A throwaway / typo-squat / parked domain often has none of these
 *   - Combined with WHOIS age (lib/email/whois.ts), this catches the
 *     "fraudster registered carrierxyz-dispatch.com last week" pattern
 *
 * Free email providers (gmail.com etc) always pass — call sites are expected
 * to skip the check for those domains so we don't pollute verdicts with
 * trivial passes.
 */
import { resolveMx, resolveTxt } from "node:dns/promises";

const DNS_TIMEOUT_MS = 3000;

export interface DomainAuthConfig {
  /** Domain has MX records (accepts inbound mail). */
  hasMx: boolean;
  /** Domain publishes SPF (v=spf1 TXT at apex). */
  hasSpf: boolean;
  /** Domain publishes DMARC (TXT at _dmarc.<domain>). */
  hasDmarc: boolean;
  /** Overall verdict: domain is configured for authenticated business email.
   *  True when MX + at least one of (SPF, DMARC). False when MX is missing
   *  OR neither SPF nor DMARC is set up. */
  configuredForMail: boolean;
}

/** Wrap an awaitable in a hard timeout. Returns null on timeout so callers
 *  treat it as "couldn't check" rather than "failed". */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([
    p,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), ms)),
  ]).catch(() => null);
}

async function hasAnyMx(domain: string): Promise<boolean> {
  const res = await withTimeout(resolveMx(domain), DNS_TIMEOUT_MS);
  return Array.isArray(res) && res.length > 0;
}

async function hasSpfRecord(domain: string): Promise<boolean> {
  const res = await withTimeout(resolveTxt(domain), DNS_TIMEOUT_MS);
  if (!Array.isArray(res)) return false;
  return res.some((chunks) => chunks.join("").trim().toLowerCase().startsWith("v=spf1"));
}

async function hasDmarcRecord(domain: string): Promise<boolean> {
  const res = await withTimeout(resolveTxt(`_dmarc.${domain}`), DNS_TIMEOUT_MS);
  if (!Array.isArray(res)) return false;
  return res.some((chunks) => chunks.join("").trim().toLowerCase().startsWith("v=dmarc1"));
}

/**
 * Check the domain's DNS config. Returns null when the domain itself fails
 * to resolve (caller can treat as "couldn't check"); otherwise returns the
 * three independent booleans plus an overall verdict.
 *
 * Three DNS lookups run in parallel; total latency is bounded by the slowest
 * single record (typically <200ms, capped at DNS_TIMEOUT_MS).
 */
export async function checkDomainAuth(
  domain: string
): Promise<DomainAuthConfig | null> {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || !normalized.includes(".")) return null;

  const [hasMx, hasSpf, hasDmarc] = await Promise.all([
    hasAnyMx(normalized),
    hasSpfRecord(normalized),
    hasDmarcRecord(normalized),
  ]);

  // If none of the three returned true AND MX failed, the domain probably
  // isn't reachable at all. Return null so the caller doesn't render a
  // "domain is misconfigured" finding off what's actually a lookup failure.
  if (!hasMx && !hasSpf && !hasDmarc) return null;

  return {
    hasMx,
    hasSpf,
    hasDmarc,
    configuredForMail: hasMx && (hasSpf || hasDmarc),
  };
}
