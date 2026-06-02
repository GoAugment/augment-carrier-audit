/**
 * Thin direct-check loader.
 *
 * Direct links like /check/3533697 or /check/MC-1234567 should not run their
 * own DuckDB/parquet function. The warmed heavy path is /api/check, so this
 * route only renders a tiny page that POSTs a synthetic capture to /api/check
 * and swaps the returned audit HTML into the tab.
 */
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function stateParam(v: string | null): string | null {
  if (!v) return null;
  const s = v.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 2);
  return s.length === 2 ? s : null;
}

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function GET(
  req: NextRequest,
  { params }: { params: { dot: string } }
) {
  const sp = req.nextUrl.searchParams;
  const raw = params.dot ?? "";
  const mcParam = sp.get("mc");
  const isMc = !!mcParam || /mc/i.test(raw);
  const digits = (mcParam ?? raw).replace(/\D/g, "");
  const identifier = isMc && digits ? `MC-${digits}` : digits ? `DOT ${digits}` : raw;

  const from = stateParam(sp.get("from"));
  const to = stateParam(sp.get("to"));
  const senderEmail = (sp.get("se") || "").trim().toLowerCase();
  const senderName = (sp.get("sn") || "").trim();
  const replyTo = (sp.get("rt") || "").trim().toLowerCase();

  const lines = [
    identifier,
    from ? `Origin: Unknown, ${from}` : "",
    to ? `Destination: Unknown, ${to}` : "",
    senderEmail
      ? senderName
        ? `From: ${senderName} <${senderEmail}>`
        : `From: ${senderEmail}`
      : "",
    replyTo ? `Reply-To: ${replyTo}` : "",
  ].filter(Boolean);

  const payload = {
    html: `<main>${lines.map((line) => `<p>${escHtml(line)}</p>`).join("")}</main>`,
    sel: lines.join("\n"),
    url: req.url,
  };

  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");
  const title = identifier || "carrier";

  return new NextResponse(
    `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Carrier Check · ${escHtml(title)}</title>
</head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f5f1;color:#5e645f;font:14px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;">
  <main style="text-align:center;padding:24px;">
    <div style="font-weight:600;color:#1e2521;margin-bottom:6px;">Running carrier check</div>
    <div>${escHtml(identifier || "Carrier")}</div>
  </main>
  <script>
    (async function() {
      try {
        const res = await fetch("/api/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(${payloadJson})
        });
        const html = await res.text();
        document.open();
        document.write(html);
        document.close();
      } catch (err) {
        document.body.innerHTML = '<main style="padding:24px;font:14px -apple-system,BlinkMacSystemFont,Segoe UI,Arial,sans-serif;color:#1e2521;background:#f6f5f1;min-height:100vh;">Carrier check failed: ' + String(err).replace(/[<>&]/g, '') + '</main>';
      }
    })();
  </script>
</body>
</html>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    }
  );
}
