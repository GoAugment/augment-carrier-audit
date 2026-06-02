/**
 * /check — the bookmarklet's receiver, used as an in-page SIDEBAR iframe when
 * the host page allows framing us, or as a popup tab when it doesn't.
 *
 * The bookmarklet can't POST a whole page across origins on locked-down hosts
 * (CSP form-action / connect-src). So it embeds THIS page (same-origin to us,
 * so OUR fetch to /api/check is unrestricted) and hands the captured page over
 * via postMessage. We signal "augie-frame-ready" to whoever embedded us
 * (parent for an iframe, opener for a popup); the bookmarklet replies with the
 * payload; we POST it to /api/check and render the audit in place.
 *
 * The bookmarklet decides iframe-vs-popup by probing: it embeds us in a hidden
 * iframe and waits for our ready signal — if CSP blocks the frame we never
 * load, it times out, and it falls back to a popup tab.
 */
"use client";

import { useEffect, useState } from "react";

const PAYLOAD_TYPE = "augie-check-payload";
const READY_TYPE = "augie-frame-ready";

export default function CheckReceiver() {
  const [status, setStatus] = useState("Loading…");

  useEffect(() => {
    let handled = false;
    // Whoever embedded us: the parent window when framed (sidebar), else the
    // opener window when popped (new tab).
    const host: Window | null =
      window.parent && window.parent !== window ? window.parent : window.opener;

    async function run(payload: {
      html?: string;
      url?: string;
      sel?: string;
      fields?: string;
    }) {
      if (handled) return;
      handled = true;
      setStatus("Running the carrier check…");
      try {
        const res = await fetch("/api/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            html: payload.html ?? "",
            url: payload.url ?? "",
            sel: payload.sel ?? "",
            fields: payload.fields ?? "",
          }),
        });
        const html = await res.text();
        document.open();
        document.write(html);
        document.close();
      } catch (e) {
        setStatus("Check failed: " + (e instanceof Error ? e.message : String(e)));
        handled = false;
      }
    }

    function onMessage(ev: MessageEvent) {
      if (host && ev.source !== host) return;
      const d = ev.data;
      if (!d || d.type !== PAYLOAD_TYPE) return;
      run(d);
    }

    window.addEventListener("message", onMessage);
    if (host) {
      try {
        host.postMessage({ type: READY_TYPE }, "*");
      } catch {
        /* host gone */
      }
    } else {
      setStatus(
        "Open this from the Carrier Check bookmarklet on a load / email page, " +
          "or check a specific carrier at /check/{DOT}."
      );
    }

    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#f6f5f1",
        color: "#5e645f",
        fontFamily:
          "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
        fontSize: 14,
        padding: 24,
        textAlign: "center",
      }}
    >
      {status}
    </main>
  );
}
