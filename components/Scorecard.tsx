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

/** Estimated FMCSA ISS badge — context, colored by tier. */
const issTierStyle: Record<string, string> = {
  Inspect: "border-orange-300 bg-orange-50 text-orange-800",
  Optional: "border-amber-300 bg-amber-50 text-amber-800",
  Pass: "border-augment-200 bg-augment-50 text-augment-700",
};
function IssBadge({ score, tier }: { score: number | null; tier: string | null }) {
  if (score == null || tier == null) return null;
  return (
    <span
      className={`mt-1 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${issTierStyle[tier] ?? issTierStyle.Pass}`}
      title="Estimated FMCSA Inspection Selection System score (reproduced from public BASIC/investigation data — FMCSA does not publish ISS). See note below the table."
    >
      ISS* {score} · {tier}
    </span>
  );
}

// NB: the Augie Safety Score is still computed (CarrierRow.safetyScore / CSV) but
// no longer badged — ISS is the safety lens, the Risk score is the differentiator.
// The badge was a third, overlapping safety number; dropped for clarity.

/** Augie Risk Score badge — always shown (paired with ISS as the two-axis read),
 *  colored by tier; contributing factors listed inline below the score. */
const riskTierStyle: Record<string, string> = {
  High: "border-red-400 bg-red-100 text-red-900 font-semibold",
  Moderate: "border-orange-300 bg-orange-50 text-orange-800",
  Low: "border-amber-300 bg-amber-50 text-amber-800",
  None: "border-augment-200 bg-augment-50 text-augment-700",
};
function RiskBadge({
  score,
  tier,
  factors,
}: {
  score: number;
  tier: string;
  factors: string[];
}) {
  const body =
    factors.length > 0
      ? `\n\nFactors:\n• ${factors.join("\n• ")}`
      : "\n\nNo identity / financial-distress / location signals detected.";
  return (
    <span
      className={`mt-1 inline-flex rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${riskTierStyle[tier] ?? riskTierStyle.None}`}
      title={`Augie Risk Score (0-100, higher = worse): a composite of identity/deception, financial-distress, tenure, and location signals, weighted by measured lift on future authority loss. A heuristic index, not a probability. FMCSA has no equivalent.${body}`}
    >
      Risk {score} · {tier}
    </span>
  );
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
  const [showClean, setShowClean] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const allFlagged = rows.filter((r) => r.riskLevel !== "Low");
  const allRows = showClean ? rows : allFlagged;
  const cleanCount = rows.filter((r) => r.riskLevel === "Low").length;
  const gateActive = !isLocalDev() && allRows.length > PREVIEW_ROWS && !unlocked;
  const visibleRows = gateActive ? allRows.slice(0, PREVIEW_ROWS) : allRows;
  const hiddenCount = allRows.length - visibleRows.length;
  return (
    <div className="mt-6">
      {cleanCount > 0 && (
        <div className="mb-3 flex items-center justify-between text-sm">
          <span className="text-ink-600">
            {visibleRows.length} of {rows.length} carriers shown
            {!showClean && cleanCount > 0
              ? ` · ${cleanCount} clean carriers hidden`
              : ""}
          </span>
          <button
            type="button"
            onClick={() => setShowClean((v) => !v)}
            className="text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
          >
            {showClean ? "Hide clean carriers" : `Show all ${rows.length} carriers`}
          </button>
        </div>
      )}
      <ReadingNote />

      <div className="rounded-lg border border-ink-200 bg-white">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-ink-50 text-[11px] uppercase tracking-wide text-ink-600 shadow-sm">
            {/* Group band: makes explicit that the verdict, the FMCSA SMS
                safety percentiles, and regulatory standing are three different
                lenses — they answer different questions and can legitimately
                disagree (e.g. a chameleon shell with clean inspection scores). */}
            <tr className="text-[10px] tracking-wide text-ink-500">
              <th colSpan={3} className="px-3 pt-2 pb-1 text-left font-semibold">
                Augie verdict
              </th>
              <th
                colSpan={7}
                className="border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold text-augment-700"
                title="FMCSA Safety Measurement System — all 7 BASICs, peer-ranked within the carrier's fleet-size group. Higher percentile = worse than more peers. CI* (crash) and HM* (hazmat) are our estimates; FMCSA doesn't publish them."
              >
                FMCSA SMS — on-road safety (all 7 BASICs, peer-ranked)
              </th>
              <th colSpan={3} className="border-l border-ink-200 px-2 pt-2 pb-1 text-center font-semibold">
                Regulatory standing
              </th>
            </tr>
            <tr>
              <th className="px-3 py-2 align-bottom">#</th>
              <th className="px-3 py-2 align-bottom">Risk</th>
              <th className="px-3 py-2 align-bottom">Carrier</th>
              <th
                className="border-l border-ink-200 px-2 py-2 text-center align-bottom"
                title="Crashes per million miles — raw crash count over 24 months ÷ annual VMT × 2 ÷ 1,000,000. CI* = our estimated FMCSA Crash Indicator percentile (peer-ranked) where available; see note below the table."
              >
                Crash
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  %ile* · ÷ mi
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Unsafe Driving — FMCSA SMS percentile (peer-ranked; ⚠ = at/above FMCSA's intervention threshold). Small number = violation rate per driver inspection."
              >
                Unsafe driving
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="HOS Compliance — FMCSA SMS percentile (peer-ranked; ⚠ = at/above FMCSA's intervention threshold). Small number = violation rate per driver inspection."
              >
                HOS
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Driver Fitness — FMCSA SMS percentile (peer-ranked; ⚠ = at/above FMCSA's intervention threshold). Falls back to driver OOS rate when the carrier isn't data-sufficient for a percentile."
              >
                Driver fitness
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Controlled Substances / Alcohol — FMCSA SMS percentile (peer-ranked; ⚠ = at/above FMCSA's intervention threshold). Sparse — '—' unless the carrier has enough relevant inspections."
              >
                Ctrl. subs.
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Vehicle Maintenance — FMCSA SMS percentile (peer-ranked; ⚠ = at/above FMCSA's intervention threshold). Falls back to vehicle OOS rate when the carrier isn't data-sufficient for a percentile."
              >
                Vehicle maint.
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  SMS %ile
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Hazmat Compliance — HM* = our estimated FMCSA percentile (FMCSA doesn't publish it); see note below the table. Falls back to hazmat OOS rate when not data-sufficient. Hazmat OOS feeds the ISS estimate."
              >
                Hazmat
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  HM* %ile
                </span>
              </th>
              <th
                className="border-l border-ink-200 px-2 py-2 text-center align-bottom"
                title="Most recent involuntary revocation date, or chronic-revocation count"
              >
                Revocations
                <br />
                <span className="text-[10px] normal-case text-ink-500">recent / chronic</span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="FMCSA operating authority status"
              >
                Authority
                <br />
                <span className="text-[10px] normal-case text-ink-500">active?</span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="BIPD insurance on file vs required"
              >
                Insurance
                <br />
                <span className="text-[10px] normal-case text-ink-500">BIPD on file</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <Fragment key={r.dot}>
              <tr
                className={`border-t border-ink-100 align-top ${rowTint[r.riskLevel]}`}
              >
                <td className="px-3 py-2 text-ink-500">{r.rank}</td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${riskStyles[r.riskLevel]}`}
                  >
                    {r.riskLevel}
                  </span>
                </td>
                <td className="px-3 py-2">
                  <div className="font-medium text-ink-900">
                    {r.carrierName ?? <span className="text-ink-400">unknown</span>}
                  </div>
                  <div className="mt-0.5 text-[11px] text-ink-500">
                    DOT {r.dot} · {r.peerGroupLabel}
                    {r.loadCount > 0 && ` · ${r.loadCount} load${r.loadCount === 1 ? "" : "s"}`}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <RiskBadge score={r.riskScore} tier={r.riskTier} factors={r.riskFactors} />
                    <IssBadge score={r.issScore} tier={r.issTier} />
                  </div>
                </td>
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
              {(() => {
                const { safety, fraud } = splitSignals(r.reasons, r.riskFactors);
                if (safety.length === 0 && fraud.length === 0) return null;
                const renderGroup = (
                  title: string,
                  items: Signal[],
                  dot: string
                ) =>
                  items.length > 0 ? (
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
                    </div>
                  ) : null;
                return (
                  <tr className={`${rowTint[r.riskLevel]}`}>
                    <td className="border-b border-ink-100"></td>
                    <td className="border-b border-ink-100"></td>
                    <td colSpan={11} className="border-b border-ink-100 px-3 pb-3 pt-0">
                      <div className="grid gap-3 sm:grid-cols-2">
                        {renderGroup("On-road safety", safety, "bg-orange-400")}
                        {renderGroup(
                          fraud.length && r.riskScore > 0
                            ? `Fraud / reliability risk · ${r.riskScore}`
                            : "Fraud / reliability risk",
                          fraud,
                          "bg-red-400"
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })()}
              </Fragment>
            ))}
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
