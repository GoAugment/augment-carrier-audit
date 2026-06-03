/**
 * Content script — captures the page the broker is looking at and hands it to
 * the background worker on request. This is the same capture the "Check
 * Carrier" bookmarklet does (lib/bookmarklet.ts), just living in an extension
 * so it works on locked-down hosts (Gmail / Outlook / TMS) where the
 * bookmarklet's iframe sidebar is blocked by CSP.
 *
 * We only READ the page (outerHTML, the user's selection, visible form values)
 * and only when the background asks. Nothing is sent anywhere from here.
 */

import type { PageCapture } from "./types";

const SKIP_INPUT_TYPES = /^(password|hidden|checkbox|radio|file|submit|button)$/;
const MAX_HTML = 1_200_000;

/** Visible form field values, paired with their best-guess label. */
function captureFields(): string {
  const out: string[] = [];
  document.querySelectorAll("input, textarea, select").forEach((node) => {
    const el = node as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    const ty = (("type" in el && el.type) || "").toLowerCase();
    if (SKIP_INPUT_TYPES.test(ty)) return;

    let v: string;
    if (el.tagName === "SELECT") {
      const sel = el as HTMLSelectElement;
      v = sel.selectedIndex >= 0 && sel.options[sel.selectedIndex]
        ? sel.options[sel.selectedIndex].text
        : "";
    } else {
      v = (el as HTMLInputElement).value;
    }
    v = (v == null ? "" : String(v)).trim();
    if (!v) return;

    let lbl = "";
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) lbl = (l.textContent || "").trim();
    }
    if (!lbl) {
      lbl =
        el.getAttribute("aria-label") ||
        el.getAttribute("placeholder") ||
        el.getAttribute("name") ||
        el.id ||
        "";
    }
    out.push((lbl ? lbl + ": " : "") + v);
  });
  return out.join("\n");
}

function capturePage(): PageCapture {
  const sel = (window.getSelection && String(window.getSelection())) || "";
  const html = document.documentElement.outerHTML
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .slice(0, MAX_HTML);
  return { html, url: location.href, sel, fields: captureFields() };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "CAPTURE_PAGE") {
    try {
      sendResponse({ ok: true, capture: capturePage() });
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Synchronous response; no need to return true.
});
