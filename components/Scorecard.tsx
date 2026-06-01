"use client";
import { Fragment, useState } from "react";
import type {
  AuditResult,
  AxisCell,
  AxisStatus,
  CarrierRow,
  RiskLevel,
} from "@/lib/analyzer";
import { toCsv } from "@/lib/csv";

const riskStyles: Record<RiskLevel, string> = {
  Critical: "bg-red-200 text-red-950 border-red-400 font-semibold",
  High: "bg-orange-100 text-orange-900 border-orange-200",
  Medium: "bg-amber-50 text-amber-900 border-amber-200",
  Low: "bg-augment-50 text-augment-900 border-augment-200",
};

// The "Low" tier is shown as "Clean", for a broker, the bottom tier means
// "nothing flagged," which reads more clearly than "Low".
const verdictLabel: Record<RiskLevel, string> = {
  Critical: "Critical",
  High: "High",
  Medium: "Medium",
  Low: "Clean",
};

// Accent bar on the left of an expanded reasons panel, colored by tier
// (Critical = the red bar in the design).
const barColor: Record<RiskLevel, string> = {
  Critical: "border-l-red-500",
  High: "border-l-orange-400",
  Medium: "border-l-amber-400",
  Low: "border-l-augment-400",
};

// Tier section-header styling (the "● CRITICAL · N carriers" divider rows that
// group the matrix by verdict, replacing the per-row verdict pill).
const tierDot: Record<RiskLevel, string> = {
  Critical: "bg-[#D7453C]",
  High: "bg-[#E89432]",
  Medium: "bg-[#D4AA28]",
  Low: "bg-[#2EB873]",
};
const tierText: Record<RiskLevel, string> = {
  Critical: "text-[#7E1A14]",
  High: "text-[#8A4A0E]",
  Medium: "text-[#92400E]",
  Low: "text-[#0F5A41]",
};

const rowTint: Record<RiskLevel, string> = {
  Critical: "bg-red-50/80",
  High: "bg-orange-50/40",
  Medium: "bg-amber-50/30",
  Low: "",
};

const cellStyles: Record<AxisStatus, string> = {
  critical: "bg-red-200 text-red-950 font-semibold",
  severe: "bg-red-100 text-red-900",
  high: "bg-orange-100 text-orange-900",
  elevated: "bg-amber-100/60 text-amber-900",
  /** info = contextual signal (e.g. old revocations), amber, lighter than elevated.
   *  Does NOT contribute to overall risk tier; just surfaces in the cell. */
  info: "bg-amber-50 text-amber-800",
  clean: "bg-augment-50 text-augment-800",
  na: "bg-ink-50 text-ink-400",
};

// The on-road BASIC columns are peer-rank REFERENCE data (a percentile per
// axis), not a verdict, so they get a quieter single-hue treatment: neutral
// until the carrier crosses FMCSA's alert level, then orange (deeper = further
// above peers). They never go amber or red. Red/amber stay reserved for the
// verdict columns, so a peer percentile (e.g. 86th) can't be visually confused
// with a Critical score (e.g. 82).
const basicCellStyles: Record<AxisStatus, string> = {
  critical: "bg-orange-200 text-orange-950 font-semibold",
  severe: "bg-orange-100 text-orange-900",
  high: "bg-orange-100 text-orange-900",
  elevated: "text-ink-700",
  info: "text-ink-500",
  clean: "bg-augment-50 text-augment-800",
  na: "bg-ink-50 text-ink-400",
};

/**
 * Compact, collapsible explainer. Renders as one line by default; clicking
 * "more" expands the math/methodology details. Saves vertical real estate
 * above the table while keeping the docs one click away.
 */
