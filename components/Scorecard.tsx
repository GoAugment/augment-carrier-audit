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

// The "Low" tier is shown as "Clean" — for a broker, the bottom tier means
// "nothing flagged," which reads more clearly than "Low".
const verdictLabel: Record<RiskLevel, string> = {
  Critical: "Critical",
  High: "High",
  Medium: "Medium",
  Low: "Clean",
};

// Accent bar on the left of an expanded reasons panel — colored by tier
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
  elevated: "bg-amber-100 text-amber-900",
  /** info = contextual signal (e.g. old revocations) — amber, lighter than elevated.
   *  Does NOT contribute to overall risk tier; just surfaces in the cell. */
  info: "bg-amber-50 text-amber-800",
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
        Cell color = the carrier&apos;s risk on this axis:{" "}
        <span className="rounded bg-augment-50 px-1 text-augment-800">clean</span>{" "}
        <span className="rounded bg-amber-100 px-1 text-amber-900">info</span>{" "}
        <span className="rounded bg-orange-100 px-1 text-orange-900">elevated</span>{" "}
        <span className="rounded bg-red-100 px-1 text-red-900">severe (≥P95 vs peers)</span>{" "}
        <span className="rounded bg-red-200 px-1 text-red-950 font-semibold">critical</span>
        . We flag carriers only on the last 24 months of activity. Hover any cell for details.{" "}
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
            <span className="font-semibold text-ink-700">Info-only context</span> doesn&apos;t flag —
            old Satisfactory ratings (&gt;10y), historical revocations with no recent activity,
            and BIPD insurance below the $1M industry floor but at FMCSA-required levels are
            surfaced in the tooltip but do not contribute to the carrier&apos;s tier.
          </p>
        </div>
      )}
    </div>
  );
}

function Cell({ cell, className = "" }: { cell: AxisCell; className?: string }) {
  return (
    <td
      className={`px-2 py-2 text-center text-xs tabular-nums ${className} ${cellStyles[cell.status]}`}
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
// as the BASIC axes), not pills — they're two more lenses, so they read like the
// rest of the row. Each maps its tier to a Cell status so the color scale stays
// consistent (red = worst → green = clean).

/** Augie Fraud Score → AxisCell (the lead column of the fraud / reliability
 *  group). Just the number, color-banded by score severity (the tier word lives
 *  in the hover detail, not the cell). */
function riskCellOf(r: CarrierRow): AxisCell {
  // Score-banded color (matches the design): ≥85 severe(red), 60–84 high(orange),
  // 30–59 elevated(amber), <30 clean(green).
  const status: AxisStatus =
    r.riskScore >= 85
      ? "severe"
      : r.riskScore >= 60
        ? "high"
        : r.riskScore >= 30
          ? "elevated"
          : "clean";
  const factorBody =
    r.riskFactors.length > 0
      ? `\n\nFactors:\n• ${r.riskFactors.join("\n• ")}`
      : "\n\nNo identity / financial-distress / location signals detected.";
  return {
    status,
    display: String(r.riskScore),
    detail: `Augie Fraud Score (0-100, higher = worse) — tier ${r.riskTier}: a composite of identity/deception, financial-distress, tenure, and location signals, weighted by measured lift on future authority loss. A heuristic index, not a probability. FMCSA has no equivalent.${factorBody}`,
  };
}

// NB: the Augie Safety Score is still computed (CarrierRow.safetyScore / CSV) but
// not shown as its own column — ISS is the safety lens, the Risk score is the
// differentiator. A third overlapping safety number was dropped for clarity.

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
      "Estimated FMCSA Inspection Selection System score (1-100, higher = FMCSA more likely to inspect). Reproduced from public BASIC/investigation data — FMCSA does not publish ISS. See note below the table.",
  };
}

// Split a carrier's signals into the two buckets we show inline: on-road SAFETY
// (crash + the SMS BASICs + FAST-Act + serious violations + ISS) vs FRAUD /
// reliability risk (insurance, revocation, chameleon, enforcement, + the
// insurer/ZIP/tenure risk-score markers that have no axis cell of their own).
const SAFETY_RE =
  /crash|unsafe driving|hos compliance|driver oos|vehicle oos|hazmat|fast.?act|acute|serious viol|iss —|multiple basic|safety rating/i;
