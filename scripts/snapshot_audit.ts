/**
 * Snapshot regression test for analyzer.ts (website carrier audit).
 *
 * Usage:
 *   pnpm tsx scripts/snapshot_audit.ts          # run regression
 *   pnpm tsx scripts/snapshot_audit.ts --update # re-snapshot (after intentional change)
 *
 * The snapshot covers ~30 real DOTs that collectively exercise every
 * inline rule in analyzer.ts (insurance lapses, revocations, SMS BASIC
 * alerts, fatal crashes, prior-revoke chameleon, address-cluster
 * chameleon, enforcement, new-authority, clean baseline, mega-carriers).
 *
 * For each DOT we snapshot the deterministic parts of the audit row:
 *   - riskLevel             (Critical / Severe / High / Elevated / Clean)
 *   - riskScore / riskTier  (0-100 score + score band)
 *   - riskContributions     (pointed factor labels)
 *   - reason labels         (the bulleted findings shown on the audit row)
 *   - axis cell statuses    (clean / elevated / high / severe / critical / na)
 *
 * We do NOT snapshot:
 *   - Free-text detail strings inside reasons. Those include carrier-
 *     specific values (counts, dates, percentages) that change with
 *     each parquet refresh. The label is the stable contract.
 *   - Crash counts, OOS rates, BIPD amounts — these are inputs, not
 *     rule outputs. Their stability is the parquet's job, not ours.
 *
 * Failure modes:
 *   - "label changed": somebody edited the inline string. Rerun with
 *     --update if intentional. Otherwise: regression.
 *   - "tier changed": rule logic regressed, or fixture aged out.
 *   - "carrier not found": parquet rotated. Pick a replacement DOT.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fetchCarriers } from "../lib/fmcsa";
import { analyze, parseInput } from "../lib/analyzer";
import type { CarrierIdentityRiskSignals } from "../lib/analyzer";

const SNAPSHOT_DIR = join(__dirname, "..", "test", "snapshots", "audit");
const UPDATE = process.argv.includes("--update");

interface SnapshotDot {
  dot: number;
  reason: string;
}

/** Fixtures chosen via .context/pick_snapshot_dots.py against the May 2026
 *  parquet snapshot. Each DOT exercises a distinct rule path. */
const SNAPSHOT_DOTS: SnapshotDot[] = [
  // Clean baselines — should fire zero hard reasons
  { dot: 64,       reason: "CLEAN: active interstate, no flags" },
  { dot: 651,      reason: "CLEAN: active interstate, no flags" },

  // Mega carriers — should be Clean despite high inspection volume
  { dot: 53467,    reason: "CLEAN-BIG: Werner Enterprises" },
  { dot: 80806,    reason: "CLEAN-BIG: J B Hunt" },
  { dot: 264184,   reason: "CLEAN-BIG: Schneider National" },

  // Critical: $0 BIPD insurance
  { dot: 3670294,  reason: "CRITICAL: $0 BIPD" },
  { dot: 4546639,  reason: "CRITICAL: $0 BIPD" },

  // Medium/Critical: rapid-replace + cancellations
  { dot: 4223713,  reason: "MEDIUM: rapid replace + 2 cancellations" },
  { dot: 4170928,  reason: "CRITICAL: rapid replace + ≥3 cancellations" },

  // Critical: recent involuntary revocation
  { dot: 2564360,  reason: "CRITICAL: recent involuntary revocation" },

  // Critical: prior-revoke flag (chameleon predecessor)
  { dot: 12311,    reason: "CRITICAL: prior-revoke chameleon" },
  { dot: 2285207,  reason: "CRITICAL: prior-revoke chameleon" },

  // High/Critical: SMS BASIC alerts
  { dot: 3409034,  reason: "HIGH: Unsafe Driving alert" },
  { dot: 4307204,  reason: "CRITICAL: Vehicle OOS alert" },
  { dot: 4223883,  reason: "HIGH: HOS alert" },

  // High: crash rate
  { dot: 572610,   reason: "HIGH: crashes per million miles" },
  { dot: 3048377,  reason: "HIGH: crashes per million miles" },

  // Fatal crash
  { dot: 1429009,  reason: "FATAL: ≥1 fatal crash in 24mo" },
  { dot: 4208930,  reason: "FATAL: ≥1 fatal crash in 24mo" },

  // New authority
  { dot: 4572009,  reason: "CRITICAL: new authority under 90 days" },

  // Address chameleon (already used in rule fixtures, included for coverage)
  { dot: 2763893,  reason: "CRITICAL: 66 OOS DOTs at same address" },
  { dot: 3306076,  reason: "CRITICAL: ≥10 OOS DOTs at same address" },
  { dot: 4393031,  reason: "HIGH: 5 OOS DOTs at same address" },
  { dot: 4177120,  reason: "CAUTION: 3 OOS DOTs at same address" },
  { dot: 2619058,  reason: "CLEAN: no address sharing" },

  // Enforcement
  { dot: 3439499,  reason: "ENFORCEMENT: closed enforcement case" },
  { dot: 2036827,  reason: "ENFORCEMENT: closed enforcement case" },

  // Identity/chameleon via the shut-down contact graph. Both share email AND
  // phone with several shut-down involuntarily-revoked DOTs — 3436431 with
  // three serial "J & G" carriers, 3770548 with four home-delivery ones. These
  // were invisible before the shut-down universe moved off the SMS census
  // (build_risk_signals.cjs), so they guard that regression specifically.
  { dot: 3436431,  reason: "IDENTITY: email+phone shared with shut-down revoked DOTs" },
  { dot: 3770548,  reason: "IDENTITY: email+phone shared with shut-down revoked DOTs" },
];