function ReadingNote() {
  const [open, setOpen] = useState(false);
  return (
    <div className="mb-3 text-xs text-ink-600">
      <p>
        Two color scales. The <span className="font-semibold text-ink-700">verdict</span> columns
        (ISS, Risk score, and authority/insurance standing) use the full alarm ramp,{" "}
        <span className="rounded bg-augment-50 px-1 text-augment-800">clean</span>{" "}
        <span className="rounded bg-amber-100/60 px-1 text-amber-900">elevated</span>{" "}
        <span className="rounded bg-orange-100 px-1 text-orange-900">high</span>{" "}
        <span className="rounded bg-red-200 px-1 text-red-950 font-semibold">critical</span>
        . The <span className="font-semibold text-ink-700">on-road BASIC</span> columns are peer
        percentiles (reference, not a verdict): they stay neutral until the carrier crosses FMCSA&apos;s
        alert level, then turn{" "}
        <span className="rounded bg-orange-100 px-1 text-orange-900">orange</span> (deeper = further
        above peers), a single axis never goes red, so an{" "}
        <span className="tabular-nums">86th</span> percentile isn&apos;t confused with a Critical score.
        We flag on the last 24 months of activity; hover any cell for details.{" "}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
        >
          {open ? "less" : "more"}
        </button>
      </p>
      {open && (
        <div className="mt-2 space-y-2 text-ink-500">
          <p>
            <span className="font-semibold text-ink-700">Statistical axes</span> (Unsafe Driving,
            HOS, Driver Fitness, Controlled Substances, Vehicle Maintenance) fire <span className="rounded bg-red-100 px-1 text-red-900">severe</span>{" "}
            only when the carrier&apos;s rate is at or above the 95th percentile of their peer
            group (≈1-in-20 outlier). Crash rate uses crashes per million miles, peer-group P95.
          </p>
          <p>
            <span className="font-semibold text-ink-700">Hard signals</span> can also flag:
            recent involuntary revocations (≤24mo), FMCSA chameleon flag against a different
            predecessor DOT (Critical), insurance lapsed below FMCSA-required (Critical),
            insurance cancel+replace within 30 days with ≥3 true cancellations (Critical), and
            ≥7 true insurance cancellations in 24mo (Critical).
          </p>
          <p>
            <span className="font-semibold text-ink-700">Info-only context</span> doesn&apos;t flag,
            old Satisfactory ratings (&gt;10y), historical revocations with no recent activity,
            and BIPD insurance below the $1M industry floor but at FMCSA-required levels are
            surfaced in the tooltip but do not contribute to the carrier&apos;s tier.
          </p>
        </div>
      )}
    </div>
  );
}

function Cell({
  cell,
  className = "",
  quiet = false,
}: {
  cell: AxisCell;
  className?: string;
  /** quiet = on-road BASIC reference column (orange-only heat, never red/amber). */
  quiet?: boolean;
}) {
  const styles = quiet ? basicCellStyles : cellStyles;
  return (
    <td
      className={`px-2 py-2 text-center text-xs tabular-nums ${className} ${styles[cell.status]}`}
      title={cell.detail ?? ""}
    >
      <div>{cell.display}</div>
      {cell.sub && (
        <div className="text-[10px] font-normal opacity-60">{cell.sub}</div>
      )}
    </td>
  );
}

// Risk and ISS render as ordinary grid columns (same colored-Cell presentation
// as the BASIC axes). ISS remains visible because customers recognize it; the
// carrier risk score is the product score that includes safety, authority,
// insurance, identity/chameleon, operations, and corroborating context.

/** Carrier Risk Score → AxisCell. The number, colored by the carrier's VERDICT
 *  TIER (not a separate score banding) so the cell matches the tier dot + label
 *  exactly: one consistent ramp where red = Critical, orange = High, amber =
 *  Medium, green = Low/None. (Previously banded the raw score to severe/high/
 *  elevated, which made a Critical carrier show red-100 here but red-200 on its
 *  tier badge, two reds for the same verdict.) */
function riskCellOf(r: CarrierRow): AxisCell {
  const status: AxisStatus =
    r.riskTier === "Critical"
      ? "critical"
      : r.riskTier === "High"
        ? "high"
        : r.riskTier === "Medium"
          ? "elevated"
          : "clean"; // Low / None, low concern, green
  const factorBody =
    r.riskContributions.length > 0
      ? `\n\nContributions:\n• ${r.riskContributions
          .map((f) => `+${f.points} [${f.category}] ${f.label}: ${f.detail}`)
          .join("\n• ")}`
      : "\n\nNo scored carrier-risk factors detected.";
  return {
    status,
    display: String(r.riskScore),
    sub: r.riskTier === "None" ? undefined : r.riskTier,
    detail: `Carrier Risk Score (0-100, higher = worse), tier ${r.riskTier}: transparent additive score across safety, authority/insurance, identity/chameleon, operations, and corroborating context. A heuristic index, not a probability.${factorBody}`,
  };
}

