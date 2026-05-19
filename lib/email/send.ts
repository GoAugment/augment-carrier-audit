/**
 * SendGrid outbound for safe@augie.ai replies.
 *
 * Single function: send a plain-text reply on the broker's existing thread.
 * No template rendering, no attachments, no HTML. The formatReply() function
 * produces the body; this is just transport.
 *
 * Threading: we set In-Reply-To and References to the original Message-ID
 * so the reply lands in the same thread in the broker's mail client (not
 * a new inbox row). SendGrid passes these headers through if we set them
 * on the send.
 */
import sgMail from "@sendgrid/mail";

let _initialized = false;
function init() {
  if (_initialized) return;
  const key = process.env.SENDGRID_API_KEY;
  if (!key) throw new Error("SENDGRID_API_KEY env var not set");
  sgMail.setApiKey(key);
  _initialized = true;
}

export interface ReplyParams {
  to: string;
  subject: string;
  text: string;
  /** HTML alternative — SendGrid sends multipart/alternative so the receiving
   *  client picks. Omit to send plain-text only. */
  html?: string;
  /** Optional Message-ID from the inbound email — when present, the reply
   *  threads correctly in the broker's mail client. */
  inReplyTo?: string;
}

export async function sendReply(p: ReplyParams): Promise<void> {
  init();
  const from = process.env.SAFE_EMAIL_FROM;
  if (!from) throw new Error("SAFE_EMAIL_FROM env var not set");

  const headers: Record<string, string> = {};
  if (p.inReplyTo) {
    headers["In-Reply-To"] = p.inReplyTo;
    headers["References"] = p.inReplyTo;
  }

  await sgMail.send({
    to: p.to,
    from,
    subject: p.subject,
    text: p.text,
    ...(p.html ? { html: p.html } : {}),
    headers,
  });
}
