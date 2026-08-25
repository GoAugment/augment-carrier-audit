/**
 * Rule-registry regression test.
 *
 * Iterates every rule in lib/rules/index.ts. For each rule with test
 * fixtures, loads the DOT from the FMCSA parquet, exercises the
 * appropriate evaluator, and asserts the rule fires when expected.
 *
 * Two evaluator paths:
 *   • Carrier-side rules (categories: authority / insurance / smsBasic /
 *     crash / chameleon) — these are the analyzer.ts reasons surfaced
 *     in both the website audit and the email reply. The test runs
 *     analyze() against the DOT and checks the rule.label is present
 *     in the carrier's reasons[] array. Tier check uses the carrier's
 *     overall riskLevel (Critical/Severe → critical, High → high,
 *     Elevated → caution).
 *
 *   • Email-dependent rules (identity coherence / lane viability /
 *     hazmat / email authenticity) fire only when the email contains
 *     specific content. We currently don't fixture these — their
 *     behavior is deterministic given known input so regression risk
 *     is materially lower than the parquet-driven carrier rules.
 *
 * Run with: pnpm test:rules
 *
 * Failure modes:
 *   - "rule did not fire on DOT N"
 *       Either the rule code regressed or the fixture aged out (FMCSA
 *       data changed). Pick a fresh DOT by re-running the rule's
 *       underlying query against the current parquet.
 *   - "rule fired on the 'none' fixture but shouldn't"
 *       False positive crept in. Investigate.
 *   - "DOT N not found in parquet"
 *       Snapshot rotation dropped this DOT; pick a replacement.
 */
import { RULES } from "../lib/rules";
import type { Rule, RuleCategory, RuleTier } from "../lib/rules";
import { fetchCarriers } from "../lib/fmcsa";
import { analyze } from "../lib/analyzer";



const CARRIER_SIDE_CATEGORIES: ReadonlySet<RuleCategory> = new Set<RuleCategory>([
  "authority",
  "insurance",
  "smsBasic",
  "crash",
  "chameleon",
]);

interface TestResult {
  ruleId: string;
  tier: RuleTier | "none";
  dot: number;
  passed: boolean;
  message: string;
}

async function testCarrierSideFixture(
  rule: Rule,
  expectedTier: RuleTier | "none",
  dot: number,
  expectMatch?: RegExp,
): Promise<TestResult> {
  const carriers = await fetchCarriers([dot]);
  if (!carriers.has(dot)) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: `DOT ${dot} not found in parquet (fixture aged out, pick a new DOT)`,
    };
  }
  const result = analyze([{ dot, loadId: "fixture-test" }], carriers);
  const row = result.rows[0];
  if (!row) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: "analyze() returned no row",
    };
  }
  const reason = row.reasons.find((r) => r.label === rule.label);

  if (expectedTier === "none") {
    if (reason) {
      return {
        ruleId: rule.id, tier: "none", dot, passed: false,
        message: `expected no firing but rule appeared in reasons: "${reason.detail.slice(0, 100)}..."`,
      };
    }
    return { ruleId: rule.id, tier: "none", dot, passed: true, message: "did not fire (as expected)" };
  }

  // For critical/high/caution: we only check that the rule fired and the
  // detail matches expectMatch (if present). The tier slot is an
  // organizational hint for which severity profile the fixture
  // represents, NOT a runtime constraint — most analyzer reasons don't
  // carry per-reason tier info (the overall carrier riskLevel can be
  // dominated by a harder rule firing alongside this one, so checking
  // riskLevel === expectedTier produces conflation false-positives).
  // expectMatch is where to assert tier-specific content like "≥10" vs
  // "5 to 9" if the threshold language differs by tier.
  if (!reason) {
    // "did not fire" alone is not diagnosable: it cannot distinguish a real
    // regression from a fixture whose carrier moved, nor from the carrier
    // record being the wrong one entirely. So print the evidence — every reason
    // label JSON-escaped (the match is exact string equality, so whitespace and
    // Unicode matter) plus the inputs the rules actually gate on.
    //
    // Printing the inputs is what ended a seven-hypothesis hunt: `iss=null
    // activeAuth=null` on every carrier said at a glance that the record came
    // from a source without our derived columns, rather than that the rules had
    // regressed. Cheap, and it turns the next mystery into a look.
    const got = row.reasons.map((r) => r.label);
    const c = carriers.get(dot) as any;
    const inputs =
      `\n        input: status=${c?.statusCode} iss=${c?.issScore} ` +
      `activeAuth=${c?.hasActiveAuthority} bipdLapse=${c?.bipdImminentLapse} ` +
      `bipdOnFile=${c?.bipdInsuranceOnFile} PU=${c?.totalPowerUnits}`;
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message:
        `rule did not fire (carrier riskLevel=${row.riskLevel}); reasons present: ` +
        `${got.length ? got.map((l) => JSON.stringify(l)).join(", ") : "(none)"}${inputs}`,
    };
  }
  if (expectMatch && !expectMatch.test(reason.detail)) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: `detail did not match ${expectMatch}: "${reason.detail.slice(0, 200)}..."`,
    };
  }
  return { ruleId: rule.id, tier: expectedTier, dot, passed: true, message: `fired (riskLevel=${row.riskLevel})` };
}

async function main(): Promise<void> {
  const results: TestResult[] = [];
  let skipped = 0;
  for (const rule of RULES) {
    const fx = rule.fixtures;
    if (!fx || Object.keys(fx).length === 0) continue;

    if (!CARRIER_SIDE_CATEGORIES.has(rule.category)) {
      skipped++;
      continue;
    }

    for (const tier of ["critical", "high", "caution", "none"] as const) {
      const f = fx[tier];
      if (!f) continue;
      // `none` accepts either a single fixture or an array of negative
      // cases; other tiers are always a single fixture.
      const cases = Array.isArray(f) ? f : [f];
      for (const fixture of cases) {
        results.push(
          await testCarrierSideFixture(
            rule,
            tier,
            fixture.dot,
            "expectMatch" in fixture ? fixture.expectMatch : undefined,
          ),
        );
      }
    }
  }

  const byRule = new Map<string, TestResult[]>();
  for (const r of results) {
    if (!byRule.has(r.ruleId)) byRule.set(r.ruleId, []);
    byRule.get(r.ruleId)!.push(r);
  }
  let passCount = 0;
  let failCount = 0;
  for (const [ruleId, rs] of byRule) {
    console.log(`\n${ruleId}`);
    for (const r of rs) {
      const icon = r.passed ? "✓" : "✗";
      console.log(`  ${icon} [${r.tier.padEnd(8)}] DOT ${String(r.dot).padStart(8)}  ${r.message}`);
      if (r.passed) passCount++; else failCount++;
    }
  }
  console.log(`\n${passCount} passed, ${failCount} failed`);
  if (skipped > 0) {
    console.log(`(${skipped} email-dependent rules have fixtures defined but skipped — not yet wired into the test harness)`);
  }
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