// NB: the Augie Safety Score is still computed (CarrierRow.safetyScore / CSV) but
// not shown as its own column. ISS stays visible as the government-style estimate;
// safety also contributes to the single carrier risk score.

/** Estimated FMCSA ISS score → AxisCell (verdict-group column). */
function issCellOf(r: CarrierRow): AxisCell {
  if (r.issScore == null || r.issTier == null) {
    return {
      status: "na",
      display: "—",
      detail: "Not enough inspection/investigation data for an ISS estimate.",
    };
  }
  // Inspect→high(orange), Optional→elevated(amber), Pass→clean(green).
  const status: AxisStatus =
    r.issTier === "Inspect"
      ? "high"
      : r.issTier === "Optional"
        ? "elevated"
        : "clean";
  return {
    status,
    display: String(r.issScore),
    sub: r.issTier,
    detail:
      "Estimated FMCSA Inspection Selection System score (1-100, higher = FMCSA more likely to inspect). Reproduced from public BASIC/investigation data, FMCSA does not publish ISS. See note below the table.",
  };
}

// Split a carrier's signals into the two buckets we show inline: on-road safety
// findings vs the scored carrier-risk contributions and non-safety standing
// findings.
const SAFETY_RE =
  /crash|unsafe driving|hos compliance|driver oos|vehicle oos|hazmat|fast.?act|acute|serious viol|iss,|multiple basic|safety rating/i;

type Signal = { label: string; detail: string; points?: number; category?: string };
function splitSignals(r: CarrierRow): {
  safety: Signal[];
  risk: Signal[];
} {
  const safety: Signal[] = [];
  const risk: Signal[] = r.riskContributions.map((f) => ({
    label: f.label,
    detail: f.detail,
    points: f.points,
    category: f.category,
  }));
  const seen = new Set(risk.map((f) => f.label.toLowerCase()));
  for (const reason of r.reasons) {
    if (SAFETY_RE.test(reason.label)) {
      safety.push(reason);
      continue;
    }
    if (seen.has(reason.label.toLowerCase())) continue;
    risk.push(reason);
  }
  return { safety, risk };
}

const PREVIEW_ROWS = 10;

/** Skip the lead-capture gate on local dev so the full list is visible. */
function isLocalDev(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return h === "localhost" || h === "127.0.0.1" || h.endsWith(".local");
}

