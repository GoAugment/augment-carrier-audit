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
import { checkCarrierEmail, lastTimings } from "@/lib/email/check";
import { buildReplyHtml } from "@/lib/email/format-reply-html";
import { extractFromPage, pageDiagnostics } from "@/lib/email/extract-page";

function serverTiming(): string {
  return Object.entries(lastTimings)
    .map(([k, v]) => `${k}=${v}`)
    .join(";");
}

export const dynamic = "force-dynamic";
export const maxDuration = 30; // DNS on the sender domain can take a few seconds.

// GET = warmup. A Vercel cron pings this so the function instance stays hot:
// duckdb is initialized, the 96MB identity parquet is pulled to /tmp, and the
// per-instance caches (carrier/identity/mc→dot) are primed — so a real user's
// click hits a warm instance (~sub-second) instead of a ~5s cold start.
export async function GET() {
  const t0 = Date.now();
  try {
    // Resolve via MC (not DOT) so the warmup also builds the in-memory mc_index,
    // keeping the first real MC lookup off the slow full-parquet-scan path.
    await checkCarrierEmail({
      extracted_text: "",
      summary: "warmup",
      identity_claims: { dot_number: null, mc_number: "MC-67717", claimed_company_name: null, claimed_phone: null, contact_person: null },
      sender_metadata: { sender_email: "", sender_email_domain: "", sender_display_name: "", reply_to_domain: null },
      behavioral_signals: { is_response_to_load_posting: false, urgency_markers: [], has_signature_block: true, specificity_score: 0 },
      lane: { origin_city: null, origin_state: null, destination_city: null, destination_state: null, equipment_type: null, is_hazmat_load: false },
    });
  } catch {
    /* warmup best-effort */
  }
  return NextResponse.json({ ok: true, warmedMs: Date.now() - t0 });
}

export async function POST(req: NextRequest) {
  let html = "";
  let url = "";
  let sel = "";
  let fields = "";
  let debug = req.nextUrl.searchParams.get("debug") === "1";
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const b = (await req.json()) as {
        html?: string; url?: string; sel?: string; fields?: string; debug?: unknown;
      };
      html = b.html ?? "";
      url = b.url ?? "";
      sel = b.sel ?? "";
      fields = b.fields ?? "";
      if (b.debug) debug = true;
    } else {
      // form-urlencoded or multipart (the bookmarklet path)
      const form = await req.formData();
      html = String(form.get("html") ?? "");
      url = String(form.get("url") ?? "");
      sel = String(form.get("sel") ?? "");
      fields = String(form.get("fields") ?? "");
      if (form.get("debug")) debug = true;
    }
  } catch {
    return NextResponse.json(
      { error: "Expected a form POST (html, url?, sel?, fields?) or JSON" },
      { status: 400 }
    );
  }

  // Trace mode: show exactly what the scraper saw + extracted, so we can tune
  // the parser against a real host (T1, Outlook, …) without copy-pasting HTML.
  if (debug) {
    const diag = pageDiagnostics({ html, url, sel, fields });
    return new NextResponse(renderDebug(diag, url), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    });
  }

  const extracted = extractFromPage({ html, url, sel, fields });

  const reqStart = Date.now();
  const verdict = await checkCarrierEmail(extracted);
  const checkMs = Date.now() - reqStart;
  const replyHtml = buildReplyHtml(verdict, extracted);

  return new NextResponse(replyHtml, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      // Per-phase timings for diagnosing prod latency. (Vercel strips
      // Server-Timing, so use a custom header.) `check=` is the whole verdict;
      // the rest are computeVerdict phases (all 0 on a verdict-cache hit).
      "x-check-timing": `check=${checkMs};${serverTiming()}`,
    },
  });
}

function renderDebug(
  diag: import("@/lib/email/extract-page").PageDiagnostics,
  url: string
): string {
  const esc = (s: unknown) =>
    String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  const list = (title: string, items: string[]) =>
    `<h3>${esc(title)} <span style="color:#888;font-weight:400">(${items.length})</span></h3>` +
    (items.length
      ? `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`
      : `<p style="color:#888">— none —</p>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>Carrier Check · trace</title></head>
<body style="margin:0;padding:16px;font:13px/1.5 -apple-system,Segoe UI,Arial,sans-serif;color:#1e2521;background:#f6f5f1;">
<h2 style="margin:0 0 4px">Carrier Check — extraction trace</h2>
<div style="color:#888;margin-bottom:12px;word-break:break-all">${esc(url)}</div>
<div style="background:#fff;border:1px solid #e6e5e0;border-radius:6px;padding:12px;margin-bottom:12px">
  <b>Extracted</b>
  <pre style="white-space:pre-wrap;word-break:break-word;margin:8px 0 0">${esc(JSON.stringify(diag.extracted, null, 2))}</pre>
</div>
<div style="color:#5e645f;margin-bottom:12px">
  html: ${diag.htmlLength.toLocaleString()} chars · scanned text: ${diag.textLength.toLocaleString()} chars · used selection: ${diag.usedSelection}
</div>
${list('"DOT" contexts', diag.dotContexts)}
${list('"MC" contexts', diag.mcContexts)}
${list('"carrier" contexts', diag.carrierContexts)}
${list("Sender candidates", diag.senderCandidates)}
${list("4–8 digit numbers seen", diag.numbers4to8)}
<h3>First 1,800 chars of scanned text</h3>
<pre style="white-space:pre-wrap;word-break:break-word;background:#fff;border:1px solid #e6e5e0;border-radius:6px;padding:12px">${esc(diag.textHead)}</pre>
</body></html>`;
}
