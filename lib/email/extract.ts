/**
 * Stage 1 LLM extraction — turn a raw forwarded email into structured
 * identity / authenticity / lane data for the deterministic verdict.
 *
 * Uses claude-haiku-4-5 because:
 *   - Fast (~3-8s p95 for typical email length)
 *   - Cheap (~$0.001/email at typical sizes)
 *   - JSON-mode reliable for this kind of structured extraction
 *
 * The model receives the entire forwarded email payload — text body plus
 * the raw headers section — so it can disambiguate the original carrier
 * (in the forwarded section) from the broker who did the forwarding (the
 * outer envelope). The Stage 1 prompt explicitly tells the model to treat
 * the inner forwarded message as the subject of analysis.
 */
import Anthropic from "@anthropic-ai/sdk";
import { STAGE1_SYSTEM_PROMPT } from "./stage1-prompt";
import type { ExtractedEmail } from "./types";

const MODEL = "claude-haiku-4-5-20251001";

let _client: Anthropic | null = null;
function client(): Anthropic {
  if (_client) return _client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY env var not set");
  }
  _client = new Anthropic({ apiKey });
  return _client;
}

export interface RawEmail {
  /** The forwarded message's full text body (typically includes embedded
   *  "From: ... To: ... Subject: ..." headers from the original carrier
   *  email after a "---------- Forwarded message ----------" delimiter). */
  bodyText: string;
  /** HTML body, if the broker's mail client sent one. The prompt uses
   *  whichever is non-empty; HTML is stripped of tags before LLM input. */
  bodyHtml?: string;
  /** Raw `Headers:` section from SendGrid's Inbound Parse payload. Stage 1
   *  reads Authentication-Results, Reply-To, etc. here. */
  rawHeaders: string;
  /** Outer envelope From (the broker who forwarded). Used by the orchestrator
   *  to know who to reply to, not by the LLM extraction. */
  brokerEmail: string;
  /** Outer subject. Useful context for the LLM but not the focus. */
  subject: string;
}

/**
 * Extract structured identity + behavioral signals from a forwarded email.
 * Throws if the API call fails or the response isn't parseable JSON.
 */
export async function extractEmail(raw: RawEmail): Promise<ExtractedEmail> {
  const userMessage = buildUserMessage(raw);

  const response = await client().messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: STAGE1_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  const block = response.content[0];
  if (block.type !== "text") {
    throw new Error(`Unexpected content type from LLM: ${block.type}`);
  }
  const text = block.text.trim();

  // The prompt says "no markdown wrapping" but be defensive — strip code
  // fences if the model included them despite instructions.
  const json = text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");

  try {
    return JSON.parse(json) as ExtractedEmail;
  } catch (err) {
    throw new Error(
      `Stage 1 LLM returned non-JSON output. First 200 chars: ${text.slice(0, 200)}`
    );
  }
}

function buildUserMessage(raw: RawEmail): string {
  // Prefer plain text. If only HTML is present, strip tags quickly — the
  // Stage 1 prompt doesn't need pretty formatting, just the content.
  const body = raw.bodyText.trim() || htmlToText(raw.bodyHtml ?? "");

  return `Analyze this forwarded email. The outer envelope was sent by a broker (${raw.brokerEmail}) who forwarded a carrier's original outreach email. Focus your extraction on the ORIGINAL CARRIER'S email — typically appearing after a "Forwarded message" / "Original Message" delimiter — not the broker's forwarding wrapper.

Outer subject: ${raw.subject}

=== HEADERS (from the outer forwarded message) ===
${raw.rawHeaders}

=== BODY ===
${body}`;
}

/** Minimal HTML → text conversion. Strips tags and decodes a few common
 *  entities. Doesn't need to be perfect — Claude can read messy text. */
function htmlToText(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}
