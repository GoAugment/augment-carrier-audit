import { NextRequest, NextResponse } from "next/server";
import { hashIp, logEvent } from "@/lib/log";

export const runtime = "nodejs";

interface LeadPayload {
  email: string;
  brokerage?: string;
  summary?: {
    totalLoads: number;
    totalCarriers: number;
    flaggedCarriers: number;
    bySeverity: Record<string, number>;
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Lead capture for the audit tool. Soft gate — the CSV is generated client-side
 * regardless; this endpoint captures the email/brokerage for sales follow-up.
 *
 * If SLACK_LEAD_WEBHOOK_URL is set, we ping it with the lead info. Otherwise
 * we just log to the request stream (Vercel logs surface it) so the lead
 * isn't lost while a webhook is being configured.
 */
export async function POST(req: NextRequest) {
  let body: LeadPayload;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body.email || !EMAIL_RE.test(body.email)) {
    return NextResponse.json(
      { error: "Please provide a valid email address." },
      { status: 400 }
    );
  }

  const ipHash = await hashIp(
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null
  );
  const referer = req.headers.get("referer") ?? null;
  const userAgent = req.headers.get("user-agent") ?? null;

  logEvent("audit_lead_captured", {
    email: body.email,
    brokerage: body.brokerage ?? null,
    summary: body.summary ?? null,
    ipHash,
    referer,
    userAgent,
  });

  const webhook = process.env.SLACK_LEAD_WEBHOOK_URL;
  // Track Slack delivery status — exposed in the response so we can debug
  // without trawling function logs. Set in the live deployment so the
  // browser-side fetch result tells us whether the webhook is wired.
  let slackStatus: "ok" | "missing-env" | "http-error" | "exception" = "missing-env";
  let slackDetail: string | undefined;

  if (webhook) {
    const text =
      `*New audit-tool lead:* ${body.email}` +
      (body.brokerage ? ` (${body.brokerage})` : "") +
      (body.summary
        ? `\n${body.summary.totalLoads} loads · ${body.summary.totalCarriers} carriers · ${body.summary.flaggedCarriers} flagged ` +
          `(${body.summary.bySeverity.Critical ?? 0}C / ${body.summary.bySeverity.High ?? 0}H / ${body.summary.bySeverity.Medium ?? 0}M)`
        : "");
    try {
      const res = await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.ok) {
        slackStatus = "ok";
      } else {
        slackStatus = "http-error";
        slackDetail = `Slack returned ${res.status} ${res.statusText}: ${await res.text().catch(() => "")}`;
        console.error("[lead] Slack webhook HTTP error", slackDetail);
      }
    } catch (e) {
      slackStatus = "exception";
      slackDetail = e instanceof Error ? e.message : String(e);
      console.error("[lead] Slack webhook threw", slackDetail);
    }
  }

  return NextResponse.json({ ok: true, slack: slackStatus, slackDetail });
}

/**
 * PII-free failure beacon.
 *
 * The POST above carries an email address, and corporate DLP appliances block
 * exactly that: on 2026-08-17 a lead POST never reached this function while the
 * same browser's /api/analyze POST (DOT numbers only, no PII) succeeded in the
 * same minute. The client now hands over the CSV regardless, which means the
 * failure is invisible to the user AND to us.
 *
 * This GET carries no body and no email, so a content filter has nothing to
 * match on. It does not recover the lead — it only lets us count how often
 * capture is being blocked, and from which referrers. Without it, enterprise
 * lead-capture rates look like disinterest rather than interception.
 */
export async function GET(req: NextRequest) {
  if (req.nextUrl.searchParams.get("blocked") !== "1") {
    // Not a beacon — the cron/keep-warm probes also hit this path.
    return NextResponse.json({ ok: true });
  }
  const ipHash = await hashIp(
    req.headers.get("x-forwarded-for")?.split(",")[0].trim() ?? null
  );
  logEvent("audit_lead_capture_blocked", {
    // Deliberately NO email: the whole point is that this request stays clean.
    reason: req.nextUrl.searchParams.get("reason") ?? null,
    status: req.nextUrl.searchParams.get("status") ?? null,
    ipHash,
    referer: req.headers.get("referer") ?? null,
    userAgent: req.headers.get("user-agent") ?? null,
  });
  return NextResponse.json({ ok: true, recorded: true });
}
