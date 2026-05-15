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

const riskStyles: Record<RiskLevel | "Clean", string> = {
  Critical: "bg-red-200 text-red-950 border-red-400 font-semibold",
  Severe: "bg-red-100 text-red-900 border-red-200",
  High: "bg-orange-100 text-orange-900 border-orange-200",
  Elevated: "bg-amber-50 text-amber-900 border-amber-200",
  Clean: "bg-augment-50 text-augment-900 border-augment-200",
};

const rowTint: Record<RiskLevel | "Clean", string> = {
  Critical: "bg-red-50/80",
  Severe: "bg-red-50/40",
  High: "bg-orange-50/40",
  Elevated: "bg-amber-50/30",
  Clean: "",
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
        Cell color = how the carrier compares to similarly-sized fleets:{" "}
        <span className="rounded bg-augment-50 px-1 text-augment-800">clean</span>{" "}
        <span className="rounded bg-amber-100 px-1 text-amber-900">≥P85</span>{" "}
        <span className="rounded bg-orange-100 px-1 text-orange-900">≥P90</span>{" "}
        <span className="rounded bg-red-100 px-1 text-red-900">≥P95</span>{" "}
        <span className="rounded bg-red-200 px-1 text-red-950 font-semibold">critical</span>
        . Hover any cell for the exact peer cutoff.{" "}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
        >
          {open ? "less" : "more"}
        </button>
      </p>
      {open && (
        <p className="mt-2 text-ink-500">
          OOS and violation rates = <span className="font-mono">violations ÷ inspections of that type</span> over
          24 months. Crash rate = raw crashes ÷ million miles driven. Revocations shows FMCSA
          revocation history; Authority and Insurance are binary checks against FMCSA&apos;s
          current registration record.
        </p>
      )}
    </div>
  );
}

function Cell({ cell }: { cell: AxisCell }) {
  return (
    <td
      className={`px-2 py-2 text-center text-xs tabular-nums ${cellStyles[cell.status]}`}
      title={cell.detail ?? ""}
    >
      {cell.display}
    </td>
  );
}

const PREVIEW_ROWS = 10;

export function Scorecard({
  rows,
  result,
}: {
  rows: CarrierRow[];
  result?: AuditResult;
}) {
  const [showClean, setShowClean] = useState(false);
  const [unlocked, setUnlocked] = useState(false);
  const allFlagged = rows.filter((r) => r.riskLevel !== "Clean");
  const allRows = showClean ? rows : allFlagged;
  const cleanCount = rows.filter((r) => r.riskLevel === "Clean").length;
  const overLimit = allRows.length > PREVIEW_ROWS && !unlocked;
  const visibleRows = overLimit ? allRows.slice(0, PREVIEW_ROWS) : allRows;
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
            <tr>
              <th className="px-3 py-2 align-bottom">#</th>
              <th className="px-3 py-2 align-bottom">Risk</th>
              <th className="px-3 py-2 align-bottom">Carrier</th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Crashes per million miles — raw crash count over 24 months ÷ annual VMT × 2 ÷ 1,000,000"
              >
                Crashes
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  ÷ million miles
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Unsafe Driving — % of driver inspections that found speeding, reckless driving, improper lane changes, inattention, etc."
              >
                Unsafe driving
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  ÷ driver insp
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="HOS Compliance — % of driver inspections that found Hours-of-Service violations"
              >
                HOS
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  ÷ driver insp
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Driver Out-of-Service — % of driver inspections that ended with the driver placed OOS"
              >
                Driver OOS
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  ÷ driver insp
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Vehicle Out-of-Service — % of vehicle inspections that ended with the vehicle placed OOS"
              >
                Vehicle OOS
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  ÷ vehicle insp
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
                title="Hazmat Out-of-Service — % of hazmat-placarded inspections that ended OOS"
              >
                Hazmat OOS
                <br />
                <span className="text-[10px] normal-case text-ink-500">
                  ÷ hazmat insp
                </span>
              </th>
              <th
                className="px-2 py-2 text-center align-bottom"
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
                  {r.hazmatLoadIds.length > 0 && (
                    <div className="mt-1 flex flex-wrap gap-1">
                      <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                        Hazmat
                      </span>
                    </div>
                  )}
                </td>
                <Cell cell={r.axes.crash} />
                <Cell cell={r.axes.unsafeDriving} />
                <Cell cell={r.axes.hos} />
                <Cell cell={r.axes.driverOos} />
                <Cell cell={r.axes.vehicleOos} />
                <Cell cell={r.axes.hazmatOos} />
                <Cell cell={r.axes.revocations} />
                <Cell cell={r.axes.authority} />
                <Cell cell={r.axes.insurance} />
              </tr>
              {r.reasons.length > 0 && (
                <tr className={`${rowTint[r.riskLevel]}`}>
                  <td className="border-b border-ink-100"></td>
                  <td className="border-b border-ink-100"></td>
                  <td colSpan={9} className="border-b border-ink-100 px-3 pb-3 pt-0">
                    <ul className="space-y-1.5 text-xs text-ink-700">
                      {r.reasons.map((reason, i) => (
                        <li key={i}>
                          <strong className="font-semibold text-ink-900">
                            {reason.label}
                          </strong>{" "}
                          <span>{reason.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {hiddenCount > 0 && result && (
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
