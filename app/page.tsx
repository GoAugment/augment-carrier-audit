"use client";
import { useState } from "react";
import { SAMPLE_INPUT } from "@/lib/sample";
import type { AuditResult, RiskLevel } from "@/lib/analyzer";
import { Logo } from "@/components/Logo";
import { Scorecard } from "@/components/Scorecard";

/**
 * The "Check Carrier" bookmarklet, served as a draggable link so a broker can
 * drag it to their bookmarks bar and one-click a carrier safety check on any
 * email / TMS page. It grabs the page (outerHTML + form-field values + any
 * selection) and POSTs to /api/check, which renders the audit in a new tab.
 *
 * Kept verbatim as a string (not a function .toString()) so it isn't subject to
 * build minification, and injected via dangerouslySetInnerHTML because React
 * strips `javascript:` hrefs.
 */
const CHECK_CARRIER_BOOKMARKLET = `javascript:(function(){var B='https://augment-carrier-audit.vercel.app';var sel=(window.getSelection&&String(window.getSelection()))||'';var F=[];document.querySelectorAll('input,textarea,select').forEach(function(el){var ty=(el.type||'').toLowerCase();if(/^(password|hidden|checkbox|radio|file|submit|button)$/.test(ty))return;var v=el.value;if(el.tagName==='SELECT'&&el.selectedIndex>=0&&el.options[el.selectedIndex])v=el.options[el.selectedIndex].text;v=(v==null?'':(''+v)).trim();if(!v)return;var lbl='';if(el.id){var L=document.querySelector('label[for="'+el.id+'"]');if(L)lbl=(L.textContent||'').trim();}if(!lbl)lbl=el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.getAttribute('name')||el.id||'';F.push((lbl?lbl+': ':'')+v);});var fields=F.join('\\n');var html=document.documentElement.outerHTML.replace(/<script[\\s\\S]*?<\\/script>/gi,'').replace(/<style[\\s\\S]*?<\\/style>/gi,'').slice(0,1200000);var f=document.createElement('form');f.method='POST';f.action=B+'/api/check';f.target='_blank';f.acceptCharset='UTF-8';f.style.display='none';function add(n,v){var t=document.createElement('textarea');t.name=n;t.value=v;f.appendChild(t);}add('html',html);add('url',location.href);add('sel',sel);add('fields',fields);document.body.appendChild(f);f.submit();setTimeout(function(){f.remove();},2000);})();`;

const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CHECK_CARRIER_SHIELD =
  '<svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true" style="flex:none;"><path d="M16 4.2l8.6 2.9v6.7c0 5.7-3.6 9.7-8.6 11.4-5-1.7-8.6-5.7-8.6-11.4V7.1L16 4.2z" fill="#ffffff"/><path d="M11.6 16.1l3 3 6-6.4" fill="none" stroke="#2f9742" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/** Draggable bookmarklet link as raw HTML (React would strip the javascript: href). */
const CHECK_CARRIER_DRAG_LINK = `<a href="${escAttr(CHECK_CARRIER_BOOKMARKLET)}" draggable="true" onclick="return false;" title="Drag me to your bookmarks bar" style="display:inline-flex;align-items:center;gap:8px;cursor:grab;text-decoration:none;background:#2f9742;color:#fff;font-weight:600;font-size:14px;padding:10px 16px;border-radius:8px;box-shadow:0 1px 2px rgba(0,0,0,0.08);">${CHECK_CARRIER_SHIELD}Check Carrier</a>`;

/**
 * Sample peer-group cutoffs — statistical axes flag Severe at the 95th
 * percentile of the carrier's peer group. We show one row per axis using
 * the Small (2-50) bucket since that's where most freight tendering happens.
 * The real cutoffs vary by fleet size. Hover any cell in the result table
 * to see the carrier's actual peer cutoff.
 */
