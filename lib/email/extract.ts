/**
 * Stage 1 LLM extraction — turn a raw forwarded email into structured
 * identity / authenticity / lane data for the deterministic verdict.
 *
 * Uses gemini-3.5-flash via Google AI Studio API key (GEMINI_KEY env var).
 * Picked Gemini Flash for:
 *   - Speed (~2-5s p95 for typical email length)
 *   - Cost (~$0.0002/email at typical sizes — ~5× cheaper than Claude Haiku)
 *   - Native JSON-mode output — model refuses to emit non-JSON, removing
 *     the markdown-wrapping failure case
 *
 * The model receives the entire forwarded email payload — text body plus
 * raw headers — so it can disambiguate the original carrier (in the
 * forwarded section) from the broker who did the forwarding. The Stage 1
 * prompt explicitly tells the model to treat the inner forwarded message
 * as the subject of analysis.
 */
import { GoogleGenAI } from "@google/genai";
import { STAGE1_SYSTEM_PROMPT } from "./stage1-prompt";
import type { ExtractedEmail } from "./types";

const MODEL = "gemini-3.5-flash";

let _client: GoogleGenAI | null = null;
function client(): GoogleGenAI {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_KEY env var not set");
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

export interface RawEmail {
  /** The forwarded message's full text body (typically includes embedded
   *  "From: ... To: ... Subject: ..." headers from the original carrier
   *  email after a "---------- Forwarded message ----------" delimiter). */
  bodyText: string;
  /** HTML body, if the broker's mail client sent one. Used when bodyText
   *  is empty; HTML is stripped of tags before LLM input. */
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

  const response = await client().models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    config: {
      systemInstruction: STAGE1_SYSTEM_PROMPT,
      // Native JSON mode — model is constrained to emit valid JSON. The
      // Stage 1 prompt already documents the expected shape inline, so we
      // don't (yet) pass a strict responseSchema. If we ever see schema
      // drift in production, add `responseSchema` referencing the
      // ExtractedEmail structure to lock it down.
      responseMimeType: "application/json",
      temperature: 0,
      // Bumped from 2000 — extracted_text can be long when the carrier
      // forwarded a verbose email; plus the JSON envelope adds overhead.
      // At ~250 tokens for a typical email body and 30-ish fields in
      // ExtractedEmail, 8000 gives us comfortable headroom.
      maxOutputTokens: 8000,
    },
  });

  const text = response.text?.trim() ?? "";
  if (!text) {
    throw new Error("Gemini returned empty response");
  }

  try {
    return JSON.parse(text) as ExtractedEmail;
  } catch (err) {
    // Include the FULL text in the error so we can see what's happening.
    // Truncating to 200 chars hid the actual parse-failure location.
    throw new Error(
      `Stage 1 LLM returned non-JSON output. Parse error: ${err instanceof Error ? err.message : String(err)}. Response (${text.length} chars): ${text}`
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

/** Minimal HTML → text conversion. Strips tags and decodes common
 *  entities. Doesn't need to be perfect — the LLM can read messy text. */
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
