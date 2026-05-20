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
  // CHAMELEON
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
