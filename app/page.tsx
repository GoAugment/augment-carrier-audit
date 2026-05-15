"use client";
import { useState } from "react";
import { SAMPLE_INPUT } from "@/lib/sample";
import type { AuditResult, RiskLevel } from "@/lib/analyzer";
import { Logo } from "@/components/Logo";

const tierThresholds = [
  {
    signal: "Driver OOS rate",
    elevated: "≥ 25%",
    high: "≥ 33%",
    severe: "≥ 40%",
  },
  {
    signal: "Vehicle OOS rate",
    elevated: "≥ 50%",
    high: "≥ 60%",
    severe: "≥ 67%",
  },
  {
    signal: "Hazmat OOS rate",
    elevated: "≥ 6%",
    high: "≥ 12%",
    severe: "≥ 24%",
  },
  {
    signal: "Crashes per truck (24-mo)",
    elevated: "≥ 0.10",
    high: "≥ 0.20",
    severe: "≥ 0.40 or any fatal",
  },
];

const riskStyles: Record<RiskLevel, string> = {
  Critical: "bg-red-200 text-red-950 border-red-400 font-semibold",
  Severe: "bg-red-100 text-red-900 border-red-200",
  High: "bg-orange-100 text-orange-900 border-orange-200",
  Elevated: "bg-amber-50 text-amber-900 border-amber-200",
};

