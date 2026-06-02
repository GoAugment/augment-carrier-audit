"use client";
import type { AxisCell, AxisStatus, CarrierRow, RiskLevel } from "@/lib/analyzer";
import laneLiability from "@/lib/data/lane-liability.json";

// Digestible single-carrier view — the "email-style" layout for one DOT/MC,
// driven by the SAME analyze() CarrierRow the website Scorecard uses, so the
// two scores and all 7 BASIC axes match the website exactly. Used by the
// /check/{dot} page (bookmarklet / extension target).

const verdictLabel: Record<RiskLevel, string> = {
  Critical: "Critical",
  High: "High",
  Medium: "Medium",
  Low: "Clean",
};
// Four-hue verdict palette, matching the website.
const tierBg: Record<RiskLevel, string> = {
  Critical: "bg-red-200 text-red-950",
  High: "bg-orange-100 text-orange-900",
  Medium: "bg-amber-100/70 text-amber-900",
  Low: "bg-augment-50 text-augment-800",
};
const tierBar: Record<RiskLevel, string> = {
  Critical: "bg-[#D7453C]",
  High: "bg-[#E89432]",
  Medium: "bg-amber-400",
  Low: "bg-[#2EB873]",
};
// On-road BASIC cells use the website's quiet orange-heat scale (never red/amber).
const basicCellStyles: Record<AxisStatus, string> = {
  critical: "bg-orange-200 text-orange-950 font-semibold",
  severe: "bg-orange-100 text-orange-900",
  high: "bg-orange-100 text-orange-900",
  elevated: "text-ink-700",
  info: "text-ink-500",
  clean: "bg-augment-50 text-augment-800",
  na: "bg-ink-50 text-ink-400",
};

// The 7 FMCSA BASICs, same set + order as the website matrix.
const AXES: { key: keyof CarrierRow["axes"]; label: string }[] = [
  { key: "crash", label: "Crash" },
  { key: "unsafeDriving", label: "Unsafe Driving" },
  { key: "hos", label: "HOS" },
  { key: "driverOos", label: "Driver Fitness" },
  { key: "controlledSubstances", label: "Controlled Subs" },
  { key: "vehicleOos", label: "Vehicle Maint" },
  { key: "hazmatOos", label: "Hazmat" },
];

// ISS tile colored by its standing (Inspect/Optional/Pass), matching the site.
function issTone(tier: string | null): string {
  if (tier === "Inspect") return "bg-orange-100 text-orange-900";
  if (tier === "Optional") return "bg-amber-100/70 text-amber-900";
  return "bg-augment-50 text-augment-800";
}

// Factor split — mirrors the website panel: scored contributions on the risk
// side; descriptive reasons routed to safety, with the same dedup so a
// reason that restates a scored factor doesn't double up.
const SAFETY_RE =
  /crash|unsafe driving|hos compliance|driver oos|vehicle oos|hazmat|fast.?act|acute|serious viol|iss,|multiple basic|safety rating|sms scores look clean/i;
const PANEL_DUP_RE =
  /^fleet shared with another|^equipment spread across|^all-cancel insurance|^high-risk insurer/i;
