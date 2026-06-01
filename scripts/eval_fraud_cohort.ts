/**
 * One-off evaluation: run the 71 human-confirmed fraud/theft/double-broker
 * carriers (sourced from PROD.DIRECTORY.CARRIER DO_NOT_USE free-text reasons)
 * through the REAL analyzer pipeline — mirroring app/api/analyze/route.ts
 * (identity signals + sibling-status map + full analyze) — to measure recall:
 * of carriers we KNOW are bad, how many would the audit tool flag, and on
 * which signals?
 *
 *   pnpm tsx scripts/eval_fraud_cohort.ts
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  analyze,
  siblingStatusOf,
  type CarrierIdentityRiskSignals,
  type SiblingStatus,
} from "../lib/analyzer";
import { fetchCarriers, type FmcsaCarrier } from "../lib/fmcsa";

interface Row { dot: number; name: string; reason: string; }
const COHORT: Row[] = [
  { dot: 1028671, name: "Speedy Express Co. Inc.", reason: "SUSPENDED FOR DOUBLE BROKERING" },
  { dot: 1438983, name: "Fastway Trucking Inc", reason: "freight guard reports + unsafe driving" },
  { dot: 1439740, name: "Mg Trucking Group, Inc", reason: "Caught double brokering red handed" },
  { dot: 1797621, name: "DHINDSA GROUP OF COMPANIES INC.", reason: "1 PU + broker authority + FGRs" },
  { dot: 2054876, name: "MARTIN SORIA", reason: "Double Brokered" },
  { dot: 2072533, name: "CARGO COWBOYS CORP", reason: "freight Guard reports" },
  { dot: 2199392, name: "Cortez Transportation Llc", reason: "MC used to SCAM people" },
  { dot: 2230916, name: "All State Association Inc", reason: "DOUBLE BROKERED LOAD" },
  { dot: 2321331, name: "Flash Trucking Llc", reason: "unresolved claim + FGR" },
  { dot: 2333023, name: "Daver Trans Group, Inc", reason: "Suspicion of Double Brokering" },
  { dot: 2340662, name: "Chase Carrier Inc.", reason: "re-brokering FGR + controlled substance" },
  { dot: 2383311, name: "Cr Trucktrans Corp", reason: "FGRs" },
  { dot: 2419025, name: "Geneva Expedited Transport Inc", reason: "Double broker" },
  { dot: 2465329, name: "6350658 CANADA INC", reason: "DOCUMENT FALSIFICATION + transload" },
  { dot: 2469728, name: "ALREADY ARRIVED LOGISTICS INC", reason: "reported on HWY for stolen freight" },
  { dot: 2480363, name: "Us Smart Trucking Inc", reason: "FGRs, double broker" },
  { dot: 2496627, name: "Great White Logistics Inc", reason: "DOUBLE BROKERING SUSPECTED" },
  { dot: 2519910, name: "Ultimate Freight Carriers Inc", reason: "double brokering / 411 FGRs" },
  { dot: 2570846, name: "Gt Trans Inc", reason: "FGR uploaded" },
  { dot: 2584454, name: "Vikarm Trucking Inc", reason: "2 FGRs in 90 days" },
  { dot: 2781252, name: "A1 Logistics Inc", reason: "FGRs" },
  { dot: 2839595, name: "H.t. Express, Inc.", reason: "FGRs past year" },
  { dot: 2905560, name: "Sharp Trucking LLC", reason: "no active authority + FGRs" },
  { dot: 2929291, name: "Indy Freight Services Corporation", reason: "lied on claim + falsified docs" },
  { dot: 2936394, name: "Road Carriers USA", reason: "DOUBLE BROKERED" },
  { dot: 2948736, name: "DMA Services Inc", reason: "ACCUSED OF FRAUD" },
  { dot: 2951404, name: "Hopetrans", reason: "unanswered FGRs" },
  { dot: 2953170, name: "West & East Carriers Inc", reason: "Freightguard Report" },
  { dot: 2953461, name: "J R T Trans Corp", reason: "Freight Guard Report" },
  { dot: 2956341, name: "Enkneaux Logistics Llc", reason: "freight guard report" },
  { dot: 2982259, name: "Red Diamond Transportation Llc", reason: "freight guard reports" },
  { dot: 2988367, name: "Holloway Express Transport Llc", reason: "Double Brokering" },
  { dot: 3026711, name: "Cargo-freight Logistics", reason: "Shell Carrier to Double Broker" },
  { dot: 3041442, name: "Ert Logistics Llc", reason: "Freight Guard Report" },
  { dot: 3047924, name: "Right Way Logistics Llc", reason: "fraudulent activity + double brokering" },
  { dot: 3056794, name: "Friendship Trucking Inc", reason: "Conditional rating + FGR" },
  { dot: 3074995, name: "Coverall Trucking Inc.", reason: "Neg Report" },
  { dot: 3095937, name: "Transjet Cargo", reason: "Double Brokered" },
  { dot: 3103017, name: "B & S Truck Lines Llc", reason: "FGR: smuggling immigrants" },
  { dot: 3122262, name: "Geel Convoy Inc", reason: "FRAUD CONTACT booking loads" },
  { dot: 3122689, name: "Magic Trans Llc", reason: "FGR + 1yr in business" },
  { dot: 3133710, name: "Grd Trucking Inc", reason: "RISK FOR FRAUD CONTACT" },
  { dot: 3164126, name: "TOOR LOGISTIC INC", reason: "REPORTED FOR FRAUD" },
  { dot: 3174359, name: "Ga Transportation Inc", reason: "CARRIER411 FGRs" },
  { dot: 3177538, name: "Sky Freight Inc", reason: "ARRIVED IN STOLEN TRAILER" },
  { dot: 3187994, name: "222 Carrier Inc.", reason: "Double broker situation" },
  { dot: 3205537, name: "F&m Elite Trucking Llc", reason: "411 FGR" },
  { dot: 3277236, name: "MDA TRANS INC", reason: "fraudulent activity (email/phone)" },
  { dot: 3340888, name: "Istrati Nc LLC", reason: "multiple associations + double brokering" },
  { dot: 3381341, name: "Hay Line Trucking Inc", reason: "Double Brokering Shell Carrier" },
  { dot: 3411427, name: "Maan Brothers Logistic Inc", reason: "REPORTED FOR STOLEN FREIGHT" },
  { dot: 3436775, name: "Crow Transport LLC", reason: "double broker situation" },
  { dot: 3466263, name: "JASSAR TRANS LLC", reason: "Email hacked fraud booking" },
  { dot: 3476855, name: "Nik Trans Inc", reason: "Suspected Double Brokering" },
  { dot: 3479486, name: "Rush Deliveries LLC", reason: "Identity theft on this MC" },
  { dot: 3483627, name: "Aja Brothers Inc", reason: "DOUBLE BROKERED" },
  { dot: 3526943, name: "United Trucking Logistics", reason: "Glendale Double Broker" },
  { dot: 3544421, name: "Nsho LLC", reason: "CARRIER411 FGRs" },
  { dot: 3579740, name: "GOLDENWHEELS INC", reason: "POSSIBLE FRAUD CONTACT" },
  { dot: 3662463, name: "Duke Corp", reason: "Double Brokered" },
  { dot: 3668636, name: "STRAIGHT CARGO LLC", reason: "victim of fraud / phishing" },
  { dot: 3742489, name: "Lider Trade Inc", reason: "double broker situation" },
  { dot: 3778058, name: "Lusabats 55", reason: "2 FGRs + 11mo authority" },
  { dot: 3831108, name: "BEST USA TRANSPORT LLC", reason: "multiple associations + double brokering" },
  { dot: 3863628, name: "JONATHAN RAMIREZ TRUCKING LLC", reason: "Load Theft / Fraudulent Activity" },
  { dot: 3887332, name: "Proper Truckers Inc", reason: "Double Brokering" },
  { dot: 3956083, name: "Aries Emperor Corp", reason: "double brokering" },
  { dot: 4134798, name: "PADDA TRANSPORT LLC", reason: "fraudulent booking + stolen shipment" },
  { dot: 4257410, name: "LYNNWAY LOGISTICS LLC", reason: "DOUBLE BROKERED OUR LOAD" },
  { dot: 4348979, name: "RRA TRUCKING INC", reason: "Under investigation for Fraud" },
  { dot: 24681012, name: "Mann Public Warehouse", reason: "Carrier shell created" },
];

async function main() {
  const dots = COHORT.map((c) => c.dot);
  const carriers = await fetchCarriers(dots);

  let identitySignals = new Map<number, CarrierIdentityRiskSignals>();
  try {
    const { fetchIdentityRiskSignals } = await import("../lib/fmcsa-identity");
    identitySignals = await fetchIdentityRiskSignals(dots);
  } catch (err) {
    console.warn("identity risk signals unavailable", err);
  }

  // sibling status map (mirror route.ts)
  const dotSet = new Set(dots);
  const siblingDots = Array.from(
    new Set(
      Array.from(carriers.values())
        .map((c) => c.largestSiblingDot)
        .filter((d): d is number => typeof d === "number" && d > 0 && !dotSet.has(d))
    )
  );
  const siblingCarriers: Map<number, FmcsaCarrier> = siblingDots.length
    ? await fetchCarriers(siblingDots)
    : new Map();
  const siblingStatusMap = new Map<number, SiblingStatus>();
  for (const c of [...carriers.values(), ...siblingCarriers.values()]) {
    if (c.dotNumber != null) siblingStatusMap.set(c.dotNumber, siblingStatusOf(c));
  }

  const loads = COHORT.map((c) => ({ dot: c.dot, isHazmat: false }));
  const result = analyze(loads, carriers, siblingStatusMap, identitySignals);
  const byDot = new Map(result.rows.map((r) => [r.dot, r]));

  const tierCounts: Record<string, number> = {};
  const contribCounts: Record<string, number> = {};
  let found = 0;
  const details: unknown[] = [];
  const lines: string[] = [];

  for (const c of COHORT) {
    const row = byDot.get(c.dot);
    if (!row) {
      tierCounts["NOT_IN_PARQUET"] = (tierCounts["NOT_IN_PARQUET"] ?? 0) + 1;
      lines.push(`  ✗ ${c.dot}  NOT IN FMCSA DATA   ${c.name}  — ${c.reason}`);
      details.push({ dot: c.dot, name: c.name, reason: c.reason, inData: false });
      continue;
    }
    found++;
    const tier = row.riskTier;
    tierCounts[tier] = (tierCounts[tier] ?? 0) + 1;
    for (const f of row.riskContributions) {
      const key = `[${f.category}] ${f.label}`;
      contribCounts[key] = (contribCounts[key] ?? 0) + 1;
    }
    lines.push(
      `  ${row.riskScore >= 35 ? "✓" : "·"} ${c.dot}  ${String(row.riskScore).padStart(3)} ${row.riskTier.padEnd(8)} ${row.riskLevel.padEnd(9)}  ${c.name}  — ${c.reason}`
    );
    details.push({
      dot: c.dot, name: c.name, reason: c.reason, inData: true,
      riskScore: row.riskScore, riskTier: row.riskTier, riskLevel: row.riskLevel,
      contributions: row.riskContributions.map((f) => `+${f.points} [${f.category}] ${f.label}`),
      reasonLabels: row.reasons.map((r) => r.label),
    });
  }

  console.log("\n=== Per-carrier verdicts (✓ = score≥35 flagged) ===\n");
  console.log(lines.join("\n"));

  console.log("\n=== Tier distribution (recall) ===");
  const order = ["Critical", "High", "Medium", "Low", "None", "NOT_IN_PARQUET"];
  for (const t of order) if (tierCounts[t]) console.log(`  ${t.padEnd(16)} ${tierCounts[t]}`);
  console.log(`  ${"TOTAL".padEnd(16)} ${COHORT.length}  (in FMCSA data: ${found})`);

  const flagged = (tierCounts["Critical"] ?? 0) + (tierCounts["High"] ?? 0) + (tierCounts["Medium"] ?? 0);
  console.log(`\n  Flagged (Medium+): ${flagged}/${COHORT.length} = ${(100*flagged/COHORT.length).toFixed(0)}% of all confirmed fraud`);
  console.log(`  Flagged of those in data: ${flagged}/${found} = ${found ? (100*flagged/found).toFixed(0) : 0}%`);

  console.log("\n=== Which signals fired (across the in-data carriers) ===");
  for (const [k, n] of Object.entries(contribCounts).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${k}`);
  }

  const outPath = join("/tmp", "fraud_cohort_eval.json");
  writeFileSync(outPath, JSON.stringify(details, null, 2));
  console.log(`\nFull per-carrier detail → ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
