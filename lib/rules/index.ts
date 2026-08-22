/**
 * Rule registry, the single source of truth for every flag we surface to
 * users, across the website carrier audit AND the email reply.
 *
 * Each rule entry has a stable ID, plain-language definition, threshold
 * descriptions, data sources, and test fixtures. Both `lib/analyzer.ts`
 * (website) and `lib/email/check.ts` (email) consume rules from here, so
 * the two surfaces can't drift in label or wording.
 *
 * Adding a rule:
 *   1. Append an entry below.
 *   2. Wire the evaluator (in lib/analyzer.ts or lib/email/check.ts) to
 *      reference the rule's id + label + definition.
 *   3. Add test fixtures by running:
 *        pnpm tsx scripts/refresh_fixtures.ts <ruleId>
 *      which queries the current parquet for DOTs that match each tier.
 *   4. Run `pnpm test:rules` and confirm green.
 *
 * Removing a rule:
 *   Delete the entry, the evaluator, and any references in renderers.
 *   The test suite will fail loudly if anything else references the id.
 */
import type { Rule, RuleId } from "./types";

export const RULES: Rule[] = [
  // ---------------------------------------------------------------------
  // AUTHORITY
  // ---------------------------------------------------------------------
  {
    id: "authority-not-active",
    category: "authority",
    label: "Authority not active",
    definition:
      "FMCSA's operating-authority status for this DOT is not Active. Status codes other than 'A' (e.g. 'I' inactive, 'V' voluntarily-revoked) mean the carrier is not currently authorized to haul. Brokers should never tender freight to a non-active authority.",
    thresholds: {
      critical: "FMCSA status_code is anything other than 'A' (Active).",
    },
    fixtures: {
      critical: { dot: 2439172, reason: "HR SERVICES LLC: status_code=I (Aug 2026 snapshot)." },
      none: { dot: 53467, reason: "Werner Enterprises: status_code=A." },
    },
  },
  {
    id: "new-authority",
    category: "authority",
    label: "New authority",
    definition:
      "FMCSA issued the DOT less than the industry's 90-day chameleon-prevention tenure floor. Brand-new authorities have no operating history and are statistically over-represented in re-incarnation patterns: the typical chameleon registers a new DOT shortly after their old one was revoked, and the new authority is often paired with a low-activity / tiny fleet.",
    thresholds: {
      critical: "DOT issued less than 90 days ago.",
    },
    fixtures: {
      // Note: fixtures for this rule are inherently volatile, the DOT
      // crosses the 90-day threshold ~3 months after registration and
      // stops triggering. Refresh by re-running the find_rule_fixtures.py
      // query against the latest parquet snapshot.
      critical: { dot: 4586265, reason: "MOVERS 4 U LLC: dot_add_date 2026-06-23, < 90 days at snapshot." },
      none: { dot: 53467, reason: "Werner: established carrier, > 30 years old." },
    },
  },

  // ---------------------------------------------------------------------
  // SAFETY RATING (FMCSA's official compliance review verdict)
  // ---------------------------------------------------------------------
  {
    id: "safety-rating-unsatisfactory",
    category: "authority",
    label: "Safety rating: Unsatisfactory",
    definition:
      "FMCSA's most recent compliance review rated this carrier Unsatisfactory. An Unsatisfactory rating is the worst possible FMCSA verdict and triggers an out-of-service order for hazmat and passenger carriers. Property carriers can theoretically continue operating, but the industry standard is to refuse the load.",
    thresholds: {
      critical: "Safety rating = Unsatisfactory.",
    },
    fixtures: {
      critical: { dot: 3720632, reason: "STATE AUTO GROUP LLC: Unsatisfactory rated 2026-05-27." },
      none: { dot: 53467, reason: "Werner: Satisfactory." },
    },
  },
  {
    id: "safety-rating-conditional",
    category: "authority",
    label: "Safety rating: Conditional",
    definition:
      "FMCSA's most recent compliance review rated this carrier Conditional. A Conditional rating means the carrier's safety management practices have specific deficiencies; FMCSA continues to monitor and the rating may downgrade to Unsatisfactory. The industry standard is to refuse loads from Conditional carriers.",
    thresholds: {
      critical: "Safety rating = Conditional.",
    },
    fixtures: {
      critical: { dot: 305573, reason: "R & R TRANSPORTATION INC: Conditional rated 2026-04-21." },
      none: { dot: 53467, reason: "Werner: Satisfactory." },
    },
  },

  // ---------------------------------------------------------------------
  // INSURANCE
  // ---------------------------------------------------------------------
  {
    id: "insurance-lapsed",
    category: "insurance",
    label: "Insurance lapsed",
    definition:
      "FMCSA-required BIPD (Bodily Injury / Property Damage) liability insurance is missing or below the required minimum for this carrier's authority. Tendering freight to an underinsured carrier exposes the broker to the full loss with no recourse, since the carrier's policy is the broker's first line of recovery in a cargo claim or accident.",
    thresholds: {
      critical: "$0 BIPD on file when FMCSA requires it, or on-file amount below FMCSA minimum.",
    },
    fixtures: {
      critical: { dot: 3670294, reason: "ROAD EXPERTS LLC: $0 BIPD on file, BIPD required (used in snapshot baseline)." },
      none: { dot: 53467, reason: "Werner: $5M BIPD on file." },
    },
  },
  // Note: cargo-insurance-not-on-file was previously documented here but its
  // analyzer function (classifyCargoInsurance) was never wired into the
  // main analyze() flow, see lib/analyzer.ts:836-838 comment. The FMCSA
  // bulk-file cargo-on-file flag has too many false positives (large
  // carriers self-insure cargo and don't file with FMCSA; brokers verify
  // cargo COI direct with the carrier). Rule + dead function removed
  // until a more reliable cargo signal is available.
  {
    id: "insurance-rapid-replace",
    category: "insurance",
    label: "Rapid replace + cancellation history",
    definition:
      "Insurance policy was cancelled and replaced within roughly 30 days, paired with three or more prior cancellations in the last 24 months. Quick policy swap by itself is a routine renewal pattern, but combined with repeated prior cancellations it's a re-incarnation move: a carrier with a damaged insurance history cycles policies to maintain on-file appearance.",
    thresholds: {
      critical: "Rapid-replace flag AND ≥3 true cancellations in 24 months.",
    },
    fixtures: {
      critical: { dot: 3440451, reason: "UMAX INC: rapid replace flag + 4 distinct policies cancelled in 24mo." },
      none: { dot: 53467, reason: "Werner: stable insurance, no rapid replace." },
    },
  },
  {
    id: "insurance-severe-churn",
    category: "insurance",
    label: "Severe insurance churn",
    definition:
      "Five or more distinct insurance policies cancelled in the last 24 months, the top 0.3% (P99.7) of carriers nationally. Each distinct policy means a separate underwriter dropped this carrier (multiple cancellation notices on the same policy don't count). Repeated insurer dropouts indicate the carrier is on the edge of becoming uninsurable; the next cancellation may not be replaced. Distinct from administrative billing-cycle issues, where a single insurer repeatedly cancels and reinstates the same policy, that pattern doesn't fire this rule.",
    thresholds: {
      critical: "≥5 distinct policies cancelled in 24 months.",
    },
    fixtures: {
      critical: { dot: 3904606, reason: "CIRCLE W TRANSPORT LLC: 11 distinct policies cancelled in 24mo." },
      none: { dot: 53467, reason: "Werner: 0 distinct policies cancelled in 24mo." },
    },
  },
  {
    id: "insurance-churn",
    category: "insurance",
    label: "Insurance churn",
    definition:
      "Three to four distinct insurance policies cancelled in the last 24 months, between the 99th and 99.6th national percentiles. The signal counts unique policy numbers, not cancellation events, so a carrier whose single insurer repeatedly cancels and reinstates the same policy (billing-cycle issues) does not trigger here. Frequent distinct-insurer dropouts suggest the carrier is being shopped between underwriters, often due to claim history or premium nonpayment. At 5+ distinct cancellations the rule escalates to Severe insurance churn.",
    thresholds: {
      caution: "3 or 4 distinct policies cancelled in 24 months (P99-P99.6 band).",
    },
    fixtures: {
      caution: { dot: 3534523, reason: "GLB TRUCKING CORP: 3 distinct policies cancelled in 24mo, no rapid replace, no revocations." },
      none: { dot: 53467, reason: "Werner: 0 distinct cancelled policies." },
    },
  },
  {
    id: "insurance-sub-minimum-bipd",
    category: "insurance",
    label: "Insurance below federal minimum",
    definition:
      "FMCSA's filed BIPD coverage is below the federal $750,000 minimum for general-freight property carriers. Either the carrier is licensed for a coverage class that allows lower limits (rare on a property authority), or they have understated coverage on file. Even when a current policy exists, brokers cannot legally tender to a carrier whose filed limits are below the load's required minimum.",
    thresholds: {
      high: "BIPD on file > $0 and < $750,000 with active property authority.",
    },
    fixtures: {
      // Sampled from May 2026 snapshot. Refresh if filing updates.
      high: { dot: 3881024, reason: "IN A RUSH DELIVERY LLC: $300k BIPD on file, below $750k minimum, otherwise clean." },
      none: { dot: 53467, reason: "Werner: $1M+ BIPD on file." },
    },
  },
  {
    id: "insurance-all-cancel-pattern",
    category: "insurance",
    label: "All-cancel insurance pattern",
    definition:
      "Three or more distinct BIPD policies in the last 24 months, with zero Replaced events recorded, i.e. every policy ends as a Cancellation rather than a continuous Replacement. The pattern indicates the carrier is shopping a new insurer each policy term rather than renewing with the same one, which usually means the prior insurer declined to continue. Distinct from rapid-replace (cancel then immediately re-bind) and from churn (raw cancellation count).",
    thresholds: {
      high:    "≥5 distinct BIPD policies in 24mo with zero Replaced events.",
      caution: "3 or 4 distinct BIPD policies in 24mo with zero Replaced events.",
    },
    fixtures: {
      caution: { dot: 70850, reason: "NORTH EXPRESS INC: 3 cancellations / 3 distinct policies in 24mo, 0 replaces." },
      none: { dot: 53467, reason: "Werner: single renewing policy, normal replacement pattern." },
    },
  },

  // ---------------------------------------------------------------------
  // REVOCATION / ENFORCEMENT
  // ---------------------------------------------------------------------
  {
    id: "recent-revocation",
    category: "authority",
    label: "Recent revocation",
    definition:
      "FMCSA involuntarily revoked this carrier's authority within the last 24 months. A revocation means FMCSA pulled the carrier's authority for non-compliance (failed insurance, biennial-update lapse, safety violations). Even when authority is reinstated, the revocation history is a strong negative signal.",
    thresholds: {
      critical: "≥1 involuntary revocation in the last 24 months.",
    },
    fixtures: {
      critical: { dot: 2564360, reason: "TIMEKEEPER TRUCKING INC: recent involuntary revocation (used in snapshot baseline)." },
      none: { dot: 53467, reason: "Werner: no revocations." },
    },
  },
  {
    id: "recent-enforcement",
    category: "authority",
    label: "Recent enforcement",
    definition:
      "FMCSA closed at least one civil-penalty enforcement case against this carrier within the last 24 months. Enforcement cases follow compliance reviews and indicate FMCSA found violations serious enough to fine — a documented, adjudicated compliance failure. We bump the verdict one tier on any recent case; the settlement dollar amount is shown for context but does not change the tier (amounts are small and don't track severity).",
    thresholds: {
      caution: "≥1 closed enforcement case in the last 24 months (settlement $ is context only).",
    },
    fixtures: {
      caution: { dot: 305573, reason: "R & R TRANSPORTATION INC: 1 closed case, most recent 2026-04-13." },
      none: { dot: 53467, reason: "Werner: no enforcement cases." },
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON
  // ---------------------------------------------------------------------
  {
    id: "chameleon-prior-revoke",
    category: "chameleon",
    label: "FMCSA prior-revoke flag (chameleon)",
    definition:
      "FMCSA's own PRIOR_REVOKE_FLAG marks this DOT as a re-incarnation of a previously-revoked predecessor DOT — FMCSA's own link, no inference required. NOTE: FMCSA blanked this field for ~97% of carriers in the 2026-08-13 census, taking the rule from ~1,000 carriers to 40 nationally, so it no longer carries a Critical verdict on its own; it needs corroboration from another chameleon signal.",
    thresholds: {
      high: "FMCSA PRIOR_REVOKE_FLAG = Y AND PRIOR_REVOKE_DOT_NUMBER is either unrecorded (0) or a DOT more than one edit away from this carrier's own. Capped at High since the 2026-08 blanking; reaches Critical only via the chameleon cluster.",
    },
    fixtures: {
      // Pinned to a carrier flagged in BOTH the 20260812 and 20260813 vintages,
      // so a refresh doesn't rot it. The previous fixture (DOT 12311) lost its
      // flag entirely in the 2026-08-13 blanking.
      high: { dot: 321804, reason: "FMH MATERIAL HANDLING SOLUTIONS: prior_revoke_flag=Y, predecessor unrecorded (0)." },
      none: [
        { dot: 53467, reason: "Werner: no prior-revoke flag." },
        // Guards the typo screen: FMCSA recorded 102143 as the predecessor of
        // 102413 — a digit transposition of the carrier's own DOT, not a
        // successor. 87 carriers in the 20260812 parquet were being called
        // Critical chameleons on exactly this kind of data-entry error.
        { dot: 102413, reason: "Predecessor 102143 is a transposition of this DOT — a typo, not a chameleon link." },
      ],
    },
  },
  // chameleon-cluster REMOVED: the "2+ independent signals → Critical" escalator
  // over-called on weak combos (e.g. 2 cancellations + 33% diffuse on an insured,
  // established carrier → false Critical). Carriers now flag on their strongest
  // INDIVIDUAL chameleon signal (shared-fleet / diffuse-equipment / address-
  // cluster, each PU/VIN-gated) plus the hard regulatory/fraud signals.

  // ---------------------------------------------------------------------
  // IDENTITY COHERENCE, email-only rules comparing what the email claims
  // against what FMCSA has on file.
  // ---------------------------------------------------------------------
  {
    id: "mc-number-mismatch",
    category: "identityCoherence",
    label: "MC# mismatch",
    definition:
      "The MC (Motor Carrier) number stated in the email doesn't match FMCSA's registered MC for the claimed DOT. MC and DOT numbers are tied to the same legal entity in FMCSA's records, a mismatch suggests either a fabricated identity or an impersonator using a stolen DOT alongside a different (often valid-looking) MC.",
    thresholds: {
      critical: "Email's MC number doesn't equal the FMCSA-registered MC for the claimed DOT.",
    },
  },
  {
    id: "sender-domain-mismatch",
    category: "identityCoherence",
    label: "Sender domain doesn't match FMCSA registration",
    definition:
      "The sender's email domain (or full address, when both are free-mail) doesn't match the email FMCSA has on file for this carrier. The cleanest impersonation pattern: an email from a brand-new look-alike domain or a free-mail address claiming to represent a carrier whose real domain is on file.",
    thresholds: {
      high: "Sender domain (or full address for free-mail) differs from FMCSA's registered email.",
    },
  },
  {
    id: "sender-free-email-no-fmcsa-comparison",
    category: "identityCoherence",
    label: "Sender at free email (no FMCSA email to compare)",
    definition:
      "Sender is on a free-mail provider (Gmail, Yahoo, Outlook, etc.) and FMCSA has no email on file for this carrier. We can't verify the sender against FMCSA, common in small-carrier and owner-op populations, so this is informational rather than a flag.",
    thresholds: {
      info: "Sender domain is free-mail AND FMCSA has no email for this DOT.",
    },
  },
  {
    id: "company-name-mismatch",
    category: "identityCoherence",
    label: "Company name doesn't match FMCSA",
    definition:
      "The carrier company name claimed in the email body doesn't match FMCSA's legal name for the claimed DOT. We allow minor variations (LLC vs Inc, common abbreviations, DBA variants), but a substantive name mismatch suggests the sender is using a stolen DOT alongside a fabricated company name.",
    thresholds: {
      high: "Claimed company name and FMCSA's legal name don't match after normalization.",
    },
  },
  {
    id: "phone-mismatch",
    category: "identityCoherence",
    label: "Phone in email doesn't match FMCSA",
    definition:
      "The phone number stated in the email doesn't match FMCSA's registered phone for this DOT. Carriers do change phone numbers, so a single mismatch isn't damning, but combined with other identity flags it strengthens the impersonation hypothesis.",
    thresholds: {
      caution: "Phone in the email doesn't match FMCSA's registered phone after normalization.",
    },
  },

  // ---------------------------------------------------------------------
  // LANE VIABILITY, does the carrier's authority + operating area cover
  // the lane they're offering to haul?
  // ---------------------------------------------------------------------
  {
    id: "lane-not-authorized-interstate",
    category: "laneViability",
    label: "Not authorized for interstate",
    definition:
      "The email proposes an interstate lane (origin and destination states differ), but FMCSA shows this carrier has no interstate operating authority. Hauling interstate freight without interstate authority is a federal violation; FMCSA can order the load off the road and fine both parties.",
    thresholds: {
      critical: "Email proposes interstate lane AND carrier's authority is intrastate-only.",
    },
  },
  {
    id: "lane-interstate-local-only",
    category: "laneViability",
    label: "Carrier registers as interstate-local only",
    definition:
      "Carrier's MCS-150 marks them as interstate within 100 miles only, no long-haul drivers, no over-the-road inspections. The proposed lane likely exceeds that 100-mile radius. Carrier could be expanding (and should update their MCS-150 first), but the mismatch is worth flagging.",
    thresholds: {
      caution: "Carrier operation = interstate within 100 miles AND proposed lane is plausibly long-haul.",
    },
  },

  // ---------------------------------------------------------------------
  // HAZMAT, applies only when the broker's email pitches a hazmat load
  // ---------------------------------------------------------------------
  {
    id: "hazmat-not-registered",
    category: "hazmat",
    label: "Carrier not registered for hazmat",
    definition:
      "Email pitches a hazmat (placardable) load, but FMCSA Census shows HM_Ind=N for this carrier, they have not indicated they handle hazardous materials on their MCS-150. Tendering placarded hazmat to a non-hazmat carrier is a regulatory and liability problem regardless of how willing the driver is.",
    thresholds: {
      critical: "Email pitches hazmat AND carrier's MCS-150 HM_Ind = N.",
    },
  },
  {
    id: "hazmat-no-recent-activity",
    category: "hazmat",
    label: "Hazmat-registered carrier with no recent hazmat activity",
    definition:
      "Carrier's MCS-150 indicates hazmat capability (HM_Ind=Y), but FMCSA has no hazmat inspections on record in the last 24 months. The hazmat self-report may be stale, verify the carrier's current hazmat permit and driver endorsements before tendering.",
    thresholds: {
      caution: "HM_Ind = Y but 0 hazmat inspections in last 24 months.",
    },
  },
  {
    id: "hazmat-registered-active",
    category: "hazmat",
    label: "Hazmat-registered, with recent hazmat activity",
    definition:
      "Carrier handles hazmat per MCS-150 (HM_Ind=Y) and has recent hazmat inspections on record. This is a positive verification, they actively haul placardable loads. The broker should still confirm specific endorsements (HM placard, tanker, etc.) match the load class.",
    thresholds: {
      info: "HM_Ind = Y AND ≥1 hazmat inspections in last 24 months.",
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON, phone-based (email-only, not in audit)
  // ---------------------------------------------------------------------
  {
    id: "phone-corp-switchboard",
    category: "chameleon",
    label: "Phone shared with multiple DOTs (corporate switchboard)",
    definition:
      "Sender's phone matches three or more other DOTs in FMCSA. Large fleets and dispatch services commonly share one line across many authorities, and at this scale the pattern skews toward legitimate dispatchers (a lift test found very large clusters less elevated than 1-2 DOT matches), weaker than a 1-2 DOT match. Surfaced as context so brokers know the phone belongs to a shared dispatch line, not uniquely to the carrier they're tendering to.",
    thresholds: {
      info: "Phone matches ≥3 other DOTs (corporate switchboard pattern).",
    },
  },
  {
    id: "phone-chameleon-revoked-predecessor",
    category: "chameleon",
    label: "New DOT shares phone with revoked predecessor",
    definition:
      "Sender's phone matches a DOT whose authority was involuntarily revoked, AND the focal carrier (this DOT) was registered AFTER the predecessor's revocation date, AND the focal DOT is itself less than three years old. Textbook chameleon: same operator, new authority, dodging the predecessor's safety record. The phone match makes the link evidentiary.",
    thresholds: {
      critical: "Phone match to revoked DOT AND focal DOT post-dates revocation AND focal DOT < 3 years old.",
    },
  },
  {
    id: "phone-shared-with-revoked-carrier",
    category: "chameleon",
    label: "Phone shared with carrier that had revocation history",
    definition:
      "Phone matches a DOT with revocation history, but the timing doesn't fit a re-incarnation pattern (focal carrier is older than the revocation, or the revocation is more recent than focal registration). Likely a sibling / family entity. Worth flagging at caution so the broker can verify independently.",
    thresholds: {
      caution: "Phone match to revoked DOT BUT timing doesn't support chameleon pattern.",
    },
  },
  {
    id: "phone-shared-one-other-dot",
    category: "chameleon",
    label: "Phone shared with another active carrier",
    definition:
      "Sender's phone matches one or two other active DOTs in FMCSA with no revocation history. Often a legitimate multi-authority owner-operator, but a lift test (2026-05) against internal do-not-use outcomes found carriers sharing a phone are flagged ~1.3x more often than carriers on a unique line, and the 1-2 sibling case is the most elevated bucket. So it is a weak fraud corroborator, not benign. Surfaced at caution: confirm it is the same legitimate operator before tendering.",
    thresholds: {
      caution: "Phone matches 1-2 other active DOTs with no revocation history.",
    },
  },

  // ---------------------------------------------------------------------
  // EMAIL AUTHENTICITY, DNS / WHOIS / behavioral signals about the sender
  // ---------------------------------------------------------------------
  {
    id: "reply-to-differs-from-sender",
    category: "emailAuthenticity",
    label: "Reply-To domain differs from sender",
    definition:
      "Email's Reply-To header points to a different domain than the From: address. Classic phishing pattern: the From: looks plausible (carrier's real domain or a near-domain) but the Reply-To routes to an attacker-controlled inbox so the broker's reply goes to the wrong party.",
    thresholds: {
      high: "From: and Reply-To: header domains differ.",
    },
  },
  {
    id: "urgency-language",
    category: "emailAuthenticity",
    label: "Email uses urgency language",
    definition:
      "The email body contains time-pressure or urgency markers (\"today\", \"ASAP\", \"need answer in 10\", etc.). Urgency by itself is normal in freight; flagging it as info reminds the broker not to skip identity verification because of the time pressure.",
    thresholds: {
      info: "Email contains urgency markers.",
    },
  },
  {
    id: "vague-cold-pitch",
    category: "emailAuthenticity",
    label: "Vague cold pitch without signature",
    definition:
      "Email is an unsolicited cold inquiry with no signature block and low specificity (no MC#, no specific lanes, no equipment detail). Common cold-list pattern from carrier brokers or scrapers, not necessarily fraudulent but worth flagging as low-specificity outreach.",
    thresholds: {
      info: "No load-posting response AND no signature block AND specificity score is low.",
    },
  },
  {
    id: "sender-email-matches-fmcsa",
    category: "emailAuthenticity",
    label: "Sender email matches FMCSA registration",
    definition:
      "Full sender address matches the email FMCSA has on file for this DOT. Strong identity signal on a free-mail domain (where the domain itself proves nothing) because the local-part is what identifies the sender on shared providers.",
    thresholds: {
      info: "Sender full email matches FMCSA's registered email exactly.",
    },
  },
  {
    id: "sender-domain-matches-fmcsa",
    category: "emailAuthenticity",
    label: "Sender domain matches FMCSA registration",
    definition:
      "Sender's email domain matches the email domain FMCSA has on file for this DOT (business-domain case). Confirms the sender is at the same domain the carrier uses with the regulator.",
    thresholds: {
      info: "Sender domain matches FMCSA's registered email domain (business domain only).",
    },
  },
  {
    id: "sender-domain-no-mx",
    category: "emailAuthenticity",
    label: "Sender domain has no MX records",
    definition:
      "Sender's domain has no MX (mail exchanger) records in DNS, replies will bounce. Typical of parked domains, throwaway typo-squats, or newly-registered domains that haven't been provisioned for email. Legitimate carriers operate from domains that accept inbound mail.",
    thresholds: {
      high: "Sender domain has no MX records in DNS.",
    },
  },
  {
    id: "sender-domain-no-email-auth",
    category: "emailAuthenticity",
    label: "Sender domain lacks email authentication setup",
    definition:
      "Sender's domain accepts mail (MX on file) but publishes neither SPF nor DMARC. Real businesses configure at least one, without them anyone can spoof mail from this domain. Unusual for a legitimate carrier; worth confirming the carrier's identity through another channel.",
    thresholds: {
      caution: "Sender domain has MX but neither SPF nor DMARC.",
    },
  },
  {
    id: "sender-domain-auth-configured",
    category: "emailAuthenticity",
    label: "Sender domain configured for authenticated email",
    definition:
      "Sender's domain publishes SPF and/or DMARC and accepts inbound mail, set up like a real business. This is a domain-level check, not a per-message check (inline-forwarded emails strip the per-message auth headers, so we can't claim the specific message passed authentication, only that the domain is properly configured).",
    thresholds: {
      info: "Sender domain has MX AND publishes SPF and/or DMARC.",
    },
  },
  {
    id: "sender-domain-newly-registered",
    category: "emailAuthenticity",
    label: "Sender domain newly registered",
    definition:
      "Sender's domain was registered less than 90 days ago. Brand-new domains are uncommon for legitimate carriers, they're operating businesses with established web presence. New domains paired with carrier outreach is a recurring fraud pattern (impersonators register a domain that looks like a real carrier's days before the scam).",
    thresholds: {
      high: "WHOIS registration date less than 90 days ago.",
    },
  },
  {
    id: "sender-domain-less-than-year-old",
    category: "emailAuthenticity",
    label: "Sender domain less than a year old",
    definition:
      "Sender's domain was registered between 90 days and 1 year ago. Not as suspicious as a brand-new domain but worth verifying, most established carriers operate on multi-year-old domains.",
    thresholds: {
      caution: "WHOIS registration date between 90 and 365 days ago.",
    },
  },
  {
    id: "sender-domain-aged",
    category: "emailAuthenticity",
    label: "Sender domain age established",
    definition:
      "Sender's domain has been registered for at least a year, often many years. Positive identity signal, establishes the sender's domain isn't a recently-spun-up impersonation site.",
    thresholds: {
      info: "WHOIS registration date ≥365 days ago.",
    },
  },

  // ---------------------------------------------------------------------
  // EDGE CASES, fired by composeVerdict when carrier can't be resolved
  // ---------------------------------------------------------------------
  {
    id: "no-dot-or-mc-in-email",
    category: "identityCoherence",
    label: "No DOT or MC number in email",
    definition:
      "The forwarded email doesn't include either a DOT or MC number, so we can't cross-check the sender against FMCSA's carrier registry. Without an identifier, the safety check is unrunnable and we can't credit the sender as a real carrier. Reply asking for the USDOT or MC before tendering anything.",
    thresholds: {
      caution: "Email contains neither a DOT number nor an MC number.",
    },
  },
  {
    id: "dot-not-found-in-fmcsa",
    category: "identityCoherence",
    label: "DOT not found in FMCSA",
    definition:
      "The DOT number claimed in the email doesn't exist in FMCSA's active-carrier universe. Possibilities: the number was fabricated (most concerning), the DOT was fully deregistered, or the carrier has been dormant long enough to fall out of the active dataset. Verify the claimed DOT on FMCSA SAFER before any further engagement.",
    thresholds: {
      critical: "Claimed DOT number isn't in our FMCSA parquet snapshot.",
    },
  },

  // ---------------------------------------------------------------------
  // SMS BASIC + CRASH, statistical-axis rules
  //
  // These six rules all share the same shape: an observed rate (violation /
  // OOS / crash count divided by exposure) is compared against the carrier's
  // peer-group P85 / P90 / P95 cutoff. Cutoffs are recomputed per-snapshot
  // and stored in data/national_thresholds.json. Tier mapping:
  //   ≥P95 → Severe, ≥P90 → High, ≥P85 → Elevated, <P85 → Clean.
  //
  // The "definition" text below intentionally leaves out specific cutoff
  // numbers because they change with each FMCSA snapshot, see the
  // tooltip on the website Scorecard for the live peer-group cutoff at
  // the time of the audit.
  // ---------------------------------------------------------------------
  {
    id: "crash-rate",
    category: "crash",
    label: "Crashes",
    definition:
      "Crashes per million miles, peer-group adjusted. Universal trucking-safety metric: Werner is around 0.42, J.B. Hunt around 0.50, fleet average around 1.0, problem carriers 2.0 or higher. Mileage denominator comes from MCS-150, which is much harder to fabricate than power-unit count.",
    thresholds: {
      critical: "Crashes per million miles at or above P95 cutoff for peer group, with absolute floor.",
      high:     "Crashes per million miles between P90 and P95 for peer group.",
      caution:  "Crashes per million miles between P85 and P90 for peer group.",
    },
    fixtures: {
      // Any crash-rate fixture is a function of (crashes_24mo, annual_mileage)
      //, both change quickly. Picked a small-fleet carrier with persistent
      // high crash count to maximize stability.
      critical: { dot: 1162977, reason: "UNIVERSAL INTERMODAL SERVICES: ~18 crashes per million miles on 1.25M mileage, 45 crashes / 124 PU." },
      none: { dot: 53467, reason: "Werner: industry-leading low crash rate." },
    },
  },
  {
    id: "unsafe-driving-rate",
    category: "smsBasic",
    label: "Unsafe Driving",
    definition:
      "FMCSA SMS BASIC: driver inspections with Unsafe Driving violations divided by total driver inspections (24 months). Captures speeding, reckless driving, improper lane change, following too close, and similar moving violations. High rates indicate driver supervision and training gaps.",
    thresholds: {
      critical: "Unsafe Driving violation rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
    },
    fixtures: {
      // GIDDENS TRUCKING (1135439) held this slot until Aug 2026, when three of
      // its 13 inspections rolled out of the 24-month window; still 100% but no
      // longer a large enough sample to clear the peer P95 gate.
      critical: { dot: 3878486, reason: "GARY Z HORST: 11 unsafe-driving violations on 11 driver inspections (100%), 6 power units." },
      none: { dot: 53467, reason: "Werner: clean Unsafe Driving record." },
    },
  },
  {
    id: "hos-compliance-rate",
    category: "smsBasic",
    label: "HOS Compliance",
    definition:
      "FMCSA SMS BASIC: driver inspections with Hours-of-Service violations divided by total driver inspections. Captures log falsification, driving beyond limits, missed rest periods. A driver fatigued by HOS violations is statistically more likely to crash.",
    thresholds: {
      critical: "HOS violation rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
    },
    fixtures: {
      critical: { dot: 4409190, reason: "LCR FORD TRUCKING LLC: 100% HOS violation rate on 12 inspections." },
      none: { dot: 53467, reason: "Werner: clean HOS record." },
    },
  },
  {
    id: "driver-oos-rate",
    category: "smsBasic",
    label: "Driver OOS",
    definition:
      "Driver out-of-service rate: roadside inspections where the driver was placed OOS (could not continue driving) divided by total driver inspections. Driver OOS is the consequence-side metric, it's what happens when violations are severe enough to halt the trip immediately.",
    thresholds: {
      critical: "Driver OOS rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
    },
    fixtures: {
      critical: { dot: 4222671, reason: "AYK TRUCKING LLC: 100% driver OOS rate on 12 inspections." },
      none: { dot: 53467, reason: "Werner: clean Driver OOS rate." },
    },
  },
  {
    id: "vehicle-oos-rate",
    category: "smsBasic",
    label: "Vehicle OOS",
    definition:
      "Vehicle out-of-service rate: roadside inspections where the truck was placed OOS (mechanical defects, lighting, brakes, tires) divided by total vehicle inspections. High Vehicle OOS rate is the leading indicator of in-transit breakdowns and roadside delays.",
    thresholds: {
      critical: "Vehicle OOS rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
    },
    fixtures: {
      critical: { dot: 4307204, reason: "NKB TRUCKING LLC: 100% vehicle OOS rate on 13 inspections." },
      none: { dot: 53467, reason: "Werner: clean Vehicle OOS rate." },
    },
  },
  {
    id: "hazmat-oos-rate",
    category: "smsBasic",
    label: "Hazmat OOS",
    definition:
      "Hazmat out-of-service rate: hazmat-load inspections that resulted in an OOS order divided by total hazmat inspections (24 months). Hazmat OOS is materially more serious than general Vehicle OOS, the regulatory threshold is lower and the consequences (placard violations, leak risk) are higher. Only fires for carriers with hazmat activity.",
    thresholds: {
      critical: "Hazmat OOS rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
    },
    fixtures: {
      critical: { dot: 4418657, reason: "JOSE SANTOS CUELLAR HERRERA: 100% hazmat OOS rate on 9 inspections." },
      none: { dot: 53467, reason: "Werner: clean hazmat record (when hazmat inspections present)." },
    },
  },
  {
    id: "fast-act-high-risk",
    category: "smsBasic",
    label: "FAST Act High-Risk, triggered",
    definition:
      "Two or more of the four crash-correlated BASICs, Unsafe Driving, Crash Indicator, Hours-of-Service, Vehicle Maintenance, are at or above the 90th percentile. This is the threshold FMCSA uses under the FAST Act (§5305) to prioritize a carrier for an onsite safety investigation. Computed from the current monthly SMS snapshot's percentiles; FMCSA's non-passenger rule additionally requires the condition to persist two consecutive months and excludes carriers investigated in the last 18 months, so this flags carriers that meet the percentile bar (a superset). Crash Indicator percentile is only available for carriers with sufficient crash data, so CI-driven high-risk is undercounted.",
    thresholds: {
      high: "≥2 of {Unsafe Driving, Crash Indicator, HOS, Vehicle Maintenance} at ≥90th percentile.",
    },
    fixtures: {
      high: { dot: 4238066, reason: "C&M CARRIERS LLC: Unsafe Driving, HOS, and Vehicle Maintenance all ≥98th percentile." },
      none: { dot: 53467, reason: "Werner: fewer than 2 of the four crash-correlated BASICs at ≥90th percentile." },
    },
  },
  {
    id: "serious-violations",
    category: "smsBasic",
    label: "Acute/critical violations from FMCSA investigation",
    definition:
      "FMCSA conducted an on-site or off-site investigation in the last 12 months and cited one or more acute or critical (Serious) violations. Acute violations require immediate corrective action (e.g., no controlled-substances testing program); critical violations indicate a breakdown in management controls (e.g., a pattern of false records of duty status). Under FMCSA's own ISS algorithm a Serious Violation forces the associated BASIC to the 100th percentile. This is direct evidence FMCSA found the carrier non-compliant during an audit, far stronger than roadside percentiles. Sourced from the per-carrier SMS investigation results.",
    thresholds: {
      critical: "≥1 acute/critical violation in 2+ BASICs, or any controlled-substances/HOS acute violation.",
      high: "≥1 acute/critical violation from an investigation in the last 12 months.",
    },
    fixtures: {
      high: { dot: 4004854, reason: "BLACK HILLS TRENCHING & BORING: 4 acute/critical violations (Controlled Substances + Driver Fitness + Vehicle Maintenance)." },
      none: { dot: 53467, reason: "Werner: no acute/critical violations from investigation." },
    },
  },
  {
    id: "insurance-authority-suspension",
    category: "insurance",
    label: "FMCSA suspended authority for lack of insurance",
    definition:
      "FMCSA has involuntarily suspended this carrier's operating authority because it has no active insurance meeting the minimum required coverage, or has served notice that it will on a stated date. This is FMCSA's own enforcement action, not our inference from a cancellation date. A carrier whose authority is suspended is not legally able to haul, and any BIPD amount shown alongside it predates the suspension. Carriers with a later reinstatement are excluded upstream.",
    thresholds: {
      critical: "Suspension already in effect, or effective within ~10 days.",
      high: "Suspension effective 11-30 days out.",
    },
    fixtures: {
      critical: { dot: 3008423, reason: "JESTEVA TRANSPORT INC: authority suspended 2026-08-07 for no insurance meeting minimum, no reinstatement filed." },
      none: { dot: 53467, reason: "Werner: no suspension." },
    },
  },
  {
    id: "insurance-imminent-lapse",
    category: "insurance",
    label: "BIPD insurance about to lapse, no replacement on file",
    definition:
      "The carrier's most recent BIPD (liability) insurance filing is a cancellation, with no replacement policy on file and no other active BIPD coverage, so the carrier is days from losing the financial responsibility required to operate, or has already lost it. A carrier that loses insurance loses its authority and is a major tender risk. NOTE: computed against the insurance-data snapshot, so it must be run on fresh insurance data to be operationally accurate.",
    thresholds: {
      critical: "Cancellation already in effect (lapsed) or within ~10 days, no replacement.",
      high: "Cancellation effective within ~45 days, no replacement on file.",
    },
    fixtures: {
      high: { dot: 784547, reason: "DEOL BROS EXPRESS INC: last BIPD policy cancels 2026-09-10 (~29 days out), $1.5M on file, no replacement, and no FMCSA suspension — so the lapse rule itself fires rather than being superseded by the suspension signal." },
      none: { dot: 53467, reason: "Werner: active BIPD insurance, no pending lapse." },
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON, fleet sharing (cross-DOT VIN overlap)
  // ---------------------------------------------------------------------
  {
    id: "chameleon-shared-fleet",
    category: "chameleon",
    label: "Fleet shared with another active DOT",
    definition:
      "A meaningful share of the trucks inspected under this carrier (identified by VIN) are also inspected under another currently-active DOT. Two active DOTs running the same physical fleet is the strongest single signal of a multi-shell operator: the same operator is running 'one' business under two paper authorities, which spreads safety violations across two ledgers and dilutes the audit picture brokers see on either DOT alone. Excludes legitimate one-way truck sales (where the seller's DOT goes inactive) because both sides of the overlap must currently be active.",
    thresholds: {
      critical: "≥50% VIN overlap with another active DOT at the SAME physical address (DK MAX TRUCKING / DK MAX PRIME pattern: same building, near-identical name, shared fleet).",
      high:     "≥80% VIN overlap with another active DOT regardless of address (sister-DOT structure, name variants, related entities sharing trucks).",
      caution:  "≥50% VIN overlap with another active DOT, no address or name correlation (probable fleet acquisition or undisclosed corporate relationship, worth verifying).",
    },
    fixtures: {
      critical: {
        dot: 3621624,
        reason: "DK MAX TRUCKING INC: 76% of its 140 inspected VINs (107) overlap with DK MAX PRIME INC (4006982), same building at 2300 Montana Ave Cincinnati OH.",
        expectMatch: /of this carrier's VINs.*also run under/i,
      },
      none: {
        dot: 53467,
        reason: "Werner: no significant cross-DOT VIN sharing.",
      },
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON, diffuse equipment sharing
  // ---------------------------------------------------------------------
  {
    id: "chameleon-diffuse-equipment",
    category: "chameleon",
    label: "Equipment spread across multiple active DOTs",
    definition:
      "A meaningful share of this carrier's inspected trucks have also been inspected under multiple OTHER active DOTs, equipment is laundered across a ring of sister authorities rather than shared with a single twin. Distinct from chameleon-shared-fleet, which catches concentrated two-DOT pairs (DK MAX / DK MAX PRIME). Distinct from leasing pools (a carrier running Ryder rentals will share VINs with 100+ other lessees but no single sibling holds more than a handful of trucks) by requiring that the largest single sibling share at least 10% of the fleet, proving the sharing is concentrated enough to be a real ring rather than rental turnover. The concentration floor is relaxed to 5% when another chameleon-specific signal (prior revoke, recent involuntary revocation, rapid replace, lapsed BIPD, address cluster, or all-cancel insurance pattern) has already fired, since a carrier corroborated by other chameleon evidence is not a legitimate leasing operation.",
    thresholds: {
      critical: "≥50% of own VINs run under any other active DOT, spread across ≥5 distinct siblings, AND top sibling shares ≥10% of fleet (≥5% when corroborated by another chameleon signal).",
      high:     "≥30% of own VINs run under any other active DOT, spread across ≥3 distinct siblings, AND top sibling shares ≥10% of fleet (≥5% when corroborated by another chameleon signal).",
      caution:  "≥25% of own VINs run under any other active DOT, spread across ≥2 distinct siblings, AND top sibling shares ≥10% of fleet (≥5% when corroborated by another chameleon signal).",
    },
    fixtures: {
      critical: { dot: 3621624, reason: "DK MAX TRUCKING INC: 86% of its 140 inspected VINs run under 24 other active DOTs (rich sample, 60 PU)." },
      high:     { dot: 4198159, reason: "ALAKE LOGISTICS INC: 43% of 7 VINs run under 3 other active DOTs, top sibling 14% concentration." },
      // Replaced Aug 2026: the previous fixture (3432788 PUNIA TRANS) drifted to
      // 18% diffuse / 2 siblings and stopped clearing the bar. Picking a
      // replacement from parquet predicates alone had failed before because two
      // of the analyzer's conditions are not the obvious columns: the VIN floor
      // reads largestSiblingTotalVins (NOT pu_vins_inspected), and the
      // corroboration test wants addressDupeOosCount >= 3 (NOT the active count).
      // Candidates were verified by running analyze() rather than inferred.
      //
      // NOBLE TRANS is deliberately one whose largest sibling is a REAL carrier.
      // Of the relaxed-floor-only firings, ~7% have a rental company (Penske,
      // Ryder) as their top sibling — a fixture anchored on one of those would
      // enshrine the exact leasing-pool false positive the concentration floor
      // exists to suppress.
      caution:  { dot: 1106798, reason: "GREEN HORIZONS INC (relaxed-floor): 27% diffuse across 4 siblings, top sibling CARROLL FULMER LOGISTICS at 9.1% — below the 10% default floor, so it fires only via the relaxed branch. Replaced NOBLE TRANS (2516921), which drifted 25.9% -> 22.2% within a single refresh. If the relaxed-floor branch is ever removed, this fixture stops firing, which is the point of it.", expectMatch: /run under \d+ other active DOTs/ },
      none: [
        { dot: 53467, reason: "Werner: trucks unique to the operating fleet." },
        {
          dot: 3863705,
          reason: "NOOR EXPRESS LOGISTICS INC (leasing-pool guard): 54% diffuse share across 109 siblings (Ryder, UPS, New Prime) but top sibling shares only 4% AND no chameleon-specific corroborating signals, rule must not fire on rental-fleet turnover even with churn.",
        },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON, shut-down equipment predecessor
  // ---------------------------------------------------------------------
  {
    id: "chameleon-shutdown-predecessor",
    category: "chameleon",
    label: "Running trucks from carriers FMCSA shut down",
    definition:
      "This carrier's trucks were previously inspected under one or more OTHER carriers that FMCSA has since revoked and which remain unauthorized. That is the chameleon succession pattern in its plainest form: the old authority is killed, the equipment moves to a new one, operations continue. Distinct from chameleon-diffuse-equipment, which counts how WIDELY equipment is shared without regard to what happened to those partners — it treats a shut-down predecessor exactly like any active leasing pool, discarding the strongest evidence in the link. Also distinct from FMCSA's own prior-revoke flag, which only captures predecessors FMCSA itself linked; this finds them through the equipment.",
    thresholds: {
      critical: "≥5 such partners AND at least as many partners as trucks (ratio ≥1.0).",
      high:     "≥2 such partners AND ratio ≥0.25.",
      caution:  "≥1 such partner AND ratio ≥0.05. Below that dilution it is used-truck turnover, not succession, so the rule stays silent.",
    },
    // Measured on the Aug 2026 vintage with a temporal split — partner revoked
    // BEFORE 2026-02-12, this carrier's own revocation AFTER — so a ring
    // collapsing in one enforcement sweep cannot inflate it. Base rate of a
    // later revocation is 1.15%:
    //     1 partner    11,428 carriers   11.2%    9.8x
    //     2             2,075            16.1%   14.1x
    //     >=3           1,952            25.6%   22.4x
    //     >=5             781            31.0%   27.1x
    // For comparison: shared insurance policy ~6x, geo-mismatch ~1.9x.
    //
    // Severity keys on the RATIO to fleet size, not the raw count: "1 partner"
    // is 10.1x lift at 1-5 power units but 1.5x at 100+, i.e. noise. Without
    // that, NEW PRIME (77 partners across 7,919 trucks) and UPS (73 / 112,321)
    // score Critical alongside GOLLA GROUP (82 partners, 2 trucks). Ratio bands:
    // >=1.0 -> 22.8x, 0.25-1.0 -> ~10-11x, below -> ~6-10x.
    //
    // "Shut down" means revoked AND still unauthorized. Defining it as merely
    // "has a revocation on record" pulls in SWIFT, UPS, LANDSTAR, CRETE and
    // PENSKE — decades-old docket actions since reinstated — which link to
    // ~3,000 carriers between them and would swamp the signal with false
    // positives.
    fixtures: {
      critical: { dot: 4514820, reason: "GOLLA GROUP LLC: 82 shut-down VIN partners against 2 reported trucks (ratio 41). Most recent: AUTOHAULX LLC." },
      high:     { dot: 2370225, reason: "TRAINA SERVICES LLC: 4 shut-down partners, 1 truck (ratio 4.0). Most recent: ATLAS ONE EXPRESS LLC." },
      caution:  { dot: 271644,  reason: "RONALD L WILCOX: a single shut-down partner (DSC TRUCKING INC) on a 1-truck fleet — ratio 1.0, the honest-used-truck case that still warrants a look." },
      none: [
        { dot: 53467, reason: "Werner: 7 shut-down partners across 9,851 trucks (ratio 0.0007) — below the 0.05 floor, so it must NOT fire. This fixture is the guard against the size-confounding that would otherwise flag every large fleet." },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON, address cluster
  // ---------------------------------------------------------------------
  {
    id: "chameleon-address-cluster",
    category: "chameleon",
    label: "Address shared with out-of-service DOTs",
    definition:
      "Counts how many out-of-service DOTs share this carrier's normalized physical address. A high OOS-sibling count is the classic chameleon-farm pattern: a new active carrier registers at the same suite where a series of previous DOTs were deactivated, revoked, or abandoned. PO boxes, blank addresses, and clusters of 100 or more DOTs (registered agents / virtual mailboxes) are excluded.",
    thresholds: {
      critical: "≥10 out-of-service DOTs share this carrier's address.",
      high:     "5 to 9 out-of-service DOTs share this carrier's address.",
      caution:  "3 or 4 out-of-service DOTs share this carrier's address.",
    },
    fixtures: {
      // Fixtures sampled from May 2026 parquet snapshot. Each DOT chosen
      // because its address_dupe_oos_count puts it solidly inside the tier's
      // band, not on the edge, leaves headroom for FMCSA data churn before
      // the fixture drifts out of band.
      critical: {
        dot: 2763893,
        reason: "Active owner-op with 66 OOS DOTs at the same address (May 2026 snapshot).",
        expectMatch: /out-of-service DOTs? share/i,
      },
      high: {
        dot: 4393031,
        reason: "Active LLC with 5 OOS DOTs at the same address (May 2026 snapshot).",
        expectMatch: /out-of-service DOTs? share/i,
      },
      caution: {
        // Picked specifically for a "pure caution" profile: 4 OOS siblings
        // triggers chameleon-address-cluster at caution, but the carrier is
        // otherwise clean (active interstate authority, $750k BIPD on file,
        // no revocations, no OOS rate issues), so the overall riskLevel
        // settles at Elevated. Avoids the conflation that happens when a
        // chameleon-caution DOT also has Insurance lapsed, where the
        // carrier's overall tier gets dominated by the harder finding.
        dot: 951745,
        reason: "LAWRENCE S BRAWLEY: 4 OOS DOTs at same address, otherwise clean (May 2026 snapshot).",
        expectMatch: /out-of-service DOTs? share/i,
      },
      none: {
        dot: 2619058,
        reason: "TODAYS CATCH SEAFOOD INC: 0 OOS + 0 active siblings (May 2026 snapshot).",
      },
    },
  },
];

/** O(1) lookup by id. Frozen so consumers can't mutate the registry at
 *  runtime (which would defeat the "single source of truth" guarantee). */
export const RULES_BY_ID: ReadonlyMap<RuleId, Rule> = new Map(
  RULES.map((r) => [r.id, r]),
);

/** Look up a rule by id. Throws on unknown ids, callers should pass
 *  literal ids from the registry, so an unknown id is a programmer
 *  error, not a runtime fallback case. */
export function getRule(id: RuleId): Rule {
  const r = RULES_BY_ID.get(id);
  if (!r) throw new Error(`unknown rule id: ${id}`);
  return r;
}

export type { Rule, RuleId, RuleCategory, RuleTier, RuleFixture, RuleFixtures } from "./types";
