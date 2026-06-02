/**
 * /check — the bookmarklet's landing tab.
 *
 * The bookmarklet can't POST a whole page across origins on locked-down hosts
 * (Gmail/Outlook/TMS CSP blocks cross-origin form-action and connect-src). So
 * instead it opens THIS page in a new tab and hands the captured HTML over via
 * postMessage (window-to-window messaging isn't CSP-restricted). We then POST
 * it to /api/check (same-origin) and render the returned audit in place.
 *
 * Direct DOT/MC links keep working at /check/{dot} (a separate GET route).
 */
"use client";

import { useEffect, useState } from "react";

const ALLOWED_TYPE = "augie-check-payload";

export default function CheckReceiver() {
  const [status, setStatus] = useState("Waiting for the page…");

  useEffect(() => {
    let handled = false;

    async function run(payload: { html?: string; url?: string; sel?: string }) {
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
          }),
        });
        const html = await res.text();
        // buildReplyHtml returns a full document — swap the whole tab to it.
        document.open();
        document.write(html);
        document.close();
      } catch (e) {
        setStatus("Check failed: " + (e instanceof Error ? e.message : String(e)));
        handled = false;
      }
    }

    function onMessage(ev: MessageEvent) {
      // Accept the payload only from the tab that opened us, and only our
      // agreed message shape.
      if (ev.source !== window.opener) return;
      const d = ev.data;
      if (!d || d.type !== ALLOWED_TYPE) return;
      run(d);
    }

    window.addEventListener("message", onMessage);
    // Tell the opener we're loaded and ready to receive the captured page.
    if (window.opener) {
      try {
        window.opener.postMessage({ type: "augie-check-ready" }, "*");
      } catch {
        /* opener gone */
      }
    } else {
      setStatus(
        "Open this from the Carrier Check bookmarklet on a load / email page. " +
          "Or check a specific carrier directly at /check/{DOT}."
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
