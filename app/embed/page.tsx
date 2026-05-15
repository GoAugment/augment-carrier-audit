/**
 * Bare-chrome embed route. Drop this URL into a Framer Embed component:
 *   https://audit.goaugment.com/embed
 *
 * No nav, no hero, no upsell — just the paste form + results.
 * Posts its height to the parent window so Framer can auto-size the iframe.
 */
import { AuditWidget } from "@/components/AuditWidget";

export const metadata = {
  title: "Carrier Safety Audit",
  // Allow embedding anywhere — Framer sites need this
  // (X-Frame-Options is set in next.config.mjs)
};

export default function EmbedPage() {
  return (
    <main className="bg-white px-6 py-8">
      <AuditWidget compact />
    </main>
  );
}
