/**
 * Rule registry — the single source of truth for every flag we surface to
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
  },
  {
    id: "cargo-insurance-not-on-file",
    category: "insurance",
    label: "Cargo insurance not on file",
    definition:
      "FMCSA flags cargo insurance as required for this carrier, but no active cargo policy is on file. Cargo insurance pays the broker when freight is damaged in transit. Some large carriers legitimately self-insure cargo, so this is not a hard refusal — verify a current cargo COI directly before tendering.",
    thresholds: {
      high: "FMCSA cargo required, no policy on file.",
    },
  },
  {
    id: "insurance-rapid-replace",
    category: "insurance",
    label: "Rapid replace + cancellation history",
    definition:
      "Insurance policy was cancelled and replaced within roughly 30 days, paired with three or more prior cancellations in the last 24 months. Quick policy swap by itself is a routine renewal pattern, but combined with repeated prior cancellations it's a re-incarnation move: a carrier with a damaged insurance history cycles policies to maintain on-file appearance.",
    thresholds: {
      critical: "Rapid-replace flag AND ≥3 true cancellations in 24 months.",
    },
  },
  {
    id: "insurance-severe-churn",
    category: "insurance",
    label: "Severe insurance churn",
    definition:
      "Five or more true insurance cancellations in the last 24 months — the top 1% of carriers nationally. Repeated insurer dropouts indicate the carrier is on the edge of becoming uninsurable; the next cancellation may not be replaced, leaving the broker exposed.",
    thresholds: {
      critical: "≥5 true insurance cancellations in 24 months.",
    },
  },
  {
    id: "insurance-churn",
    category: "insurance",
    label: "Insurance churn",
    definition:
      "Three to four true insurance cancellations in the last 24 months — top 5% nationally. Frequent insurer changes suggest the carrier is being shopped between insurers, often due to claim history or premium nonpayment. Worth confirming the current policy is stable before tendering.",
    thresholds: {
      caution: "3 or 4 true insurance cancellations in 24 months.",
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
  },
  {
    id: "recent-enforcement",
    category: "authority",
    label: "Recent enforcement",
    definition:
      "FMCSA closed at least one civil-penalty enforcement case against this carrier in recent history. Enforcement cases follow compliance reviews and indicate FMCSA found violations serious enough to fine. Large settlements ($75k+) often correlate with safety patterns the carrier has not corrected.",
    thresholds: {
      high: "≥1 closed enforcement case (large = settlement ≥ $75,000).",
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
      "FMCSA's own PRIOR_REVOKE_FLAG marks this DOT as a re-incarnation of a previously-revoked predecessor DOT. This is the strongest single chameleon signal available — no inference required, FMCSA explicitly linked the active DOT to its revoked predecessor. The new authority exists specifically to escape the predecessor's enforcement history.",
    thresholds: {
      critical: "FMCSA PRIOR_REVOKE_FLAG = Y AND PRIOR_REVOKE_DOT_NUMBER points to a different DOT.",
    },
  },
  {
    id: "chameleon-cluster",
    category: "chameleon",
    label: "Chameleon-pattern cluster",
    definition:
      "Two or more independent chameleon signals fire on the same carrier — combinations like prior-revoke flag + insurance rapid-replace + new authority + low activity. Any single signal is already flagged by its own rule; this is the combined-signal escalator that pushes the carrier to Severe minimum because multiple unrelated indicators agree.",
    thresholds: {
      high: "≥2 of {prior-revoke flag, rapid replace, ≥2 cancellations, new authority + low activity, ≥3 OOS DOTs at same address} fire together.",
    },
  },

  // ---------------------------------------------------------------------
  // IDENTITY COHERENCE — email-only rules comparing what the email claims
  // against what FMCSA has on file.
  // ---------------------------------------------------------------------
  {
    id: "mc-number-mismatch",
    category: "identityCoherence",
    label: "MC# mismatch",
    definition:
      "The MC (Motor Carrier) number stated in the email doesn't match FMCSA's registered MC for the claimed DOT. MC and DOT numbers are tied to the same legal entity in FMCSA's records — a mismatch suggests either a fabricated identity or an impersonator using a stolen DOT alongside a different (often valid-looking) MC.",
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
      "Sender is on a free-mail provider (Gmail, Yahoo, Outlook, etc.) and FMCSA has no email on file for this carrier. We can't verify the sender against FMCSA — common in small-carrier and owner-op populations, so this is informational rather than a flag.",
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
      "The phone number stated in the email doesn't match FMCSA's registered phone for this DOT. Carriers do change phone numbers, so a single mismatch isn't damning — but combined with other identity flags it strengthens the impersonation hypothesis.",
    thresholds: {
      caution: "Phone in the email doesn't match FMCSA's registered phone after normalization.",
    },
  },

  // ---------------------------------------------------------------------
  // SMS BASIC + CRASH — statistical-axis rules
  //
  // These six rules all share the same shape: an observed rate (violation /
  // OOS / crash count divided by exposure) is compared against the carrier's
  // peer-group P85 / P90 / P95 cutoff. Cutoffs are recomputed per-snapshot
  // and stored in data/national_thresholds.json. Tier mapping:
  //   ≥P95 → Severe, ≥P90 → High, ≥P85 → Elevated, <P85 → Clean.
  //
  // The "definition" text below intentionally leaves out specific cutoff
  // numbers because they change with each FMCSA snapshot — see the
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
  },
  {
    id: "driver-oos-rate",
    category: "smsBasic",
    label: "Driver OOS",
    definition:
      "Driver out-of-service rate: roadside inspections where the driver was placed OOS (could not continue driving) divided by total driver inspections. Driver OOS is the consequence-side metric — it's what happens when violations are severe enough to halt the trip immediately.",
    thresholds: {
      critical: "Driver OOS rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
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
  },
  {
    id: "hazmat-oos-rate",
    category: "smsBasic",
    label: "Hazmat OOS",
    definition:
      "Hazmat out-of-service rate: hazmat-load inspections that resulted in an OOS order divided by total hazmat inspections (24 months). Hazmat OOS is materially more serious than general Vehicle OOS — the regulatory threshold is lower and the consequences (placard violations, leak risk) are higher. Only fires for carriers with hazmat activity.",
    thresholds: {
      critical: "Hazmat OOS rate at or above P95 for peer group.",
      high:     "Between P90 and P95 for peer group.",
      caution:  "Between P85 and P90 for peer group.",
    },
  },

  // ---------------------------------------------------------------------
  // CHAMELEON — address cluster
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
      // band, not on the edge — leaves headroom for FMCSA data churn before
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
        dot: 4177120,
        reason: "Active LLC with 3 OOS DOTs at the same address (May 2026 snapshot).",
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

/** Look up a rule by id. Throws on unknown ids — callers should pass
 *  literal ids from the registry, so an unknown id is a programmer
 *  error, not a runtime fallback case. */
export function getRule(id: RuleId): Rule {
  const r = RULES_BY_ID.get(id);
  if (!r) throw new Error(`unknown rule id: ${id}`);
  return r;
}

export type { Rule, RuleId, RuleCategory, RuleTier, RuleFixture, RuleFixtures } from "./types";
