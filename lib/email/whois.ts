/**
 * Domain age lookup via RDAP (Registration Data Access Protocol, the modern
 * structured replacement for WHOIS).
 *
 * Uses rdap.org as a community-maintained aggregator that proxies queries to
 * the right per-TLD registry. Network call has a 3s timeout — the email-check
 * route runs on a 60s Vercel function so we can afford the wait, but we also
 * don't want a slow RDAP server to dominate the latency budget.
 *
 * Used as a soft signal: very new domains (<90 days) are suspicious in
 * carrier outreach because legitimate trucking businesses typically don't
 * register their domain the week before pitching freight.
 */

// 1.5s timeout — domain age is a low-priority signal, so failing fast saves
// time on the critical path. A null result is treated as "couldn't check"
// rather than a flag.
const RDAP_TIMEOUT_MS = 1500;

export interface DomainAge {
  registeredAt: Date;
  ageDays: number;
}

/** Look up a domain's registration date via RDAP. Returns null on any
 *  failure (timeout, unknown TLD, malformed response) — caller treats a
 *  null result as "couldn't check" rather than as a signal. */
export async function lookupDomainAge(domain: string): Promise<DomainAge | null> {
  const normalized = domain.trim().toLowerCase();
  if (!normalized || !normalized.includes(".")) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RDAP_TIMEOUT_MS);
  try {
    const res = await fetch(`https://rdap.org/domain/${encodeURIComponent(normalized)}`, {
      signal: controller.signal,
      headers: { Accept: "application/rdap+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { events?: Array<{ eventAction?: string; eventDate?: string }> };
    const reg = body.events?.find((e) => e.eventAction === "registration");
    if (!reg?.eventDate) return null;
    const registeredAt = new Date(reg.eventDate);
    if (Number.isNaN(registeredAt.getTime())) return null;
    const ageDays = Math.floor((Date.now() - registeredAt.getTime()) / 86400000);
    return { registeredAt, ageDays };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
