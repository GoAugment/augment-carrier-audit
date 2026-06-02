/**
 * Shared types for the audit@augie.ai email-check pipeline.
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
    /** Full sender email address (lowercased). Used for local-part matching
     *  against FMCSA when the domain is a free provider (gmail.com / yahoo,
     *  etc.) — domain-only match is meaningless on shared providers. */
    sender_email: string;
    /** Domain part of From:, lowercased. e.g. "schneider.com". */
    sender_email_domain: string;
    /** Human-readable part of From:. e.g. "Schneider Dispatch". */
    sender_display_name: string;
    /** Domain of Reply-To: when different from From: domain; null otherwise.
     *  This one IS reliable from inline forwards — Gmail/Outlook preserve
     *  Reply-To in the visible header block. */
    reply_to_domain: string | null;
    // NOTE: SPF/DKIM/DMARC from Authentication-Results were intentionally
    // removed. In typical inline forwards the broker's mail-server auth is
    // what gets preserved, not the carrier's original-send auth — verifying
    // it told us nothing useful about the carrier and gave false confidence.
    // Domain-level reputation (SPF/DMARC/MX existence, WHOIS age) is checked
    // server-side in lib/email/dns-check.ts instead.
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
    /** True when the body mentions hazmat / haz mat / placarded / ORM-D /
     *  UN numbers / hazard classes / specific regulated chemicals. False
     *  for ambiguous "chemicals" references (cleaning supplies, etc.). */
    is_hazmat_load: boolean;
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
  | "lane_coverage"        // BIPD coverage adequacy for the lane's injury-liability
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

