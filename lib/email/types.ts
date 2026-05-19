/**
 * Shared types for the safe@augie.ai email-check pipeline.
 *
 * Pipeline: forwarded email → SendGrid Inbound Parse → LLM Stage 1 extraction
 * (produces ExtractedEmail) → POST to /api/email/check → Verdict → SES reply.
 *
 * The endpoint is intentionally a pure function of ExtractedEmail. Stage 1
 * (LLM call) lives upstream. This keeps the endpoint testable without LLM
 * credentials and lets the orchestrator handle prompt versioning, retries,
 * cost accounting, etc.
 */

/**
 * Output of the Stage 1 LLM prompt. Schema matches the JSON shape in
 * lib/email/stage1-prompt.ts — keep them in sync.
 *
 * Field grouping rationale:
 *   - identity_claims: what the CARRIER says (from email body + signature)
 *   - sender_metadata: what the EMAIL HEADERS reveal (set by the sending server)
 *   - behavioral_signals: how the email is written
 *   - lane: pickup/delivery the carrier wants to run, if specified
 */
export interface ExtractedEmail {
  /** Cleaned message body — signatures, headers, quoted threads stripped. */
  extracted_text: string;
  /** One-sentence overview. */
  summary: string;

  identity_claims: {
    dot_number: string | null;
    /** With prefix: "MC-133655", "FF-51075", "MX-...". */
    mc_number: string | null;
    claimed_company_name: string | null;
    claimed_phone: string | null;
    contact_person: string | null;
  };

  sender_metadata: {
    /** Domain part of From:, lowercased. e.g. "schneider.com". */
    sender_email_domain: string;
    /** Human-readable part of From:. e.g. "Schneider Dispatch". */
    sender_display_name: string;
    /** Domain of Reply-To: when different from From: domain; null otherwise. */
    reply_to_domain: string | null;
    /** From Authentication-Results header. null when header missing. */
    spf_pass: boolean | null;
    dkim_pass: boolean | null;
    dmarc_pass: boolean | null;
  };

  behavioral_signals: {
    is_response_to_load_posting: boolean;
    /** Phrases creating time pressure. Empty array when none. */
    urgency_markers: string[];
    has_signature_block: boolean;
    /** 0=generic, 1=lane only, 2=lane+equipment, 3=specific load ID. */
    specificity_score: 0 | 1 | 2 | 3;
  };

  lane: {
    origin_city: string | null;
    origin_state: string | null;
    destination_city: string | null;
    destination_state: string | null;
    equipment_type: string | null;
  };
}

/**
 * Severity of an individual signal. `info` means "broker should know but it
 * doesn't bump the tier" — surfaced as an evidence row without contributing
 * to the verdict tier.
 */
export type SignalTier = "critical" | "high" | "caution" | "info";

/**
 * Which evaluator produced this signal. Helps brokers understand which
 * dimension of the check fired (and helps us debug coverage gaps).
 */
export type SignalCategory =
  | "audit_tier"           // From the existing carrier-audit analyzer
  | "identity_coherence"   // Claimed identity vs FMCSA record
  | "lane_viability"       // Claimed lane vs operating-area registration
  | "chameleon_cluster"    // Shared phone/officer/address with another DOT
  | "email_authenticity";  // SPF/DKIM/DMARC, Reply-To, free email domain, etc.

export interface Signal {
  category: SignalCategory;
  tier: SignalTier;
  /** Short label for tooltip/list display. */
  label: string;
  /** Longer human-readable explanation. */
  detail: string;
}

/** Composite verdict tier — the worst-firing signal sets this. */
export type VerdictTier = "Critical" | "High" | "Caution" | "Clean";

export interface VerdictCarrierSummary {
  dotNumber: number;
  legalName: string | null;
  mcNumber: string | null;
  /** FMCSA-registered phone — useful in the reply email so the broker can
   *  out-of-band-verify by calling the actual carrier. */
  fmcsaPhone: string | null;
  /** Existing analyzer's tier and reason labels — pulled directly from
   *  analyze(). Surfaces the safety side without us reimplementing it. */
  audit: {
    tier: string;
    reasonLabels: string[];
  };
}

/**
 * Coverage tracking: brokers should know what we could actually check vs
 * what we skipped because the email didn't have the right inputs.
 *
 * For example: a sparse email ("Hi, MC-133655, looking for loads") gives
 * us no lane, no claimed name, no claimed phone — so lane_viability and
 * most identity_coherence checks are skipped. The verdict in that case is
 * mostly "what FMCSA knows about this carrier + email looks legit/fishy
 * from headers." We need to communicate that, not pretend we did more.
 */
export interface VerdictCoverage {
  /** Did we resolve the DOT against the FMCSA parquet? If false, most other
   *  checks couldn't run. */
  carrier_resolved: boolean;
  /** Existing carrier audit (analyzer.ts) ran. Always true when carrier_resolved. */
  audit_tier: boolean;
  /** Email contained an MC# we could compare to FMCSA. */
  mc_match_checked: boolean;
  /** Email contained a claimed company name we could compare to legal_name. */
  name_match_checked: boolean;
  /** Email contained a claimed phone we could compare to FMCSA registered phone. */
  phone_match_checked: boolean;
  /** FMCSA has an email_domain on file we could compare the sender against. */
  sender_domain_match_checked: boolean;
  /** Email contained a specific lane we could test against operating-area flags. */
  lane_viability_checked: boolean;
  /** FMCSA had a phone for this carrier, used for chameleon-cluster lookup. */
  chameleon_cluster_checked: boolean;
  /** Email authentication checks (SPF/DKIM/DMARC, Reply-To). */
  email_auth_checked: boolean;
}

export interface Verdict {
  /** Overall tier — worst-firing signal wins. */
  tier: VerdictTier;
  /** One-sentence broker-facing summary. */
  summary: string;
  /** Resolved carrier info. Null when DOT couldn't be resolved (verdict will
   *  be Critical or Caution with an identity-not-found / no-DOT signal). */
  carrier: VerdictCarrierSummary | null;
  /** Every signal that fired, including info-tier (which don't bump tier). */
  signals: Signal[];
  /** Which evaluators actually ran with full data — see VerdictCoverage. */
  coverage: VerdictCoverage;
  /** Snapshot date stamp. */
  generatedAt: string;
}
