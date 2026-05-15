/**
 * Structured logging that Vercel auto-forwards to Datadog when the Datadog
 * Vercel integration is connected. Each log line is one JSON object — Datadog
 * parses these as fields.
 */
export function logEvent(event: string, data: Record<string, unknown>) {
  const payload = { event, ts: new Date().toISOString(), ...data };
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(payload));
}

/** SHA-256-ish hash for IPs — we never log raw IPs. */
export async function hashIp(ip: string | null | undefined): Promise<string> {
  if (!ip) return "unknown";
  const enc = new TextEncoder().encode(ip + (process.env.IP_HASH_SALT ?? ""));
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf))
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
