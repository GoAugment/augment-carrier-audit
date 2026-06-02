/**
 * POST /api/check — run the single-carrier audit from a captured browser page.
 *
 * Body (JSON): { html: string, url?: string, sel?: string }
 *   html = document.documentElement.outerHTML from the page the broker is on
 *   sel  = the user's text selection, if any (preferred when present)
 *
 * All extraction lives server-side (lib/email/extract-page.ts) so we can
 * iterate on it without re-issuing the bookmarklet. Returns the same
 * email-style audit reply (buildReplyHtml) the GET /check/{dot} route renders.
 *
 * The bookmarklet hands the HTML over via window.open + postMessage to the
 * /check receiver page (CSP-safe on Gmail/Outlook/TMS), which POSTs here.
 */
import { NextRequest, NextResponse } from "next/server";
import { checkCarrierEmail } from "@/lib/email/check";
import { buildReplyHtml } from "@/lib/email/format-reply-html";
import { extractFromPage } from "@/lib/email/extract-page";

export const dynamic = "force-dynamic";
export const maxDuration = 30; // DNS + WHOIS on the sender domain can take a few seconds.

export async function POST(req: NextRequest) {
  let body: { html?: string; url?: string; sel?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Expected JSON body { html, url?, sel? }" }, { status: 400 });
  }

  const extracted = extractFromPage({
    html: body.html ?? "",
    url: body.url,
    sel: body.sel,
  });

  const verdict = await checkCarrierEmail(extracted);
  const html = buildReplyHtml(verdict, extracted);

  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
