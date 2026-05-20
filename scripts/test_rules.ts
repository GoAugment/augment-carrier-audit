/**
 * Rule-registry regression test.
 *
 * Iterates every rule in lib/rules/index.ts. For each rule with test
 * fixtures, loads the DOT from the FMCSA parquet, runs the audit + email
 * check, and asserts the rule fires at the expected tier.
 *
 * Run with: pnpm test:rules
 *
 * Failure modes:
 *   - "rule did not fire at expected tier X for DOT N"
 *       Either the rule code regressed, or the fixture DOT changed status
 *       in FMCSA and no longer matches. Pick a fresh DOT by re-running
 *       the rule's underlying query.
 *   - "rule unexpectedly fired on the 'none' fixture"
 *       A false-positive crept into the rule. Investigate.
 *   - "rule fixture references unknown DOT N"
 *       Parquet snapshot rotated and this DOT was dropped. Pick a new one.
 *
 * Tests run against the local parquet. CI does the same — we commit the
 * parquet so CI doesn't need a separate download.
 */
import { RULES } from "../lib/rules";
import type { Rule, RuleTier } from "../lib/rules";
import { fetchCarriers } from "../lib/fmcsa";
import { checkCarrierEmail } from "../lib/email/check";
import type { ExtractedEmail } from "../lib/email/types";

/** Minimal synthetic email that exercises the carrier path without
 *  triggering identity / lane / hazmat side-effects. Just enough to get
 *  the carrier resolved and the full evaluator chain to run. */
function syntheticEmailForDot(dot: number): ExtractedEmail {
  return {
    extracted_text: `Test email for DOT ${dot}.`,
    summary: "Synthetic fixture for rule regression test.",
    identity_claims: {
      dot_number: String(dot),
      mc_number: null,
      claimed_company_name: null,
      claimed_phone: null,
      contact_person: null,
    },
    sender_metadata: {
      sender_email: "fixture@example.com",
      sender_email_domain: "example.com",
      sender_display_name: "Fixture",
      reply_to_domain: null,
    },
    behavioral_signals: {
      is_response_to_load_posting: false,
      urgency_markers: [],
      has_signature_block: false,
      specificity_score: 0,
    },
    lane: {
      origin_city: null, origin_state: null,
      destination_city: null, destination_state: null,
      equipment_type: null, is_hazmat_load: false,
    },
  };
}

interface TestResult {
  ruleId: string;
  tier: RuleTier | "none";
  dot: number;
  passed: boolean;
  message: string;
}

async function testRuleFixture(
  rule: Rule,
  expectedTier: RuleTier | "none",
  dot: number,
  expectMatch?: RegExp,
): Promise<TestResult> {
  const carriers = await fetchCarriers([dot]);
  if (!carriers.has(dot)) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: `DOT ${dot} not found in parquet (fixture aged out — pick a new DOT)`,
    };
  }
  const verdict = await checkCarrierEmail(syntheticEmailForDot(dot));
  const signal = verdict.signals.find((s) => s.label === rule.label);

  if (expectedTier === "none") {
    if (signal) {
      return {
        ruleId: rule.id, tier: "none", dot, passed: false,
        message: `expected no firing on DOT ${dot} but got tier=${signal.tier}: "${signal.detail.slice(0, 100)}..."`,
      };
    }
    return { ruleId: rule.id, tier: "none", dot, passed: true, message: "did not fire (as expected)" };
  }

  if (!signal) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: `rule did not fire at all (expected tier=${expectedTier})`,
    };
  }
  if (signal.tier !== expectedTier) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: `wrong tier: expected ${expectedTier}, got ${signal.tier} (detail: "${signal.detail.slice(0, 100)}...")`,
    };
  }
  if (expectMatch && !expectMatch.test(signal.detail)) {
    return {
      ruleId: rule.id, tier: expectedTier, dot, passed: false,
      message: `detail did not match ${expectMatch}: "${signal.detail.slice(0, 200)}..."`,
    };
  }
  return { ruleId: rule.id, tier: expectedTier, dot, passed: true, message: `fired at tier=${signal.tier}` };
}

async function main(): Promise<void> {
  const results: TestResult[] = [];
  for (const rule of RULES) {
    const fx = rule.fixtures;
    if (!fx) continue;
    for (const tier of ["critical", "high", "caution", "none"] as const) {
      const f = fx[tier];
      if (!f) continue;
      results.push(await testRuleFixture(rule, tier, f.dot, "expectMatch" in f ? f.expectMatch : undefined));
    }
  }

  // Print results grouped by rule for clarity.
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
  if (failCount > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