/** Subtle whole-row tint so severity tiers cluster visually when scanning. */
const rowTint: Record<RiskLevel, string> = {
  Critical: "bg-red-50/80",
  Severe: "bg-red-50/40",
  High: "bg-orange-50/40",
  Elevated: "bg-amber-50/30",
};

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
            href="https://goaugment.com/contact"
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
            . Up to 1,000 loads per submission.
          </p>
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
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
          <div className="mx-auto max-w-5xl px-6 py-12">
            <h2 className="text-xl font-semibold text-ink-900">Audit result</h2>
            <p className="mt-2 text-sm text-ink-700">
              {result.totalLoads} load{result.totalLoads === 1 ? "" : "s"} ·{" "}
              {result.totalCarriers} unique carrier{result.totalCarriers === 1 ? "" : "s"} ·{" "}
              <strong>{result.flaggedCarriers} flagged for review</strong>
            </p>
            <div className="mt-4 grid grid-cols-2 gap-3 sm:max-w-2xl sm:grid-cols-4">
              <Stat label="Critical" value={result.bySeverity.Critical} activeStyle="bg-red-200 text-red-950" />
              <Stat label="Severe" value={result.bySeverity.Severe} activeStyle="bg-red-100 text-red-900" />
              <Stat label="High" value={result.bySeverity.High} activeStyle="bg-orange-100 text-orange-900" />
              <Stat label="Elevated" value={result.bySeverity.Elevated} activeStyle="bg-amber-50 text-amber-900" />
            </div>

            {result.flags.length > 0 ? (
              <div className="mt-6 overflow-hidden rounded-lg border border-ink-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-600">
                    <tr>
                      <th className="px-3 py-2">#</th>
                      <th className="px-3 py-2">Risk</th>
                      <th className="px-3 py-2">Loads</th>
                      <th className="px-3 py-2">Load IDs</th>
                      <th className="px-3 py-2">Carrier</th>
                      <th className="px-3 py-2">DOT</th>
                      <th className="px-3 py-2">Why</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.flags.map((f) => (
                      <tr
                        key={f.dot}
                        className={`border-t border-ink-100 align-top ${rowTint[f.riskLevel]}`}
                      >
                        <td className="px-3 py-2 text-ink-500">{f.rank}</td>
                        <td className="px-3 py-2">
                          <span
                            className={`inline-flex rounded-full border px-2 py-0.5 text-xs font-medium ${riskStyles[f.riskLevel]}`}
                          >
                            {f.riskLevel}
                          </span>
                        </td>
                        <td className="px-3 py-2">{f.loadCount}</td>
                        <td className="px-3 py-2 font-mono text-xs text-ink-700">
                          {f.loadIds.join(", ")}
                        </td>
                        <td className="px-3 py-2">
                          <div>
                            {f.carrierName ?? <span className="text-ink-400">unknown</span>}
                          </div>
                          <div className="mt-0.5 flex flex-wrap gap-1">
                            {f.hasFatalCrash && (
                              <span className="inline-flex rounded-full border border-red-300 bg-red-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-red-800">
                                Fatal crash
                              </span>
                            )}
                            {f.hazmatLoadIds.length > 0 && (
                              <span className="inline-flex rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800">
                                Hazmat
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-ink-700">{f.dot}</td>
                        <td className="px-3 py-2 text-ink-700">
                          <ul className="space-y-1">
                            {f.reasons.map((r, i) => (
                              <li key={i}>• {r}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
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
            href="https://goaugment.com/contact"
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

          {/* Tier definitions */}
          <div className="mt-6">
            <p className="text-sm font-semibold text-ink-900">Risk tiers</p>
            <p className="mt-2 text-sm text-ink-700">
              Tiers are anchored to the national distribution of all ~2M FMCSA-registered
              carriers — so a flag means &ldquo;worse than X% of US carriers,&rdquo; not a
              made-up cutoff.
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
                      Binary regulatory failure: insurance lapsed, FMCSA safety rating
                      Unsatisfactory, operating status not Active, or active out-of-service
                      order.
                    </td>
                  </tr>
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-red-200 bg-red-100 px-2 py-0.5 text-xs font-medium text-red-900">
                        Severe
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Worse than P95</td>
                    <td className="px-3 py-2 align-top">
                      Top 5% nationally on at least one axis; or any fatal crash; or a recent
                      involuntary revocation combined with another statistical signal.
                    </td>
                  </tr>
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-orange-200 bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-900">
                        High
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Worse than P90</td>
                    <td className="px-3 py-2 align-top">
                      Top 10% nationally on at least one axis; or recent involuntary revocation
                      (≤ 24 mo); or chronic revocations (≥ 3 historical).
                    </td>
                  </tr>
                  <tr className="border-t border-ink-100">
                    <td className="px-3 py-2 align-top">
                      <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-900">
                        Elevated
                      </span>
                    </td>
                    <td className="px-3 py-2 align-top">Worse than P85</td>
                    <td className="px-3 py-2 align-top">
                      Top 15% nationally on at least one axis. Operator awareness — not
                      automatically blocking.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          {/* Per-axis thresholds */}
          <div className="mt-8">
            <p className="text-sm font-semibold text-ink-900">Per-axis thresholds</p>
            <p className="mt-2 text-sm text-ink-700">
              Derived from the national distribution of all qualifying carriers in the May 2026
              FMCSA snapshot. Crashes/truck uses fixed thresholds because the national
              distribution is zero-dominated (P90 = 0 crashes), so percentile cutoffs would be
              meaningless; the fixed values still correspond to roughly the top 1% of the
              population.
            </p>
            <div className="mt-3 overflow-x-auto rounded-lg border border-ink-200 bg-white">
              <table className="w-full text-left text-sm">
                <thead className="bg-ink-50 text-xs uppercase tracking-wide text-ink-600">
                  <tr>
                    <th className="px-3 py-2">Signal</th>
                    <th className="px-3 py-2">Elevated (P85)</th>
                    <th className="px-3 py-2">High (P90)</th>
                    <th className="px-3 py-2">Severe (P95)</th>
                  </tr>
                </thead>
                <tbody className="text-ink-700">
                  {tierThresholds.map((t) => (
                    <tr key={t.signal} className="border-t border-ink-100">
                      <td className="px-3 py-2">{t.signal}</td>
                      <td className="px-3 py-2 font-mono text-xs">{t.elevated}</td>
                      <td className="px-3 py-2 font-mono text-xs">{t.high}</td>
                      <td className="px-3 py-2 font-mono text-xs">{t.severe}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Statistical method + data sources */}
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            <div>
              <p className="text-sm font-semibold text-ink-900">Statistical method</p>
              <p className="mt-2 text-sm text-ink-700">
                Each OOS rate is compared against its cutoff using a{" "}
                <strong>statistical floor</strong> — the 95% confidence lower bound on the
                carrier&apos;s true rate (Wilson&apos;s score interval). A flag fires only when
                even this carrier-favorable estimate exceeds the cutoff, so a single 1-of-1
                inspection doesn&apos;t trigger a false positive.
              </p>
              <p className="mt-3 text-sm text-ink-700">
                Crash rate uses raw crashes per power unit over a trailing 24-month window
                with a minimum-fleet guard (≥ 5 power units, or any fatal/injury crash) so a
                single incident on a one-truck fleet doesn&apos;t pin a carrier as &ldquo;top
                1% worst.&rdquo; Any fatal crash promotes the carrier to Severe regardless of
                rate.
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-ink-900">Data sources</p>
              <ul className="mt-1 list-inside list-disc text-sm text-ink-700">
                <li>FMCSA SMS Input (Census, Inspection, Crash, Violation) — May 2026</li>
                <li>FMCSA Company Census File (safety rating, status)</li>
                <li>FMCSA Carrier &amp; ActPendInsur (insurance amounts, authority)</li>
                <li>FMCSA Revocation history &amp; closed enforcement cases</li>
                <li>Hazmat carriers flagged for manual PHMSA verification</li>
              </ul>
              <p className="mt-3 text-xs text-ink-500">
                FMCSA&apos;s public carrier data — QCMobile, SAFER, and the SMS Input files —
                is the federal source of record for motor carrier safety. Free and publicly
                accessible.
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
