"use client";
import { useEffect, useRef, useState } from "react";
import { SAMPLE_INPUT } from "@/lib/sample";
import type { AuditResult } from "@/lib/analyzer";
import { Scorecard } from "@/components/Scorecard";

/**
 * The interactive paste form + results table. Embeddable anywhere
 * (used by both the marketing landing page and the /embed iframe route).
 */
export function AuditWidget({ compact = false }: { compact?: boolean }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<(AuditResult & { parseErrors?: string[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // When embedded in an iframe, continuously post our content height to the parent
  // so it can auto-resize the iframe. Uses ResizeObserver — fires on any DOM
  // change including textarea growth, results appearing, error banners, etc.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.parent === window) return; // not embedded
    const el = containerRef.current;
    if (!el) return;
    const postHeight = () => {
      const h = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight,
        el.scrollHeight
      );
      window.parent.postMessage({ type: "augment-audit:height", height: h }, "*");
    };
    postHeight(); // initial
    const ro = new ResizeObserver(postHeight);
    ro.observe(el);
    ro.observe(document.body);
    window.addEventListener("load", postHeight);
    return () => {
      ro.disconnect();
      window.removeEventListener("load", postHeight);
    };
  }, []);

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
      // The ResizeObserver in the useEffect above will fire automatically once
      // the result DOM appears, so no manual postMessage needed here.
    }
  }

  function loadSample() {
    setInput(SAMPLE_INPUT.trim());
    setResult(null);
    setError(null);
  }

  return (
    <div ref={containerRef} className={compact ? "" : "mx-auto max-w-3xl"}>
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
        <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">DOT</code> · {" "}
        <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">DOT, LoadID</code> · {" "}
        <code className="rounded bg-ink-100 px-1 py-0.5 font-mono text-xs">
          DOT, LoadID, HAZMAT
        </code>
        . Up to 1,000 loads.
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

      {result && (
        <div className="mt-8">
          <h3 className="text-lg font-semibold text-ink-900">Audit result</h3>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm text-ink-700">
            <span>
              {result.totalLoads} load{result.totalLoads === 1 ? "" : "s"} ·{" "}
              {result.totalCarriers} carrier{result.totalCarriers === 1 ? "" : "s"} ·{" "}
              <strong>{result.flaggedCarriers} flagged</strong>
            </span>
            {(["Critical", "Severe", "High", "Elevated"] as const).map((tier) => {
              const v = result.bySeverity[tier];
              if (v === 0) return null;
              const cls =
                tier === "Critical"
                  ? "bg-red-200 text-red-950 font-semibold"
                  : tier === "Severe"
                    ? "bg-red-100 text-red-900"
                    : tier === "High"
                      ? "bg-orange-100 text-orange-900"
                      : "bg-amber-50 text-amber-900";
              return (
                <span
                  key={tier}
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${cls}`}
                >
                  <strong className="tabular-nums">{v}</strong> {tier}
                </span>
              );
            })}
          </div>

          {result.rows.length > 0 ? (
            <Scorecard rows={result.rows} result={result} />
          ) : (
            <div className="mt-5 rounded-lg border border-augment-200 bg-augment-50 px-4 py-6 text-sm text-augment-900">
              <strong>No carriers flagged.</strong> All {result.totalCarriers} carriers in this
              submission cleared the safety thresholds. Save this report as part of your vetting
              record.
            </div>
          )}

          {result.unresolvedDots.length > 0 && (
            <p className="mt-3 text-xs text-ink-500">
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
      )}
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