// Risk-score markers to surface as fraud-side reasons (they live only in the
// risk factors — no rule/axis pushes them as a reason).
const RISK_MARKER_RE =
  /^(high-risk insurer|high-shutdown zip|very new authority|new authority|limited tenure|phantom fleet)/i;

type Signal = { label: string; detail: string };
function splitSignals(reasons: Signal[], riskFactors: string[]): {
  safety: Signal[];
  fraud: Signal[];
} {
  const safety: Signal[] = [];
  const fraud: Signal[] = [];
  for (const r of reasons) (SAFETY_RE.test(r.label) ? safety : fraud).push(r);
  const seen = new Set(fraud.map((f) => f.label.toLowerCase()));
  for (const f of riskFactors) {
    if (!RISK_MARKER_RE.test(f)) continue;
    const [label, ...rest] = f.split(" — ");
    if (seen.has(label.toLowerCase())) continue;
    fraud.push({ label, detail: rest.join(" — ") });
  }
  return { safety, fraud };
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
                lenses — they answer different questions and can legitimately
                disagree (e.g. a chameleon shell with clean inspection scores). */}
            <tr className="text-[10px] tracking-wide text-ink-500">
              <th colSpan={2} className="whitespace-nowrap px-3 pt-2 pb-1 text-left font-semibold text-[#0F5A41]">
                Carrier
              </th>
              <th
                colSpan={2}
                className="whitespace-nowrap border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-[#596560]"
                title="The two Augie headline scores: estimated FMCSA ISS-CSA on-road inspection priority, and the Augie fraud / reliability risk index."
              >
                Headline scores
              </th>
              <th
                colSpan={7}
                className="whitespace-nowrap border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-[#E89432]"
                title="FMCSA Safety Measurement System — all 7 BASICs, peer-ranked within the carrier's fleet-size group. Higher percentile = worse than more peers. CI* (crash) and HM* (hazmat) are our estimates; FMCSA doesn't publish them."
              >
                On-road safety — 7 BASICs, peer-ranked
              </th>
              <th
                colSpan={3}
                className="whitespace-nowrap border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-[#D7453C]"
                title="Fraud / reliability standing — the regulatory signals (revocations, operating authority, insurance) that don't show up in the safety percentiles but speak to whether the carrier is who it claims and will still be operating when the load runs."
              >
                Fraud / reliability — standing
              </th>
            </tr>
            <tr>
              <th className="px-3 py-2 align-bottom">#</th>
              <th className="px-3 py-2 align-bottom">Carrier</th>
              <th
                className="border-l border-ink-200 px-2 py-2 text-center align-bottom text-[#E89432]"
                title="ISS-CSA Inspection Selection System score (1–100). Higher = FMCSA recommends inspection. ≥75 Inspect · 50–74 Optional · &lt;50 Pass."
              >
                ISS
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  on-road
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom text-[#D7453C]"
                title="Augie fraud score (0–100, higher = worse) — additive identity/deception, financial-distress, tenure & location index calibrated to revocation lift (not a probability)."
              >
                Fraud
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">risk</span>
              </th>
              <th
                className="border-l border-ink-200 px-2 py-2 text-center align-bottom"
                title="Crashes per million miles — raw crash count over 24 months ÷ annual VMT × 2 ÷ 1,000,000. CI* = our estimated FMCSA Crash Indicator percentile (peer-ranked) where available; see note below the table."
              >
                Crash
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  %ile* · ÷ mi
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Unsafe Driving — FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Small number = violation rate per driver inspection."
              >
                Unsafe driving
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="HOS Compliance — FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Small number = violation rate per driver inspection."
              >
                HOS
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Driver Fitness — FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Falls back to driver OOS rate when the carrier isn't data-sufficient for a percentile."
              >
                Driver fitness
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Controlled Substances / Alcohol — FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Sparse — '—' unless the carrier has enough relevant inspections."
              >
                Ctrl. subs.
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Vehicle Maintenance — FMCSA SMS percentile (peer-ranked; cell color flags at/above FMCSA's intervention threshold). Falls back to vehicle OOS rate when the carrier isn't data-sufficient for a percentile."
              >
                Vehicle maint.
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Hazmat Compliance — HM* = our estimated FMCSA percentile (FMCSA doesn't publish it); see note below the table. Falls back to hazmat OOS rate when not data-sufficient. Hazmat OOS feeds the ISS estimate."
              >
                Hazmat
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">
                  HM* %ile
                </span>
              </th>
              <th
                className="border-l border-ink-200 px-2 py-2 text-center align-bottom"
                title="Most recent involuntary revocation date, or chronic-revocation count"
              >
                Revocations
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">recent / chronic</span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="FMCSA operating authority status"
              >
                Authority
                <br />
                <span className="text-[10px] font-normal normal-case text-[#7D8883]">active?</span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
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
              const { safety, fraud } = splitSignals(r.reasons, r.riskFactors);
              const hasDetail =
                safety.length > 0 || fraud.length > 0 || r.siblingDot != null;
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
                <Cell cell={r.axes.crash} className="border-l border-ink-200" />
                <Cell cell={r.axes.unsafeDriving} />
                <Cell cell={r.axes.hos} />
                <Cell cell={r.axes.driverOos} />
                <Cell cell={r.axes.controlledSubstances} />
                <Cell cell={r.axes.vehicleOos} />
                <Cell cell={r.axes.hazmatOos} />
                <Cell cell={r.axes.revocations} className="border-l border-ink-200" />
                <Cell cell={r.axes.authority} />
                <Cell cell={r.axes.insurance} />
              </tr>
              {open && (() => {
                const renderGroup = (
                  title: string,
                  items: Signal[],
                  dot: string,
                  extra?: React.ReactNode
                ) =>
                  items.length > 0 || extra ? (
                    <div>
                      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wide text-ink-500">
                        <span className={`inline-block h-1.5 w-1.5 rounded-full ${dot}`} />
                        {title}
                      </div>
                      <ul className="mt-1 space-y-1.5 text-xs text-ink-700">
                        {items.map((s, i) => (
                          <li key={i}>
                            <strong className="font-semibold text-ink-900">{s.label}</strong>
                            {s.detail ? <span> {s.detail}</span> : null}
                          </li>
                        ))}
                      </ul>
                      {extra}
                    </div>
                  ) : null;
                // When a shared-fleet sibling was named, show what it is. A
                // REVOKED/inactive sibling whose fleet now runs here is the
                // chameleon-successor tell, so its status takes priority over its
                // tier; an active sibling shows its own Augie verdict.
                const siblingNote =
                  r.siblingDot != null ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-600">
                      <span>
                        Linked authority
                        {r.siblingName ? ` ${r.siblingName}` : ""} (DOT {r.siblingDot}):
                      </span>
                      {r.siblingStatus === "revoked" ? (
                        <span className="inline-flex rounded border border-red-400 bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-900">
                          Revoked{r.siblingRevokedDate ? ` ${r.siblingRevokedDate}` : ""}
                        </span>
                      ) : r.siblingStatus === "inactive" ? (
                        <span className="inline-flex rounded border border-ink-300 bg-ink-100 px-1.5 py-0.5 text-[10px] font-medium text-ink-700">
                          Inactive
                        </span>
                      ) : r.siblingTier ? (
                        <span
                          className={`inline-flex rounded border px-1.5 py-0.5 text-[10px] font-medium ${riskStyles[r.siblingTier]}`}
                        >
                          {verdictLabel[r.siblingTier]}
                        </span>
                      ) : (
                        <span className="text-ink-400">not scored</span>
                      )}
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
                          fraud.length && r.riskScore > 0
                            ? `Fraud / reliability risk · ${r.riskScore}`
                            : "Fraud / reliability risk",
                          fraud,
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
        <span className="font-medium text-ink-600">ISS*</span> — Estimated FMCSA
        Inspection Selection System score (1–100) and tier (Inspect / Optional /
        Pass). FMCSA does not publish ISS; this is our reproduction of the public
        ISS-CSA algorithm from FMCSA BASIC percentiles and investigation history,
        so treat it as an estimate. It&apos;s context only — it does not drive the
        carrier&apos;s risk rating.{" "}
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
