/**
 * GET /install — downloads a Netscape-format bookmark file containing the
 * "Check Carrier" bookmarklet WITH the shield favicon baked in via the ICON=
 * data-URI attribute. This is the only reliable way to give a javascript:
 * bookmark a custom icon: a dragged bookmarklet always shows the browser's
 * generic globe, but Chrome stores (and syncs) the ICON= from an imported
 * bookmark. The user imports this file in the bookmark manager, then can move
 * the "Check Carrier" bookmark to their bar and delete the imported folder.
 */
import { NextResponse } from "next/server";
import { CHECK_CARRIER_BOOKMARKLET, CHECK_CARRIER_ICON } from "@/lib/bookmarklet";

export const dynamic = "force-dynamic";

function escAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export async function GET() {
  const html = `<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<H1>Bookmarks</H1>
<DL><p>
    <DT><A HREF="${escAttr(CHECK_CARRIER_BOOKMARKLET)}" ICON="${CHECK_CARRIER_ICON}">Check Carrier</A>
</DL><p>
`;
  return new NextResponse(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": 'attachment; filename="check-carrier.html"',
      "cache-control": "no-store",
    },
  });
}
