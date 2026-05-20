/**
 * Walk lib/analyzer.ts + lib/email/check.ts and dump every place a rule
 * fires (reasons.push / signals.push). Used as the migration checklist
 * for Phase 2 of the rule-registry rollout.
 *
 * Output is a markdown table grouped by file. Run with:
 *   pnpm tsx scripts/inventory_rules.ts
 *
 * Heuristic, not a parser: we look for label / tier / category lines
 * within a few lines of each push. Manual review still required before
 * migrating any rule, but this saves combing through 1000+ lines.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface Hit {
  file: string;
  line: number;
  label: string;
  tier: string;
  category: string;
  context: string; // a few lines of surrounding code
}

const ROOT = join(__dirname, "..");
const FILES = ["lib/analyzer.ts", "lib/email/check.ts"];

function pull(re: RegExp, hay: string): string | null {
  const m = hay.match(re);
  return m ? m[1].trim() : null;
}

function inventoryFile(relPath: string): Hit[] {
  const lines = readFileSync(join(ROOT, relPath), "utf8").split("\n");
  const hits: Hit[] = [];
  for (let i = 0; i < lines.length; i++) {
    // Both push sites and axis-cell reason assignments emit user-facing
    // labels. Match three patterns:
    //   reasons.push({...}) or signals.push({...})   — list pushes
    //   foo.reason = {...}                            — axis cell reason
    //   reason: {                                     — inline reason block
    const isPush = /(?:reasons|signals)\.push\s*\(\s*\{/.test(lines[i]);
    const isAssign = /\.reason\s*=\s*\{/.test(lines[i]);
    const isInline = /^\s*reason:\s*\{/.test(lines[i]);
    if (!isPush && !isAssign && !isInline) continue;
    // Take a 12-line window after the push opener — covers multi-line label
    // / detail strings without dragging in a neighboring push.
    const window = lines.slice(i, Math.min(i + 12, lines.length)).join("\n");
    const label = pull(/label:\s*`?["'`]?(.+?)["'`,`]/s, window) ?? "(none)";
    const tier = pull(/tier:\s*["']?(\w+)["']?/, window) ?? "?";
    const category = pull(/category:\s*["']?(\w+)["']?/, window) ?? "?";
    hits.push({
      file: relPath,
      line: i + 1,
      label: label.slice(0, 90),
      tier,
      category,
      context: window.slice(0, 250),
    });
  }
  return hits;
}

function main(): void {
  const all: Hit[] = [];
  for (const f of FILES) all.push(...inventoryFile(f));
  // Group by file
  const byFile = new Map<string, Hit[]>();
  for (const h of all) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }
  console.log("# Rule inventory");
  console.log(`\nTotal push sites found: **${all.length}** across ${byFile.size} files.\n`);
  for (const [file, hits] of byFile) {
    console.log(`## ${file} (${hits.length})\n`);
    console.log("| Line | Tier | Category | Label |");
    console.log("|---:|---|---|---|");
    for (const h of hits) {
      console.log(`| ${h.line} | ${h.tier} | ${h.category} | ${h.label} |`);
    }
    console.log("");
  }
}

main();
