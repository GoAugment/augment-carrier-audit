/**
 * Rule registry schema.
 *
 * Every flag we surface in the email AND on the website maps to a single
 * Rule entry. The rule defines the user-facing label, the plain-language
 * definition (shown in tooltips / methodology), severity thresholds, data
 * sources, and test fixtures.
 *
 * Why a single registry instead of inline strings at each push site:
 *   1. Email + website always share the same label/definition. Changing
 *      the wording in one place updates both surfaces. No drift.
 *   2. Every rule has a stable ID. Telemetry, deep-links, and tests
 *      reference rules by ID so the analytics survives label changes.
 *   3. Every rule has a documented threshold and a regression fixture.
 *      Rule drift (a Polars refresh that breaks the rule) gets caught
 *      automatically by the test suite.
 *   4. A public methodology page can render the registry directly. The
 *      published docs can't lie about the implementation because they
 *      come from the implementation.
 */

export type RuleId = string; // kebab-case, e.g. "chameleon-address-cluster"

export type RuleSurface = "audit" | "email";

export type RuleCategory =
  | "insurance"
  | "authority"
  | "smsBasic"
  | "crash"
  | "identityCoherence"
  | "emailAuthenticity"
  | "laneViability"
  | "chameleon"
  | "hazmat";

export type RuleTier = "critical" | "high" | "caution" | "info";

/**
 * The bulk FMCSA dataset (or external lookup) that feeds a rule. Used to
 * gate the rule when a data source is unavailable in a given snapshot,
 * and surfaced on the methodology page so users see where each finding
 * originates.
 */
export type RuleSource =
  | "companyCensus"          // Company Census File (legal name, address, MCS-150, prior-revoke)
  | "smsPassProperty"        // SMS_AB_PassProperty (BASIC alerts + measures)
  | "smsInspection"          // SMS_Input_-_Inspection (24mo inspection rollups, hazmat)
  | "smsCrash"               // SMS_Input_-_Crash (weighted crash counts)
  | "smsViolation"           // SMS_Input_-_Violation (per-violation detail)
  | "carrierAuthority"       // Carrier_All_With_History (BIPD, authority types)
  | "actPendInsurance"       // ActPendInsur_All_With_History (current insurer + policy dates)
  | "inshist"                // InsHist (insurance cancel/replace history)
  | "revocation"             // Revocation file (involuntary + voluntary)
  | "extractedEmail"         // Stage 1 LLM extraction from the broker's forwarded email
  | "dnsLookup"              // Live MX/SPF/DMARC lookup at audit time
  | "whoisLookup";           // Live RDAP/WHOIS domain-age lookup at audit time

/**
 * A test fixture: a real DOT we know should trigger this rule at this tier.
 * `dot` must exist in the current parquet snapshot. `expectMatch` (optional)
 * is a regex applied to the rule's `detail` text — useful for confirming
 * the numbers in the detail match what we expect (e.g., "≥ 10 OOS DOTs").
 *
 * Real DOTs (not synthetic carriers) so the test exercises the full
 * data pipeline + the rule code. Fixtures occasionally drift when FMCSA
 * data changes — `scripts/refresh_fixtures.ts` finds replacement DOTs
 * by re-querying the parquet for the rule's criteria.
 */
export interface RuleFixture {
  dot: number;
  /** Human note explaining why this DOT was chosen (kept stable so refresh
   *  scripts can pick a comparable replacement). */
  reason?: string;
  /** Optional regex over the rule's `detail` text — confirms the rule
   *  surfaces the expected concrete values. */
  expectMatch?: RegExp;
}

export interface RuleFixtures {
  /** A DOT this rule should fire as Critical against. */
  critical?: RuleFixture;
  /** A DOT this rule should fire as High against. */
  high?: RuleFixture;
  /** A DOT this rule should fire as Caution against. */
  caution?: RuleFixture;
  /** A DOT this rule should NOT fire against — the "clean fixture" guards
   *  against false positives. */
  none?: RuleFixture;
}

export interface Rule {
  /** Stable kebab-case identifier. Never renamed. Used in tests, telemetry,
   *  URLs (e.g. /methodology#chameleon-address-cluster), and signal
   *  categories on both surfaces. */
  id: RuleId;
  /** Where this rule fires. A rule can appear on the website carrier audit,
   *  in the email reply, or both. Most rules are "both." */
  surface: RuleSurface[];
  /** Grouping bucket. Drives how the rule renders (which section it lands
   *  in) and how it shows up on the methodology page. */
  category: RuleCategory;
  /** Short imperative-or-noun-phrase title shown to the user. Same string
   *  for both surfaces. Example: "Address shared with multiple carriers." */
  label: string;
  /** Plain-language definition — what does this rule check, in words a
   *  non-technical broker can understand. Shown as a tooltip on the
   *  website, in the email body explanation, and on the methodology page.
   *  Keep to 1-3 sentences. */
  definition: string;
  /** Which severity tiers this rule can emit, plus the threshold
   *  description for each. The description is the user-facing
   *  threshold language ("≥10 OOS DOTs at this address"), not the code.
   *  Code lives in the evaluator. */
  thresholds: Partial<Record<RuleTier, string>>;
  /** Data sources this rule reads from. Lets us gate the rule when a
   *  source is missing in a snapshot, and credit the source on the
   *  methodology page. */
  sources: RuleSource[];
  /** Known-good DOTs that should trigger this rule at each tier. Tests
   *  run against these — failures mean either the rule broke or the
   *  fixture aged out. */
  fixtures?: RuleFixtures;
}
