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
    <>
      {/* Override the global body background so the iframe inherits whatever
          color the Framer parent page is rendering behind it. Without this
          the iframe shows as a hard white rectangle on dark/cream Framer
          pages. */}
      <style>{`html, body { background: transparent !important; }`}</style>
      <main className="bg-transparent px-2 py-2">
        <AuditWidget compact />
      </main>
    </>
  );
}