type Sig = { label: string; detail: string; points?: number; category?: string };
function splitSignals(r: CarrierRow): { safety: Sig[]; risk: Sig[] } {
  const safety: Sig[] = [];
  const risk: Sig[] = r.riskContributions.map((f) => ({
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
    if (PANEL_DUP_RE.test(reason.label)) continue;
    if (seen.has(reason.label.toLowerCase())) continue;
    risk.push(reason);
  }
  return { safety, risk };
}

function metaLine(r: CarrierRow): string {
  const c = r.carrier;
  const parts: string[] = [`DOT ${r.dot}`];
  if (c.mcNumber) parts.push(/^mc/i.test(c.mcNumber) ? c.mcNumber : `MC-${c.mcNumber}`);
  if (c.physicalState) parts.push(c.physicalState);
  if (c.dotAddDate) {
    const yrs = (Date.now() - new Date(c.dotAddDate).getTime()) / 3.15576e10;
    if (Number.isFinite(yrs) && yrs > 0) parts.push(`authority ${yrs.toFixed(yrs < 10 ? 1 : 0)}y`);
  }
  if (c.totalPowerUnits) parts.push(`${c.totalPowerUnits} PU`);
  return parts.join(" · ");
}

// Lane coverage-fit advisory (same logic as the email evaluator): does BIPD
// cover the lane's injury-liability? Only when a lane is supplied. Advisory.
function laneCoverage(row: CarrierRow, from?: string, to?: string) {
  const tbl = laneLiability as unknown as Record<string, { injury_pct: number; tier: string }>;
  let worst: { st: string; injury_pct: number; tier: string } | null = null;
  for (const raw of [from, to]) {
    const st = raw?.toUpperCase().trim();
    if (!st) continue;
    const r = tbl[st];
    if (r && (!worst || r.injury_pct > worst.injury_pct)) worst = { st, ...r };
  }
  if (!worst) return null;
  const floorK = worst.tier === "high" ? 1500 : 1000;
  const bipd = row.carrier.bipdInsuranceOnFile;
  const fmt = (k: number) => (k >= 1000 ? `$${(k / 1000).toFixed(k % 1000 ? 1 : 0)}M` : `$${k}k`);
  const where = `${worst.st} (${worst.injury_pct}% of crashes there involve an injury, vs 36% nationally)`;
  if (!bipd || bipd <= 0)
    return { ok: false, label: "Verify COI for this lane", detail: `Runs through ${where}. No BIPD amount on file — confirm the certificate carries at least ${fmt(floorK)}.` };
  if (bipd >= floorK)
    return { ok: true, label: "Coverage fits this lane", detail: `${fmt(bipd)} BIPD covers this higher-liability lane (${where}).` };
  return { ok: false, label: "Higher coverage advised for this lane", detail: `Runs through ${where}. Carrier carries ${fmt(bipd)} BIPD; consider requiring ${fmt(floorK)}.` };
}

export function CarrierCard({
  row,
  lane,
}: {
  row: CarrierRow;
  lane?: { from?: string; to?: string };
}) {
  const { safety, risk } = splitSignals(row);
  const v = row.riskLevel;
  const cov = lane ? laneCoverage(row, lane.from, lane.to) : null;

  return (
    <div className="mx-auto max-w-[640px]">
      {/* Header: verdict + identity */}
      <div className={`rounded-t-lg border border-ink-200 border-l-[5px] ${tierBar[v].replace("bg-", "border-l-")} px-5 py-4`}>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ${tierBg[v]}`}>
            {verdictLabel[v]}
          </span>
          <span className="text-[11px] uppercase tracking-wide text-ink-400">carrier risk</span>
        </div>
        <h1 className="mt-2 text-xl font-semibold text-ink-900">
          {row.carrierName ?? <span className="text-ink-400">Unknown carrier</span>}
        </h1>
        <div className="mt-0.5 text-xs text-ink-500">{metaLine(row)}</div>
      </div>

      {/* Two headline scores */}
      <div className="grid grid-cols-2 gap-px border-x border-ink-200 bg-ink-200">
        <div className="bg-white px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">Risk score</div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className={`rounded px-2 py-0.5 text-2xl font-bold tabular-nums ${tierBg[v]}`}>{row.riskScore}</span>
            <span className="text-sm text-ink-600">{verdictLabel[v]}</span>
          </div>
        </div>
        <div className="bg-white px-5 py-3">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-400">
            ISS<span className="align-super text-[8px]">*</span> est. · on-road
          </div>
          <div className="mt-0.5 flex items-baseline gap-2">
            <span className={`rounded px-2 py-0.5 text-2xl font-bold tabular-nums ${issTone(row.issTier)}`}>
              {row.issScore ?? "—"}
            </span>
            <span className="text-sm text-ink-600">{row.issTier ?? "n/a"}</span>
          </div>
        </div>
      </div>

      {/* Lane coverage-fit advisory (only when a lane was supplied) */}
      {cov && (
        <div className="border-x border-ink-200 bg-white px-5 pt-3">
          <div
            className={`rounded border px-3 py-2 text-xs ${
              cov.ok
                ? "border-augment-200 bg-augment-50 text-augment-900"
                : "border-amber-200 bg-amber-50 text-amber-900"
            }`}
          >
            <span className="font-semibold">{cov.ok ? "✓ " : "⚠ "}{cov.label}</span>
            <span className="ml-1 opacity-80">{cov.detail}</span>
          </div>
        </div>
      )}

      {/* Carrier risk factors */}
      <div className="border-x border-ink-200 bg-white px-5 py-4">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          Carrier risk{risk.length && row.riskScore > 0 ? ` · ${row.riskScore}` : ""}
        </div>
        {risk.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {risk.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                {s.points != null ? (
                  <span className="mt-px inline-flex h-[18px] min-w-[34px] shrink-0 items-center justify-center rounded bg-ink-100 text-[10px] font-semibold tabular-nums text-ink-700">
                    +{s.points}
                  </span>
                ) : (
                  <span aria-hidden className="mt-[7px] inline-block h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                )}
                <div className="leading-snug">
                  <div className="text-sm">
                    <strong className="font-semibold text-ink-900">{s.label}</strong>
                    {s.category ? (
                      <span className="ml-1.5 text-[10px] uppercase tracking-wide text-ink-400">{s.category}</span>
                    ) : null}
                  </div>
                  {s.detail ? <div className="text-xs text-ink-600">{s.detail}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-xs text-ink-400">No carrier-risk factors flagged.</p>
        )}
      </div>

      {/* On-road safety findings (descriptive) */}
      {safety.length > 0 && (
        <div className="border-x border-ink-200 bg-white px-5 pb-4">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">On-road safety</div>
          <ul className="mt-2 space-y-1.5">
            {safety.map((s, i) => (
              <li key={i} className="flex gap-2.5">
                <span aria-hidden className="mt-[7px] inline-block h-1 w-1 shrink-0 rounded-full bg-ink-300" />
                <div className="leading-snug">
                  <div className="text-sm font-medium text-ink-800">{s.label}</div>
                  {s.detail ? <div className="text-xs text-ink-600">{s.detail}</div> : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* All 7 FMCSA BASICs — same cells/values as the website */}
      <div className="rounded-b-lg border border-ink-200 bg-white px-5 py-4">
        <div className="text-[10px] font-semibold uppercase tracking-wide text-ink-500">
          FMCSA BASICs · 7 peer-ranked percentiles
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-4">
          {AXES.map(({ key, label }) => {
            const cell: AxisCell = row.axes[key];
            return (
              <div
                key={key}
                title={cell.detail ?? ""}
                className={`rounded px-2 py-1.5 text-center ${basicCellStyles[cell.status]}`}
              >
                <div className="text-[10px] uppercase tracking-wide opacity-70">{label}</div>
                <div className="text-sm font-semibold tabular-nums">{cell.display}</div>
                {cell.sub && <div className="text-[10px] font-normal opacity-60">{cell.sub}</div>}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[10px] leading-relaxed text-ink-400">
          CI<span className="align-super">*</span> (crash) and HM<span className="align-super">*</span> (hazmat) are our
          estimates — FMCSA doesn&apos;t publish them. Percentiles are peer-ranked within the carrier&apos;s fleet-size
          group; higher = worse than more peers. ISS<span className="align-super">*</span> is our reproduction of the
          ISS-CSA algorithm. Last 24 months.
        </p>
      </div>
    </div>
  );
}
