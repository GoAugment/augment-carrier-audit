/**
 * Rule registry schema.
 *
 * Every flag we surface to a user — on the website carrier audit row or in
 * the email reply — maps to a single Rule entry. The rule defines the
 * stable id, the user-facing label, the plain-language definition, the
 * tier thresholds, and the test fixtures.
 *
 * What lives here vs. inline in the evaluators:
 *   Registry         the stable contract (label, definition, threshold text)
 *   Evaluator code   the dynamic logic (when to fire, carrier-specific
 *                    detail strings with concrete numbers and dates)
 *
 * Why a registry at all:
 *   1. The website's carrier audit and the email reply share most of their
 *      rules (both go through analyzer.ts). The registry guarantees they
 *      share wording too. Editing a label in one place updates both
 *      surfaces; the two can't drift.
 *   2. Every rule has a stable id. Telemetry, deep-links, and tests
 *      reference rules by id so analytics survives label changes.
 *   3. Every rule has a fixture and a definition. Regressions surface
 *      automatically (test_rules + snapshot_audit); the definition is
 *      itself the documentation (greppable, reviewable in PR diffs).
 *
 * Schema is deliberately small. Fields are added when they have an
 * actual consumer — not pre-emptively.
 */

export type RuleId = string; // kebab-case, e.g. "chameleon-address-cluster"

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
 * A test fixture: a real DOT we know should trigger this rule at this tier.
 * `dot` must exist in the current parquet snapshot. `expectMatch` (optional)
 * is a regex applied to the rule's `detail` text — useful for confirming
 * the numbers in the detail match what we expect (e.g., "≥ 10 OOS DOTs").
 *
 * Real DOTs (not synthetic carriers) so the test exercises the full data
 * pipeline plus the rule code. Fixtures occasionally drift when FMCSA
 * data changes; refresh scripts pick replacements by re-querying the
 * parquet for the rule's criteria.
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
  /** A DOT this rule should NOT fire against — guards against false
   *  positives. */
  none?: RuleFixture;
}

export interface Rule {
  /** Stable kebab-case identifier. Never renamed. Used in tests, telemetry,
   *  deep-links, and as the runtime lookup key. */
  id: RuleId;
  /** Grouping bucket. Used to organize the inventory and group rules in
   *  future surfaces (methodology page, filtered registry views). */
  category: RuleCategory;
  /** Short noun-phrase title shown to the user. Plain text — no glyphs,
   *  no severity emoji. Tier coloring is the surface's job, not the
   *  label's. Example: "Insurance lapsed", "Address shared with
   *  out-of-service DOTs". */
  label: string;
  /** Plain-language definition. What does this rule check, in words a
   *  non-technical broker can understand? Even when no surface renders
   *  it today, the definition is the documentation — greppable,
   *  reviewable in PR diffs. Keep to 1-3 sentences. */
  definition: string;
  /** Threshold description for each tier the rule can emit. Text only,
   *  no executable logic. Evaluator code decides which tier fires;
   *  this string is the user-facing explanation of why. */
  thresholds: Partial<Record<RuleTier, string>>;
  /** Known-good DOTs that should trigger this rule at each tier. Tests
   *  run against these; failures mean either the rule broke or the
   *  fixture aged out of the current parquet snapshot. */
  fixtures?: RuleFixtures;
}
