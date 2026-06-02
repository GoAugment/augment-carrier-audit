/**
 * POST /api/check — run the single-carrier audit from a captured browser page.
 *
 * Accepts EITHER:
 *   - a normal HTML form POST (application/x-www-form-urlencoded /
 *     multipart) with fields html / url / sel — this is what the bookmarklet
 *     uses, because a cross-origin form submission renders its response in the
 *     target tab and is NOT blocked by Cross-Origin-Opener-Policy the way a
 *     window.open + postMessage handshake is on Gmail/Outlook/TMS, nor by CSP
 *     connect-src the way fetch() is. (form-action CSP could block it, but most
 *     hosts don't set it.)
 *   - a JSON body { html, url?, sel? } — for programmatic callers / the
 *     postMessage receiver page.
 *
 *   html = document.documentElement.outerHTML from the page the broker is on
 *   sel  = the user's text selection, if any (preferred when present)
 *
 * All extraction lives server-side (lib/email/extract-page.ts) so we can
 * iterate on it without re-issuing the bookmarklet. Returns the same
 * email-style audit reply (buildReplyHtml) the GET /check/{dot} route renders.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCarrierEmail } from "@/lib/email/check";
import { buildReplyHtml } from "@/lib/email/format-reply-html";
import { extractFromPage } from "@/lib/email/extract-page";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // DNS + WHOIS on the sender domain can take a few seconds.

export async function POST(req: NextRequest) {
  let html = "";
  let url = "";
  let sel = "";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const b = (await req.json()) as { html?: string; url?: string; sel?: string };
      html = b.html ?? "";
      url = b.url ?? "";
      sel = b.sel ?? "";
    } else {
      // form-urlencoded or multipart (the bookmarklet path)
      const form = await req.formData();
      html = String(form.get("html") ?? "");
      url = String(form.get("url") ?? "");
      sel = String(form.get("sel") ?? "");
    }
  } catch {
    return NextResponse.json(
      { error: "Expected a form POST (html, url?, sel?) or JSON { html, url?, sel? }" },
      { status: 400 }
    );
  }

  const extracted = extractFromPage({ html, url, sel });

  const verdict = await checkCarrierEmail(extracted);
  const replyHtml = buildReplyHtml(verdict, extracted);

  return new NextResponse(replyHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