interface AuditSnapshot {
  dot: number;
  reasonNote: string;
  carrierName: string | null;
  riskLevel: string;
  riskScore: number;
  riskTier: string;
  riskContributions: string[];
  reasonLabels: string[];           // labels only — details have carrier-specific values
  axes: Record<string, string>;     // axis key → status
}

async function snapshotDot(dot: number, reasonNote: string): Promise<AuditSnapshot | null> {
  const carriers = await fetchCarriers([dot]);
  const carrier = carriers.get(dot);
  if (!carrier) return null;
  const { loads } = parseInput(String(dot));
  // Load the identity risk signals exactly as /api/analyze does. Without this
  // the snapshots silently under-test production: every identity-derived
  // contribution (shut-down contact graph, shared insurance policy, free email
  // domain, residential address, phone/home geo) is worth up to +20 each and
  // was invisible to this suite.
  let identitySignals = new Map<number, CarrierIdentityRiskSignals>();
  try {
    const { fetchIdentityRiskSignals } = await import("../lib/fmcsa-identity");
    identitySignals = await fetchIdentityRiskSignals([dot]);
  } catch (err) {
    console.warn(`identity risk signals unavailable for ${dot}`, err);
  }
  const result = analyze(loads, carriers, new Map(), identitySignals);
  const row = result.rows[0];
  if (!row) return null;
  const axes: Record<string, string> = {};
  for (const [k, v] of Object.entries(row.axes)) {
    axes[k] = (v as { status: string }).status;
  }
  return {
    dot,
    reasonNote,
    carrierName: carrier.legalName ?? null,
    riskLevel: row.riskLevel,
    riskScore: row.riskScore,
    riskTier: row.riskTier,
    riskContributions: row.riskContributions.map(
      (f) => `+${f.points} [${f.category}] ${f.label}`
    ),
    reasonLabels: row.reasons.map((r) => r.label),
    axes,
  };
}

function snapshotPath(dot: number): string {
  return join(SNAPSHOT_DIR, `${dot}.json`);
}

function loadExisting(dot: number): AuditSnapshot | null {
  const p = snapshotPath(dot);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

function diffSnapshots(a: AuditSnapshot, b: AuditSnapshot): string[] {
  const diffs: string[] = [];
  if (a.riskLevel !== b.riskLevel) {
    diffs.push(`riskLevel: ${a.riskLevel} → ${b.riskLevel}`);
  }
  if (a.riskScore !== b.riskScore) {
    diffs.push(`riskScore: ${a.riskScore} → ${b.riskScore}`);
  }
  if (a.riskTier !== b.riskTier) {
    diffs.push(`riskTier: ${a.riskTier} → ${b.riskTier}`);
  }
  if (JSON.stringify(a.riskContributions) !== JSON.stringify(b.riskContributions)) {
    const removed = a.riskContributions.filter((l) => !b.riskContributions.includes(l));
    const added = b.riskContributions.filter((l) => !a.riskContributions.includes(l));
    if (removed.length) diffs.push(`risk contributions removed: ${removed.join(" | ")}`);
    if (added.length)   diffs.push(`risk contributions added:   ${added.join(" | ")}`);
  }
  if (JSON.stringify(a.reasonLabels) !== JSON.stringify(b.reasonLabels)) {
    const removed = a.reasonLabels.filter((l) => !b.reasonLabels.includes(l));
    const added = b.reasonLabels.filter((l) => !a.reasonLabels.includes(l));
    if (removed.length) diffs.push(`reasons removed: ${removed.join(" | ")}`);
    if (added.length)   diffs.push(`reasons added:   ${added.join(" | ")}`);
  }
  for (const [k, v] of Object.entries(a.axes)) {
    if (b.axes[k] !== v) {
      diffs.push(`axes.${k}: ${v} → ${b.axes[k]}`);
    }
  }
  return diffs;
}

async function main(): Promise<void> {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  let pass = 0;
  let fail = 0;
  let missing = 0;
  const failures: string[] = [];

  for (const { dot, reason } of SNAPSHOT_DOTS) {
    const current = await snapshotDot(dot, reason);
    if (!current) {
      console.log(`  ✗ DOT ${dot} not in parquet  (${reason})`);
      missing++;
      continue;
    }

    if (UPDATE) {
      writeFileSync(snapshotPath(dot), JSON.stringify(current, null, 2) + "\n");
      console.log(`  ↻ DOT ${dot}  [${current.riskLevel.padEnd(8)}]  ${reason}`);
      continue;
    }

    const existing = loadExisting(dot);
    if (!existing) {
      writeFileSync(snapshotPath(dot), JSON.stringify(current, null, 2) + "\n");
      console.log(`  + DOT ${dot}  [${current.riskLevel.padEnd(8)}]  new snapshot  (${reason})`);
      continue;
    }

    const diffs = diffSnapshots(existing, current);
    if (diffs.length === 0) {
      pass++;
    } else {
      fail++;
      const lines = [`  ✗ DOT ${dot}  ${current.carrierName ?? "?"}  (${reason})`];
      for (const d of diffs) lines.push(`      ${d}`);
      const out = lines.join("\n");
      failures.push(out);
      console.log(out);
    }
  }

  if (UPDATE) {
    console.log(`\nUpdated ${SNAPSHOT_DOTS.length - missing} snapshots.`);
    if (missing) console.log(`${missing} DOTs missing from parquet.`);
    return;
  }
  console.log(`\n${pass} passed, ${fail} failed, ${missing} missing.`);
  if (fail > 0) {
    console.log("\nIf the changes were intentional, re-snapshot with:");
    console.log("  pnpm tsx scripts/snapshot_audit.ts --update");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