export function Scorecard({
  rows,
  result,
}: {
  rows: CarrierRow[];
  result?: AuditResult;
}) {
  const [showAll, setShowAll] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  // Per-row expand: the reasons panel is collapsed by default so the matrix
  // reads as a compact scannable grid; the top (worst) carrier is expanded on
  // first paint so there's immediate detail. Clicking any flagged row toggles it.
  const [expandedDots, setExpandedDots] = useState<Set<number>>(() => {
    const first =
      rows.find((r) => r.riskLevel === "Critical" || r.riskLevel === "High") ??
      rows[0];
    return new Set(first ? [first.dot] : []);
  });
  const toggleExpanded = (dot: number) =>
    setExpandedDots((prev) => {
      const next = new Set(prev);
      if (next.has(dot)) next.delete(dot);
      else next.add(dot);
      return next;
    });
  // Triage view: the default queue is Critical + High ("review these"). Medium
  // (awareness/FYI) and Low (clean) collapse behind a toggle so a big arrive
  // list doesn't bury the carriers that actually need a decision.
  const review = rows.filter(
    (r) => r.riskLevel === "Critical" || r.riskLevel === "High"
  );
  const criticalCount = rows.filter((r) => r.riskLevel === "Critical").length;
  const highCount = rows.filter((r) => r.riskLevel === "High").length;
  const mediumCount = rows.filter((r) => r.riskLevel === "Medium").length;
  const cleanCount = rows.filter((r) => r.riskLevel === "Low").length;
  const extraCount = mediumCount + cleanCount;
  const totalCarriers = rows.length;
  const totalLoads = result?.totalLoads ?? rows.reduce((a, r) => a + r.loadCount, 0);
  // If nothing needs review, fall back to showing everything (don't render blank).
  const allRows = showAll || review.length === 0 ? rows : review;
  const gateActive = !isLocalDev() && allRows.length > PREVIEW_ROWS && !unlocked;
  const visibleRows = gateActive ? allRows.slice(0, PREVIEW_ROWS) : allRows;
  const hiddenCount = allRows.length - visibleRows.length;
  // Count carriers per tier within the visible set, for the section dividers.
  const tierCount = (level: RiskLevel) =>
    visibleRows.filter((r) => r.riskLevel === level).length;
  return (
    <div className="mt-6">
      <div className="mb-1 flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-lg font-semibold text-ink-900">
            {totalLoads} load{totalLoads === 1 ? "" : "s"} · {totalCarriers} carrier
            {totalCarriers === 1 ? "" : "s"}
          </span>
          <span className="text-ink-300">·</span>
          <span className="text-sm font-semibold text-ink-900">
            {review.length} flagged
          </span>
          {criticalCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-900">
              <strong className="font-semibold tabular-nums">{criticalCount}</strong>
              <span className="ml-1">Critical</span>
            </span>
          )}
          {highCount > 0 && (
            <span className="inline-flex items-center rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
              <strong className="font-semibold tabular-nums">{highCount}</strong>
              <span className="ml-1">High</span>
            </span>
          )}
        </div>
        {extraCount > 0 && review.length > 0 && (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="shrink-0 text-sm text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
          >
            {showAll ? "Show review queue only" : `Show all ${rows.length} carriers`}
          </button>
        )}
      </div>
      <div className="mb-3 text-xs text-ink-500">
        <strong className="font-medium text-ink-700">{review.length}</strong> need
        review <span className="text-ink-400">(Critical + High)</span>
        {extraCount > 0 && (
          <>
            {" · "}
            {mediumCount} Medium · {cleanCount} clean
            {!showAll && review.length > 0 ? " (hidden)" : ""}
          </>
        )}
      </div>
      <ReadingNote />

      <div className="rounded-lg border border-ink-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-white text-[11px] font-semibold uppercase tracking-wide text-[#596560] shadow-sm">
            {/* Group band: makes explicit that the verdict, the FMCSA SMS
                safety percentiles, and regulatory standing are three different
                lenses, they answer different questions and can legitimately
                disagree (e.g. a chameleon shell with clean inspection scores). */}
            <tr className="text-[10px] tracking-wide text-ink-500">
              <th colSpan={2} className="whitespace-nowrap px-3 pt-2 pb-1 text-left font-semibold text-[#0F5A41]">
                Carrier
              </th>
              <th
                colSpan={2}
                className="whitespace-nowrap border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-[#596560]"
                title="Headline risk score plus the estimated FMCSA ISS-CSA on-road inspection priority."
              >
                Headline scores
              </th>
              <th
                colSpan={7}
                className="whitespace-nowrap border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-[#E89432]"
                title="FMCSA Safety Measurement System, all 7 BASICs, peer-ranked within the carrier's fleet-size group. Higher percentile = worse than more peers. CI* (crash) and HM* (hazmat) are our estimates; FMCSA doesn't publish them."
              >
                On-road safety, 7 BASICs, peer-ranked
              </th>
              <th
                colSpan={3}
                className="whitespace-nowrap border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-[#D7453C]"
                title="Risk standing, regulatory, authority, insurance, and identity signals that may not show up in safety percentiles but affect whether the carrier can safely take the load."
              >
                Risk standing
              </th>
            </tr>
            <tr>
              <th className="px-3 py-2 align-bottom">#</th>
              <th className="px-3 py-2 align-bottom">Carrier</th>
              <th
                className="border-l border-ink-200 whitespace-nowrap px-2 py-2 text-center align-bottom text-[#E89432]"
                title="ISS-CSA Inspection Selection System score (1–100). Higher = FMCSA recommends inspection. ≥75 Inspect · 50–74 Optional · &lt;50 Pass."
              >
                ISS
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  on-road
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom text-[#D7453C]"
                title="Carrier risk score (0–100, higher = worse), additive safety, authority/insurance, identity/chameleon, operations, and context factors. A heuristic index, not a probability."
              >
                Risk
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">risk</span>
              </th>
              <th
                className="border-l border-ink-200 whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Crashes per million miles, raw crash count over 24 months ÷ annual VMT × 2 ÷ 1,000,000. CI* = our estimated FMCSA Crash Indicator percentile (peer-ranked) where available; see note below the table."
              >
                Crash
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  %ile* · ÷ mi
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Unsafe Driving, FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Small number = violation rate per driver inspection."
              >
                Unsafe
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="HOS Compliance, FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Small number = violation rate per driver inspection."
              >
                HOS
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Driver Fitness, FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Falls back to driver OOS rate when the carrier isn't data-sufficient for a percentile."
              >
                Fitness
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Controlled Substances / Alcohol, FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Sparse, '—' unless the carrier has enough relevant inspections."
              >
                Ctrl. subs.
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Vehicle Maintenance, FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Falls back to vehicle OOS rate when the carrier isn't data-sufficient for a percentile."
              >
                Vehicle
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Hazmat Compliance, HM* = our estimated FMCSA percentile (FMCSA doesn't publish it); see note below the table. Falls back to hazmat OOS rate when not data-sufficient. Hazmat OOS feeds the ISS estimate."
              >
                Hazmat
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  HM* %ile
                </span>
              </th>
              <th
                className="border-l border-ink-200 whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="Most recent involuntary revocation date, or chronic-revocation count"
              >
                Revocations
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">recent / chronic</span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="FMCSA operating authority status"
              >
                Authority
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">active?</span>
              </th>
              <th
                className="whitespace-nowrap px-2 py-2 text-center align-bottom"
                title="BIPD insurance on file vs required"
              >
                Insurance
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">BIPD on file</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r, i) => {
              const { safety, risk } = splitSignals(r);
              const hasDetail =
                safety.length > 0 || risk.length > 0 || r.siblingDot != null;
              const open = hasDetail && expandedDots.has(r.dot);
              // Section divider whenever the tier changes (rows are tier-sorted).
              const startsTier =
                i === 0 || visibleRows[i - 1].riskLevel !== r.riskLevel;
              const n = tierCount(r.riskLevel);
              return (
              <Fragment key={r.dot}>
              {startsTier && (
                <tr>
                  <td colSpan={14} className="border-t border-ink-200 px-3 pb-1.5 pt-2.5 text-[12px] font-semibold uppercase tracking-wider">
                    <span className="inline-flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${tierDot[r.riskLevel]}`} />
                      <span className={tierText[r.riskLevel]}>{verdictLabel[r.riskLevel]}</span>
                      <span className="font-normal normal-case tracking-normal text-ink-400">
                        · {n} carrier{n === 1 ? "" : "s"}
                      </span>
                    </span>
                  </td>
                </tr>
              )}
              <tr
                className={`border-t border-ink-100 align-top ${rowTint[r.riskLevel]} ${
                  hasDetail ? "cursor-pointer hover:brightness-[0.985]" : ""
                }`}
                onClick={hasDetail ? () => toggleExpanded(r.dot) : undefined}
              >
                <td className="px-3 py-2 text-ink-500">{r.rank}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1.5">
                    {hasDetail && (
                      <svg
                        viewBox="0 0 10 10"
                        aria-hidden="true"
                        className={`h-2.5 w-2.5 shrink-0 text-ink-400 transition-transform ${
                          open ? "rotate-90" : ""
                        }`}
                      >
                        <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                    <span className="font-medium text-ink-900">
                      {r.carrierName ?? <span className="text-ink-400">unknown</span>}
                    </span>
                  </div>
                  <div className={`mt-0.5 text-[11px] text-ink-500 ${hasDetail ? "pl-4" : ""}`}>
                    DOT {r.dot} · {r.peerGroupLabel}
                    {r.loadCount > 0 && ` · ${r.loadCount} load${r.loadCount === 1 ? "" : "s"}`}
                  </div>
                </td>
                <Cell cell={issCellOf(r)} className="border-l border-ink-200" />
                <Cell cell={riskCellOf(r)} />
                <Cell cell={r.axes.crash} className="border-l border-ink-200" quiet />
                <Cell cell={r.axes.unsafeDriving} quiet />
                <Cell cell={r.axes.hos} quiet />
                <Cell cell={r.axes.driverOos} quiet />
                <Cell cell={r.axes.controlledSubstances} quiet />
                <Cell cell={r.axes.vehicleOos} quiet />
                <Cell cell={r.axes.hazmatOos} quiet />
                <Cell cell={r.axes.revocations} className="border-l border-ink-200" />
                <Cell cell={r.axes.authority} />
                <Cell cell={r.axes.insurance} />
              </tr>
              {open && (() => {
                // Always renders (never null) so the two columns stay put:
                // On-road safety on the LEFT, Carrier risk on the RIGHT, even
                // when one side has no flags. Each factor is a two-line row —
                // a fixed-width points badge, then a bold label (+ small
                // category tag) over a muted detail line — so the contributions
                // read as a tidy list instead of a run-on sentence.
                const renderGroup = (
                  title: string,
                  items: Signal[],
                  dot: string,
                  extra?: React.ReactNode
                ) => (
                  <div>
                    <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                      <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
                      {title}
                    </div>
                    {items.length > 0 ? (
                      <ul className="mt-1.5 space-y-1.5 text-xs">
                        {items.map((s, i) => (
                          <li key={i} className="flex gap-2">
                            {s.points != null ? (
                              // Scored factor (Carrier-risk side): points badge.
                              <span className="mt-px inline-flex h-[18px] min-w-[34px] shrink-0 items-center justify-center rounded bg-white/70 text-[10px] font-semibold tabular-nums text-ink-700">
                                +{s.points}
                              </span>
                            ) : (
                              // Descriptive finding (On-road safety side): these
                              // aren't scored individually (they roll up into the
                              // "Hard safety signal" factor on the risk side), so
                              // a quiet bullet instead of an empty score box.
                              <span
                                aria-hidden
                                className="mt-[7px] inline-block h-1 w-1 shrink-0 rounded-full bg-ink-300"
                              />
                            )}
                            <div className="leading-snug">
                              <div>
                                <strong className="font-semibold text-ink-900">{s.label}</strong>
                                {s.category ? (
                                  <span className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-400">
                                    {s.category}
                                  </span>
                                ) : null}
                              </div>
                              {s.detail ? <div className="text-ink-600">{s.detail}</div> : null}
                            </div>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-1.5 text-xs text-ink-400">None noted.</p>
                    )}
                    {extra}
                  </div>
                );
                // When a shared-fleet sibling was named, show what it is. A
                // REVOKED/inactive sibling whose fleet now runs here is the
                // chameleon-successor tell, so its status takes priority over its
                // tier; an active sibling shows its own Augie verdict.
                // The overlap line for the fleet-sharing factors above: names the
                // largest shared-fleet sibling and its status as bold/colored
                // inline text (not a pill), so the "Equipment spread" / "Linked
                // authority" factors don't need to restate the overlap and there's
                // no duplicate status pill.
                const siblingStatusText =
                  r.siblingStatus === "revoked"
                    ? `Revoked${r.siblingRevokedDate ? ` ${r.siblingRevokedDate}` : ""}`
                    : r.siblingStatus === "inactive"
                      ? "Inactive"
                      : r.siblingTier
                        ? verdictLabel[r.siblingTier]
                        : "not scored";
                const siblingToneClass =
                  r.siblingStatus === "revoked" || r.siblingTier === "Critical"
                    ? "text-red-700"
                    : r.siblingTier === "High"
                      ? "text-orange-700"
                      : r.siblingTier === "Medium"
                        ? "text-amber-700"
                        : "text-ink-500";
                const siblingNote =
                  r.siblingDot != null ? (
                    <div className="mt-2 text-[11px] text-ink-600">
                      Largest fleet overlap:{" "}
                      <span className="font-medium text-ink-800">
                        {r.siblingName ?? "carrier"}
                      </span>{" "}
                      (DOT {r.siblingDot}) ·{" "}
                      <span className={`font-semibold ${siblingToneClass}`}>
                        {siblingStatusText}
                      </span>
                    </div>
                  ) : null;
                return (
                  <tr className={`${rowTint[r.riskLevel]}`}>
                    <td
                      className={`border-b border-ink-100 border-l-[3px] ${barColor[r.riskLevel]}`}
                    ></td>
                    <td
                      colSpan={13}
                      className="border-b border-ink-100 px-3 pb-3 pt-1"
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        {renderGroup("On-road safety", safety, "bg-orange-400")}
                        {renderGroup(
                          risk.length && r.riskScore > 0
                            ? `Carrier risk · ${r.riskScore}`
                            : "Carrier risk",
                          risk,
                          "bg-red-400",
                          siblingNote
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })()}
              </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-ink-500">
        <span className="font-medium text-ink-600">ISS*</span>, Estimated FMCSA
        Inspection Selection System score (1–100) and tier (Inspect / Optional /
        Pass). FMCSA does not publish ISS; this is our reproduction of the public
        ISS-CSA algorithm from FMCSA BASIC percentiles and investigation history,
        so treat it as an estimate. ISS is also one input into the carrier risk
        score when it reaches Optional or Inspect.{" "}
        <span className="font-medium text-ink-600">CI*</span> (Crash, percentile
        on top with crashes-per-million-miles below) and{" "}
        <span className="font-medium text-ink-600">HM*</span> (Hazmat) are our
        estimated percentiles for the two BASICs FMCSA doesn&apos;t publish; shown
        where the carrier is data-sufficient.
      </p>
      {gateActive && hiddenCount > 0 && result && (
        <FullReportCta
          hiddenCount={hiddenCount}
          totalRows={allRows.length}
          result={result}
          onUnlock={() => setUnlocked(true)}
        />
      )}
    </div>
  );
}

function FullReportCta({
  hiddenCount,
  totalRows,
  result,
  onUnlock,
}: {
  hiddenCount: number;
  totalRows: number;
  result: AuditResult;
  onUnlock: () => void;
}) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          summary: {
            totalLoads: result.totalLoads,
            totalCarriers: result.totalCarriers,
            flaggedCarriers: result.flaggedCarriers,
            bySeverity: result.bySeverity,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Couldn't capture your email. Try again?");
        return;
      }
      // Trigger CSV download client-side
      const csv = toCsv(result);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const today = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `carrier-audit-${today}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      onUnlock();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-5 rounded-lg border border-ink-200 bg-[#f5f1ea] p-5">
      <p className="text-base font-semibold text-ink-900">Download the full report</p>
      <p className="mt-1 text-sm text-ink-700">
        Get a comprehensive CSV with all {totalRows} carriers fully analyzed.
      </p>
      <form
        onSubmit={submit}
        className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center"
      >
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Enter your work email"
          className="flex-1 rounded-md border border-ink-200 bg-white px-3 py-2 text-sm text-ink-900 placeholder:text-ink-400 focus:border-augment-500 focus:outline-none focus:ring-1 focus:ring-augment-500"
        />
        <button
          type="submit"
          disabled={loading || !email}
          className="rounded-md border border-ink-900 bg-white px-4 py-2 text-sm font-medium text-ink-900 transition-colors hover:bg-ink-50 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {loading ? "Preparing…" : "Download the CSV"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      <p className="mt-3 text-xs text-ink-500">
        By continuing, you agree to our{" "}
        <a
          href="https://www.goaugment.com/privacy"
          target="_blank"
          rel="noreferrer"
          className="underline decoration-ink-300 underline-offset-2 hover:decoration-ink-700"
        >
          Privacy Policy
        </a>
        , and to receive marketing communications from us.
      </p>
    </div>
  );
}