const sampleSmallFleetCutoffs = [
  {
    signal: "Crashes per million miles",
    elevated: "≥ 1.46",
    high: "≥ 2.31",
    severe: "≥ 3.66",
  },
  {
    signal: "Unsafe Driving rate",
    elevated: "≥ 33%",
    high: "≥ 34%",
    severe: "≥ 50%",
  },
  {
    signal: "HOS Compliance rate",
    elevated: "≥ 29%",
    high: "≥ 33%",
    severe: "≥ 48%",
  },
  {
    signal: "Driver OOS rate",
    elevated: "≥ 21%",
    high: "≥ 29%",
    severe: "≥ 38%",
  },
  {
    signal: "Vehicle OOS rate",
    elevated: "≥ 50%",
    high: "≥ 60%",
    severe: "≥ 67%",
  },
  {
    signal: "Hazmat OOS rate",
    elevated: "≥ 7%",
    high: "≥ 13%",
    severe: "≥ 25%",
  },
];


export default function Home() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<(AuditResult & { parseErrors?: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runAudit() {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ input }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? "Audit failed.");
      else setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error.");
    } finally {
      setLoading(false);
    }
  }

  function loadSample() {
    setInput(SAMPLE_INPUT.trim());
    setResult(null);
    setError(null);
  }

  return (
    <main className="min-h-screen bg-white">
      {/* Nav */}
      <nav className="border-b border-ink-100">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <a href="https://goaugment.com" target="_blank" rel="noreferrer">
            <Logo />
          </a>
          <a
            href="https://www.goaugment.com/get-a-demo"
            target="_blank"
            rel="noreferrer"
            className="btn-primary"
          >
            Get a demo
          </a>
        </div>
      </nav>

      {/* Hero */}
      <section className="border-b border-ink-100 bg-augment-50">
        <div className="mx-auto max-w-5xl px-6 py-16 sm:py-20">
          <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-augment-200 bg-white px-3 py-1 text-xs font-medium text-augment-700">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-augment-500" />
            Free · No signup · Updated for Montgomery v. Caribe Transport
          </p>
          <h1 className="text-4xl font-semibold tracking-tight text-ink-900 sm:text-5xl">
            Carrier Safety Audit
          </h1>
          <p className="mt-4 max-w-2xl text-lg text-ink-700">
            Paste a list of carrier DOT numbers. We pull live FMCSA safety data, compare
            against industry-standard thresholds, and return a defensible pre-tender risk
            report in seconds.
          </p>
        </div>
      </section>

      {/* Install the one-click bookmarklet */}
      <section className="border-b border-ink-100 bg-white">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="text-xl font-semibold text-ink-900">
            One-click check on any carrier page
          </h2>
          <p className="mt-2 max-w-2xl text-sm text-ink-700">
            Add the <strong>Check Carrier</strong> button to your bookmarks bar. Then on a
            carrier email (Gmail / Outlook) or a TMS load page, click it — it reads the
            page, pulls the DOT/MC, and opens an instant safety check in a new tab.
          </p>

          <div className="mt-6 flex flex-wrap items-center gap-3">
            <span
              dangerouslySetInnerHTML={{ __html: CHECK_CARRIER_DRAG_LINK }}
            />
            <span className="inline-flex items-center gap-1 text-sm text-ink-500">
              <span aria-hidden="true">↑</span> drag me up to your bookmarks bar
            </span>
          </div>

          <ol className="mt-6 grid gap-3 text-sm text-ink-600 sm:grid-cols-3">
            <li>
              <span className="font-semibold text-ink-900">1.</span> Show your bookmarks bar
              {" "}(<kbd className="rounded bg-ink-100 px-1 font-mono text-xs">⌘⇧B</kbd> /{" "}
              <kbd className="rounded bg-ink-100 px-1 font-mono text-xs">Ctrl+Shift+B</kbd>).
            </li>
            <li>
              <span className="font-semibold text-ink-900">2.</span> Drag the green{" "}
              <strong>Check Carrier</strong> button up into it.
            </li>
            <li>
              <span className="font-semibold text-ink-900">3.</span> Open a carrier email or
              load page and click it.
            </li>
          </ol>
          <p className="mt-4 text-xs text-ink-500">
            Tip: on a busy inbox, open the specific email first (or highlight the carrier&apos;s
            block) so the check focuses on that carrier.
          </p>
        </div>
      </section>

      {/* What changed — Montgomery */}
      <section className="border-b border-ink-100">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="text-xl font-semibold text-ink-900">
            Why brokers now need a documented audit trail
          </h2>
          <div className="mt-6 grid gap-6 sm:grid-cols-3">
            <Pillar
              title="The ruling"
              body={
                <>
                  In <em>Montgomery v. Caribe Transport II</em>, 608 U.S. ___ (2026), the Supreme
                  Court unanimously held that the FAAAA&apos;s safety exception preserves state
                  negligent-hiring claims against freight brokers. The pre-emption defense
                  brokers relied on since 2023 is gone.
                </>
              }
            />
            <Pillar
              title="The standard"
              body={
                <>
                  Brokers must exercise <strong>ordinary care</strong> in selecting carriers.
                  In practice: check FMCSA safety data (OOS rates, crash history, authority,
                  insurance) before tendering, document what you saw, and explain any override.
                </>
              }
            />
            <Pillar
              title="The record"
              body={
                <>
                  Every load you tender now needs a documented trail — what safety data you
                  saw, when, and the reasoning for any override. Operationally
                  straightforward; the gap is what creates exposure.
                </>
              }
            />
          </div>
          <p className="mt-6 text-xs text-ink-500">
            Not legal advice.{" "}
            <a
              className="text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
              href="https://www.supremecourt.gov/opinions/"
              target="_blank"
              rel="noreferrer"
            >
              Read the opinion
            </a>
            .
          </p>
        </div>
      </section>

      {/* Input */}
      <section className="border-b border-ink-100">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <div className="flex items-center justify-between">
            <h2 className="text-xl font-semibold text-ink-900">Run an audit</h2>
            <button
              type="button"
              onClick={loadSample}
              className="text-sm text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
            >
              Load sample data
            </button>
          </div>
          <p className="mt-2 text-sm text-ink-600">
            One carrier per line. Format:{" "}
            <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">DOT</code>{" "}
            or{" "}
            <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">DOT, LoadID</code>{" "}
            or{" "}
            <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">
              DOT, LoadID, HAZMAT
            </code>
            . Up to 7,500 loads per submission.
          </p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !loading && input.trim()) {
                e.preventDefault();
                runAudit();
              }
            }}
            rows={10}
            spellCheck={false}
            placeholder={"3621624\n2049859, INF31459-18990\n3168296, L-1007, HAZMAT"}
            className="mt-4 block w-full rounded-md border border-ink-200 bg-white px-3 py-2 font-mono text-sm text-ink-900 shadow-sm focus:border-augment-500 focus:outline-none focus:ring-1 focus:ring-augment-500"
          />
          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              onClick={runAudit}
              disabled={loading || !input.trim()}
              className="btn-primary"
            >
              {loading ? "Auditing…" : "Audit now"}
            </button>
            <span className="text-xs text-ink-400">⌘ + ↵</span>
            <span className="text-xs text-ink-500">
              Anonymous. We don&apos;t store your carrier or load IDs.
            </span>
          </div>
          {error && (
            <div className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
              {error}
            </div>
          )}
        </div>
      </section>

      {/* Result */}
      {result && (
        <section className="border-b border-ink-100 bg-ink-50">
          {/* Results use a wider column than the rest of the page: the 14-column
              matrix needs the room so the carrier meta (DOT · peer group · loads)
              stays on one line and rows stay short and scannable. */}
          <div className="mx-auto max-w-7xl px-6 py-12">
            {result.rows.length > 0 ? (
              <Scorecard rows={result.rows} result={result} />
            ) : (
              <div className="mt-6 rounded-lg border border-augment-200 bg-augment-50 px-4 py-6 text-sm text-augment-900">
                <strong>No carriers flagged.</strong> All {result.totalCarriers} carriers in this
                submission cleared the safety thresholds. Save this report as part of your
                vetting record.
              </div>
            )}

            {result.unresolvedDots.length > 0 && (
              <p className="mt-4 text-xs text-ink-500">
                Could not resolve {result.unresolvedDots.length} DOT
                {result.unresolvedDots.length === 1 ? "" : "s"} in FMCSA:{" "}
                {result.unresolvedDots.slice(0, 8).join(", ")}
                {result.unresolvedDots.length > 8 ? "…" : ""}
              </p>
            )}
            {result.parseErrors && result.parseErrors.length > 0 && (
              <p className="mt-2 text-xs text-ink-500">
                Parse errors: {result.parseErrors.join("; ")}
              </p>
            )}
          </div>
        </section>
      )}

      {/* Upsell */}
      <section className="border-b border-ink-100 bg-augment-700 text-white">
        <div className="mx-auto max-w-5xl px-6 py-14">
          <h2 className="text-2xl font-semibold tracking-tight">
            Want this report every morning — plus the audit trail?
          </h2>
          <p className="mt-3 max-w-2xl text-augment-100">
            Augie — Augment&apos;s AI teammate for supply chain — checks every carrier behind
            the scenes and{" "}
            <strong className="text-white">documents who&apos;s compliant for your records</strong>{" "}
            and who isn&apos;t, so you can fix it before it becomes an issue.
          </p>
          <p className="mt-3 max-w-2xl text-augment-100">
            Augie also handles the rest of the brokerage workflow: carrier selection,
            track-and-trace, POD collection, customer email triage.
          </p>
          <a
            href="https://www.goaugment.com/get-a-demo"
            target="_blank"
            rel="noreferrer"
            className="mt-6 inline-flex items-center justify-center rounded-md bg-white px-4 py-2 text-sm font-semibold text-augment-800 transition-colors hover:bg-augment-50"
          >
            Book a 15-minute demo
          </a>
        </div>
      </section>

      {/* Methodology */}
      <section className="border-b border-ink-100">
        <div className="mx-auto max-w-5xl px-6 py-12">
          <h2 className="text-xl font-semibold text-ink-900">Methodology</h2>

          {/* How scoring works */}
          <div className="mt-6">
            <p className="text-sm font-semibold text-ink-900">How scoring works</p>
            <p className="mt-2 text-sm text-ink-700">
              Each carrier is scored on <strong>nine axes</strong>, then compared against{" "}
              <strong>peer-group percentiles</strong> from the May 2026 FMCSA snapshot
              (~2 million US carriers). Carriers compete against similarly-sized fleets — a
              10-truck carrier isn&apos;t graded against Schneider. The result table&apos;s
              cell color tells you that axis&apos;s status; hover any cell for the exact peer
              cutoff used.
            </p>
            <ol className="mt-3 list-inside list-decimal space-y-1 text-sm text-ink-700">
              <li>
                <strong>Crashes per million miles</strong> — raw crash count over 24 months ÷
                annual VMT × 2. Industry-standard safety metric.
              </li>
              <li>
                <strong>Unsafe Driving rate</strong> — driver inspections that found any 49
                CFR Part 392 violation (speeding, reckless, distracted, lane changes) ÷ total
                driver inspections.
              </li>
              <li>
                <strong>HOS Compliance rate</strong> — driver inspections with any
                Hours-of-Service violation ÷ total driver inspections.
              </li>
              <li>
                <strong>Driver OOS rate</strong> — driver inspections that ended out-of-service
                ÷ total driver inspections (last 24 months).
              </li>
              <li>
                <strong>Vehicle OOS rate</strong> — same denominator structure, vehicle
                violations.
              </li>
              <li>
                <strong>Hazmat OOS rate</strong> — same, hazmat-placarded inspections only.
              </li>
              <li>
                <strong>Revocations</strong> — flags only an involuntary revocation in the
                last 24 months. Older history is surfaced in the tooltip as context but does
                not contribute to the tier (a carrier whose authority was pulled in 2006
                and has been clean since is not a current risk). Voluntary revocations never
                trigger a flag.
              </li>
              <li>
                <strong>Operating authority</strong> — binary: Active vs. not.
              </li>
              <li>
                <strong>BIPD insurance</strong> — required amount vs. on-file amount.
              </li>
            </ol>
          </div>

          {/* Risk tiers */}
          <div className="mt-8">
            <p className="text-sm font-semibold text-ink-900">Risk tiers</p>
            <p className="mt-2 text-sm text-ink-700">
              The overall tier is the worst per-axis status, with bumps for compound
              signals and the carrier&apos;s risk score. Four tiers: Critical, High,
              Medium, Low.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-600">
                  <tr>
                    <th className="px-3 py-2">Tier</th>
                    <th className="px-3 py-2">Meaning</th>
                    <th className="px-3 py-2">When it fires</th>
                  </tr>
                </thead>
                <tbody className="text-ink-700">
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-red-400 bg-red-200 px-2 py-0.5 text-xs font-semibold text-red-950">
                        Critical
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Refuse to tender</td>
                    <td className="px-3 py-2 align-top">
                      Binary regulatory failure (insurance lapsed / BIPD on file &lt; required,
                      FMCSA rating Unsatisfactory, authority not Active); or worst 5% within
                      peer group on an axis; or recent involuntary revocation with any
                      statistical signal; or a multi-signal chameleon cluster; or a high risk
                      score (≥60).
                    </td>
                  </tr>
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-orange-200 bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900">
                        High
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Needs documented override</td>
                    <td className="px-3 py-2 align-top">
                      Worst 10% within peer group; or recent involuntary revocation (≤24mo);
                      or large enforcement settlement ≥$25k; or crash rate ≥2.0 per million
                      miles (absolute floor); or FAST-Act high-risk; or a moderate risk score
                      (≥30 — e.g. insurance churn + high-risk insurer, or $0 BIPD + new authority).
                    </td>
                  </tr>
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                        Medium
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Operator awareness</td>
                    <td className="px-3 py-2 align-top">
                      Worst 15% within peer group on at least one axis. Not blocking — surface
                      the signal in your audit trail.
                    </td>
                  </tr>
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-augment-200 bg-augment-50 px-2 py-0.5 text-xs font-medium text-augment-900">
                        Low
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Clear to tender</td>
                    <td className="px-3 py-2 align-top">
                      No axis flagged and no regulatory, insurance, or risk-score signal — the
                      clean baseline.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Peer groups */}
          <div className="mt-8">
            <p className="text-sm font-semibold text-ink-900">Peer groups (by power units)</p>
            <p className="mt-2 text-sm text-ink-700">
              Industry-standard fleet-size buckets. Cutoffs differ markedly across groups
              because operational reality differs — mega fleets run safer than owner-ops
              because of scale (dedicated safety teams, pre-trip programs, newer equipment).
            </p>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5 text-xs">
              <div className="rounded border border-ink-200 bg-white px-2 py-1.5 text-center">
                Owner-op<br /><span className="font-mono text-ink-500">1 PU</span>
              </div>
              <div className="rounded border border-ink-200 bg-white px-2 py-1.5 text-center">
                Small<br /><span className="font-mono text-ink-500">2-50 PU</span>
              </div>
              <div className="rounded border border-ink-200 bg-white px-2 py-1.5 text-center">
                Mid<br /><span className="font-mono text-ink-500">51-250 PU</span>
              </div>
              <div className="rounded border border-ink-200 bg-white px-2 py-1.5 text-center">
                Large<br /><span className="font-mono text-ink-500">251-1000 PU</span>
              </div>
              <div className="rounded border border-ink-200 bg-white px-2 py-1.5 text-center">
                Mega<br /><span className="font-mono text-ink-500">1000+ PU</span>
              </div>
            </div>
          </div>

          {/* Sample cutoffs */}
          <div className="mt-8">
            <p className="text-sm font-semibold text-ink-900">
              Sample cutoffs — Small fleet (2-50 PU)
            </p>
            <p className="mt-2 text-sm text-ink-700">
              Statistical axes flag <span className="font-semibold">Critical</span> only at the
              95th percentile of the carrier&apos;s peer group — a ≈1-in-20 outlier. Below are
              the P95 cutoffs for a Small fleet. The actual cutoff depends on the carrier&apos;s
              peer group; hover any cell in the result table to see the exact value used.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-600">
                  <tr>
                    <th className="px-3 py-2">Signal</th>
                    <th className="px-3 py-2">Critical cutoff (P95)</th>
                  </tr>
                </thead>
                <tbody className="text-ink-700">
                  {sampleSmallFleetCutoffs.map((t) => (
                    <tr key={t.signal} className="border-t border-ink-100">
                      <td className="px-3 py-2">{t.signal}</td>
                      <td className="px-3 py-2 font-mono text-xs">{t.severe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-3 text-xs text-ink-500">
              For comparison: Mega fleets (1000+ PU) face tighter cutoffs because of scale —
              Driver OOS P95 ≈ 7%, Vehicle OOS P95 ≈ 35%, Crashes/M mi P95 ≈ 1.8.
            </p>
          </div>

          {/* Method + sources */}
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-sm font-semibold text-ink-900">Calibration notes</p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-ink-700">
                <li>
                  OOS axes use the <strong>observed rate</strong> (OOS inspections ÷ total) —
                  the same framework FMCSA uses internally for SMS BASIC alerts. Minimum 3
                  inspections in the 24-month window before scoring.
                </li>
                <li>
                  Crashes use <strong>per million miles</strong> (raw count ÷ MCS-150 VMT) —
                  the industry-standard safety metric. Carriers must report ≥100k annual
                  miles to be scored; below that, the cell shows &ldquo;—.&rdquo;
                </li>
                <li>
                  <strong>Absolute crash floor</strong>: 2.0 crashes per million miles bumps
                  the tier up one regardless of peer group — small fleets with operationally
                  bad crash rates don&apos;t hide behind &ldquo;normal for small.&rdquo;
                </li>
                <li>
                  <strong>Compound signals</strong>: recent revocation + any statistical
                  signal = Critical; a multi-signal chameleon cluster = Critical. Large
                  enforcement settlements (≥$25k) trigger High on their own, as does a
                  moderate risk score (≥30).
                </li>
              </ul>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-900">Data sources</p>
              <ul className="mt-2 list-inside list-disc space-y-1 text-sm text-ink-700">
                <li>FMCSA SMS Input — Census, Inspection, Crash, Violation files</li>
                <li>FMCSA Company Census — safety rating, operating status</li>
                <li>FMCSA Carrier &amp; ActPendInsur — insurance amounts, authority types</li>
                <li>FMCSA Revocation history (all-with-history file)</li>
                <li>FMCSA closed enforcement cases</li>
                <li>FMCSA MCS-150 mileage reports (annual VMT)</li>
                <li>Hazmat loads flagged for manual PHMSA registration check</li>
              </ul>
              <p className="mt-3 text-xs text-ink-500">
                Snapshot: May 2026, refreshed monthly. All FMCSA public bulk files — the
                federal source of record for motor-carrier safety.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-white">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-8 text-xs text-ink-500">
          <span>
            Built by{" "}
            <a
              className="text-augment-700 underline decoration-augment-300 underline-offset-2 hover:decoration-augment-700"
              href="https://goaugment.com"
              target="_blank"
              rel="noreferrer"
            >
              Augment
            </a>
            . Free, no warranty, not legal advice.
          </span>
          <span>Anonymous. We log only submission counts for service-quality monitoring.</span>
        </div>
      </footer>
    </main>
  );
}

function Pillar({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-ink-100 bg-white p-4">
      <div className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 rounded-full bg-augment-500" />
        <p className="text-sm font-semibold text-ink-900">{title}</p>
      </div>
      <p className="mt-2 text-sm text-ink-700">{body}</p>
    </div>
  );
}

function Stat({
  label,
  value,
  activeStyle,
}: {
  label: string;
  value: number;
  activeStyle: string;
}) {
  const isZero = value === 0;
  const cls = isZero ? "bg-white text-ink-400" : activeStyle;
  return (
    <div className={`rounded-md border border-ink-200 ${cls} px-3 py-2`}>
      <div
        className={`text-2xl font-semibold tabular-nums ${isZero ? "text-ink-300" : ""}`}
      >
        {value}
      </div>
      <div className="text-xs">{label}</div>
    </div>
  );
}