/** One axis from analyzer's scorecard, plumbed through for visualization. */
export interface AuditAxisInfo {
  status: string;
  display: string;
  detail: string | null;
  /** Peer-group cutoffs at the P85/P90/P95 percentile boundaries. Pulled
   *  from lib/thresholds.ts via getCutoffs() at composeVerdict time so the
   *  email renderer can draw percentile-marker bars without re-running
   *  the analyzer. Null when the axis has no applicable cutoffs (e.g. crash
   *  axis when mileage exposure is below the threshold). */
  cutoffs: { p85: number; p90: number; p95: number } | null;
  /** Numeric observed value matching the axis scale (% for OOS rates,
   *  crashes-per-million-miles for crash, FMCSA measure for SMS axes). */
  observed: number | null;
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
  /** Existing analyzer's tier and reasons — pulled directly from analyze().
   *  `reasons` is the full {label, detail} list; renderers can split each
   *  into its own failed-check row instead of collapsing into one tier
   *  finding. `reasonLabels` is kept for backwards compatibility (just the
   *  label strings). */
  audit: {
    tier: string;
    reasonLabels: string[];
    reasons: Array<{ label: string; detail: string }>;
  };
  /** Carrier physical-state location ("TX", "WI"), if available. */
  physicalState: string | null;
  /** Carrier physical city + state for the reply line ("Green Bay, WI"). */
  physicalLocation: string | null;
  /** Fleet size from MCS-150 (power_units). Self-reported but useful context. */
  powerUnits: number | null;
  drivers: number | null;
  /** Year the DOT was issued — gives brokers an at-a-glance authority age. */
  dotIssued: string | null;
  /** Most-recent involuntary revocation date (YYYY-MM-DD) within the audit
   *  window. When present AND recent (<24mo), the Authority cell in the
   *  email renders this in red instead of the issue date — the single most
   *  decision-relevant fact for a recently-revoked carrier. */
  mostRecentRevocationDate: string | null;
  /** FMCSA "allowed to operate" flag. "N" means authority has been pulled. */
  allowedToOperate: string | null;
  /** FMCSA MCMIS status_code ("A" = active). Distinguishes a currently-revoked
   *  carrier from one that was revoked then REINSTATED (active again): a recent
   *  involuntary-revocation date alone doesn't mean "currently revoked". */
  statusCode: string | null;
  /** Coarse operating area (interstate_otr / interstate_local / intrastate_*). */
  operatingArea: string | null;
  /** Up to 3 cargo types from the carrier's MCS-150 self-declaration —
   *  enough for the broker to sanity-check fit ("they registered for refrigerated"). */
  cargoCapabilities: string[];
  /** FMCSA-registered email domain (when present) — broker can match
   *  against the sender. */
  fmcsaEmailDomain: string | null;
  /** Full FMCSA-registered email address. Same source as fmcsaEmailDomain,
   *  but the local-part matters for free-mail (gmail.com etc) where domain
   *  match alone is meaningless. */
  fmcsaEmail: string | null;
  /** Current BIPD insurer name when known, for the broker's COI workflow. */
  bipdInsurer: string | null;
  /** BIPD coverage on file (US dollars). FMCSA requires $750k minimum for
   *  general freight; $1M is common for brokers; $5M for hazmat. Broker can
   *  decide on-the-spot whether the carrier meets their cargo's minimum. */
  bipdAmount: number | null;
  /** FMCSA-required BIPD amount (US dollars). 0 means BIPD is not required
   *  for this authority — intrastate-only / private / broker-only carriers
   *  don't need BIPD at all, so an absent BIPD on those is not a flag. */
  bipdRequiredAmount: number;
  /** Cargo insurer on file (if any). Cargo coverage is separate from BIPD
   *  and is the policy that pays the broker when freight is damaged. */
  cargoInsurer: string | null;
  /** Whether FMCSA shows a cargo policy on file. */
  cargoInsuranceOnFile: boolean;
  /** Total inspections in the last 24 months — confidence that this is a
   *  real, operating carrier. Zero is a yellow flag for new authorities. */
  inspections24mo: number;
  /** Recent crash count (24mo). Surface only when > 0. */
  crashes24mo: number;
  /** FMCSA safety rating ("Satisfactory", "Conditional", "Unsatisfactory")
   *  when present AND within the last 5 years. Older ratings are
   *  intentionally suppressed — a 2010 "Satisfactory" tells a broker nothing
   *  useful about today's carrier. */
  safetyRating: string | null;
  /** Date the safety rating was issued (YYYY-MM-DD), or null. */
  safetyRatingDate: string | null;
  /** Primary company officer name from MCS-150 (officer_1) — for
   *  out-of-band verification: broker can ask whether this person is still
   *  with the carrier. */
  companyOfficer: string | null;
  /** Detail breakdowns surfaced in the "FMCSA detail" section. Each is a
   *  pair of [count, oos_count] for the last 24mo. */
  driverInspections: [number, number];
  vehicleInspections: [number, number];
  hazmatInspections: [number, number];
  /** Crash breakdown (24mo) — [fatal, injury, towaway]. Surface only when
   *  totals are non-zero. */
  crashBreakdown: [number, number, number];
  /** Insurance cancellations in last 24 months + most-recent date. > 1 in
   *  24 months is a churn signal (already factored into the audit tier). */
  insuranceCancellations24mo: number;
  insuranceCancellationDate: string | null;
  /** crashes per million miles when computable. */
  crashesPerMillionMiles: number | null;
  /** FMCSA Crash Indicator (severity- and time-weighted ÷ peer-group PU).
   *  Populated by FMCSA only for carriers with crashes in the 24-month
   *  window. Null for crash-free carriers (the great majority). */
  crashMeasure: number | null;
  /** Pre-computed national P-rank label for crashMeasure — e.g. "≥P99 —
   *  top 1% nationally", "≈P95 — top 5%". Null when crashMeasure is null. */
  crashMeasureBand: string | null;
  /** FMCSA SMS BASIC alerts — the most actionable safety signal we have.
   *  Each is "Y" when the carrier is over FMCSA's own intervention threshold
   *  on that dimension. We surface ONLY the ones that fired; an empty list
   *  means none over threshold. */
  basicAlerts: Array<"Unsafe Driving" | "HOS Compliance" | "Driver Fitness" | "Controlled Substances" | "Vehicle Maintenance">;
  /** Pre-built axis-level summaries from the analyzer — the same strings the
   *  website renders on the carrier audit scorecard. Each pairs the carrier's
   *  observed value with the peer-group P95 cutoff (e.g. "Above Severe/P95
   *  cutoff for large fleets (1.32)"), so the email and the web view show
   *  the same percentile context. Null when the axis has nothing to report. */
  auditAxes: {
    crash: AuditAxisInfo | null;
    unsafeDriving: AuditAxisInfo | null;
    hos: AuditAxisInfo | null;
    driverOos: AuditAxisInfo | null;
    vehicleOos: AuditAxisInfo | null;
    hazmatOos: AuditAxisInfo | null;
  };
  /** Carrier's peer group label ("small", "mid-size", "large", etc.) — used
   *  to anchor "above P95 for <peerGroup> fleets" comparisons. */
  peerGroupLabel: string;
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
  /** Body indicated a hazmat load AND we have an HM_Ind value to compare
   *  against. Skipped when the email doesn't reference hazmat. */
  hazmat_match_checked: boolean;
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
