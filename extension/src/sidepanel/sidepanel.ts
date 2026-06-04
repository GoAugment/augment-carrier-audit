/**
 * Side panel UI — renders the audit NATIVELY to match the design comp:
 * verdict header, score tiles, the "Your relationship" card (locked when
 * signed out), the full Safety-checks list with pass/fail/skip toggles, and
 * the FMCSA BASIC bars. Two tiers, decided purely by the Augie session cookie.
 */

import type {
  AuditVerdict,
  AuthStateInfo,
  CarrierEnrichment,
  CheckResult,
  CheckRow,
  VerdictCarrier,
} from "../types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const recheckBtn = $<HTMLButtonElement>("recheck");
const authChip = $<HTMLButtonElement>("authChip");
const devbar = $("devbar");
const envToggle = $<HTMLButtonElement>("envToggle");
const brokerageInput = $<HTMLInputElement>("brokerageInput");
const metaEl = $("meta");

// Unpacked/dev installs have no injected `update_url`; Web Store installs do.
// Used to show the env/brokerage controls only during development.
const IS_DEV = !("update_url" in chrome.runtime.getManifest());
const statusEl = $("status");
const verdictEl = $("verdict");
const enrichmentEl = $("enrichment");
const checksEl = $("checks");
const basicsEl = $("basics");

function send<T = unknown>(message: unknown): Promise<T> {
  return chrome.runtime.sendMessage(message) as Promise<T>;
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)
  );
}

const TIER_HEADLINE: Record<AuditVerdict["tier"], string> = {
  Clean: "Looks legitimate",
  Caution: "Worth a closer look",
  High: "Verify before tendering",
  Critical: "Do not tender",
};

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;

const monthYear = (d: string) =>
  new Date(`${d}T00:00:00`).toLocaleString("en-US", { month: "short", year: "numeric" });

// Brokerage badge label. The data is scoped to the override (dev) or the
// signed-in user's brokerage; map the known ones, else initialize the key.
let authBrokerageKey = "";
let brokerageOverride = "";
const BROKERAGE_LABEL: Record<string, string> = { "transportation-one": "T1" };
function brokerageLabel(): string {
  const key = brokerageOverride || authBrokerageKey;
  if (!key) return "";
  return (
    BROKERAGE_LABEL[key] ??
    key.split(/[-_\s]+/).map((w) => w[0]).join("").slice(0, 3).toUpperCase()
  );
}

const TREND_GLYPH: Record<"up" | "down" | "flat", string> = { up: "▲", down: "▼", flat: "–" };

const OPERATING_AREA: Record<string, string> = {
  interstate_otr: "Interstate, long-haul",
  interstate_local: "Interstate, local",
  intrastate_otr: "Intrastate, long-haul",
  intrastate_local: "Intrastate, local",
};
const humanizeArea = (a: string) =>
  OPERATING_AREA[a] ?? a.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/**
 * The full "everything FMCSA tells us about the company" card — collapsed by
 * default behind a <details> so it doesn't dominate the panel. Only renders
 * cells we actually have data for.
 */
function carrierDetails(c: VerdictCarrier): string {
  const cells: Array<[string, string]> = [];

  const revoked = c.allowedToOperate === "N" || (c.statusCode != null && c.statusCode !== "A");
  if (c.mostRecentRevocationDate && revoked) {
    cells.push(["Authority", `<span class="danger">REVOKED ${esc(c.mostRecentRevocationDate)}</span>`]);
  } else if (revoked) {
    cells.push(["Authority", `<span class="danger">Not authorized to operate</span>`]);
  } else if (c.allowedToOperate === "Y") {
    cells.push(["Authority", "Authorized to operate"]);
  }

  if (c.powerUnits != null || c.drivers != null) {
    const parts: string[] = [];
    if (c.powerUnits != null) parts.push(`${c.powerUnits} power units`);
    if (c.drivers != null) parts.push(`${c.drivers} drivers`);
    cells.push(["Fleet", parts.join(" · ")]);
  }
  if (c.operatingArea) cells.push(["Operation", esc(humanizeArea(c.operatingArea))]);
  if (c.cargoCapabilities?.length) cells.push(["Cargo", esc(c.cargoCapabilities.join(", "))]);
  if (c.fmcsaPhone) cells.push(["Phone on file", esc(c.fmcsaPhone)]);
  if (c.fmcsaEmail)
    cells.push(["Email on file", `<a href="mailto:${esc(c.fmcsaEmail)}">${esc(c.fmcsaEmail)}</a>`]);
  cells.push([
    "Activity (24mo)",
    `${c.inspections24mo} inspections${c.crashes24mo ? ` · <span class="danger">${c.crashes24mo} crashes</span>` : ""}`,
  ]);
  if (c.companyOfficer) cells.push(["Primary officer", esc(c.companyOfficer)]);
  if (c.dotIssued) cells.push(["DOT issued", esc(c.dotIssued)]);
  if (c.safetyRating) cells.push(["Safety rating", esc(c.safetyRating)]);
  if (c.bipdInsurer || c.bipdAmount != null) {
    const amt = c.bipdAmount != null ? usd(c.bipdAmount) : "";
    cells.push(["BIPD insurance", `${amt}${c.bipdInsurer ? `${amt ? " · " : ""}${esc(c.bipdInsurer)}` : ""}`]);
  }

  if (!cells.length) return "";
  const grid = cells
    .map(([k, val]) => `<div class="cd-cell"><div class="cd-label">${esc(k)}</div><div class="cd-value">${val}</div></div>`)
    .join("");
  return `<details class="carrier-details"><summary>FMCSA company details</summary><div class="cd-grid">${grid}</div></details>`;
}

// ---------- auth chip ----------

function initials(name: string): string {
  const ltrs = name.trim().split(/\s+/).filter(Boolean).map((p) => p[0]).join("");
  return (ltrs.slice(0, 2) || name.slice(0, 2)).toUpperCase();
}

function renderAuth(info: AuthStateInfo) {
  authBrokerageKey = info.brokerageKey ?? "";
  if (info.isAuthenticated && info.user) {
    const name = info.user.profile.displayName || info.user.claims.email;
    authChip.classList.add("signed-in");
    authChip.title = `Signed in to Augie · ${info.brokerageKey ?? ""}`;
    const firstName = name.trim().split(/\s+/)[0] || name;
    authChip.innerHTML =
      `<span class="avatar">${esc(initials(name))}</span><span class="chip-name">${esc(firstName)}</span>`;
  } else {
    authChip.classList.remove("signed-in");
    authChip.title = "Sign in to Augie for lane history, rep owner & DSLS";
    authChip.textContent = "Sign in";
  }
}

// ---------- verdict ----------

const SIGNAL_RANK: Record<AuditVerdict["signals"][number]["tier"], number> = {
  critical: 3,
  high: 2,
  caution: 1,
  info: 0,
};

// Per-tile severity → tier class (sets --tier for the colored top border + value).
const scoreTierClass = (n: number | null): string =>
  n == null ? "" : n >= 80 ? "tier-Critical" : n >= 60 ? "tier-High" : n >= 40 ? "tier-Caution" : "tier-Clean";
function issTierClass(t: string | null): string {
  const s = (t ?? "").toLowerCase();
  if (s.includes("inspect")) return "tier-High";
  if (s.includes("optional")) return "tier-Caution";
  if (s.includes("pass") || s.includes("clean")) return "tier-Clean";
  return "";
}

function renderVerdict(v: AuditVerdict, checks: CheckRow[]) {
  verdictEl.hidden = false;
  verdictEl.className = `verdict tier-${v.tier}`;
  const c = v.carrier;

  // Lead with the SINGLE most important finding — the first failed check (the
  // reasons are severity-ordered). The full breakdown is the Safety-checks
  // section; the "see all" link jumps to it. Deliberately NOT the audit_tier
  // signal (its detail is a run-on of every reason) — fall back to a specific
  // non-audit signal, then the server summary (e.g. a clean carrier).
  const failed = checks.filter((r) => r.status === "failed");
  const topSignal = [...(v.signals ?? [])]
    .filter((s) => s.tier !== "info" && s.category !== "audit_tier")
    .sort((a, b) => SIGNAL_RANK[b.tier] - SIGNAL_RANK[a.tier])[0];
  const lead: { label: string; detail: string } | undefined = failed[0] ?? topSignal;
  const subtext = lead
    ? `<b>${esc(lead.label)}</b>${lead.detail ? ` — ${esc(lead.detail)}` : ""}`
    : esc(v.summary);
  const seeAll =
    checks.length > 1 && (failed.length || topSignal)
      ? `<a class="see-checks" role="button" tabindex="0">See all ${checks.length} checks ↓</a>`
      : "";

  const tiles = c
    ? `<div class="tiles">
         <div class="tile ${scoreTierClass(c.riskScore)}"><div class="t-label">Risk score</div><div class="t-value">${c.riskScore ?? "—"}</div><div class="t-sub">0–100 · higher = riskier</div></div>
         <div class="tile ${issTierClass(c.issTier)}"><div class="t-label">ISS est.</div><div class="t-value">${c.issScore ?? "—"}</div><div class="t-sub">${esc(c.issTier ?? "estimated")}</div></div>
       </div>`
    : "";

  const carrierBlock = c
    ? `<div class="carrier-block">
         <div class="carrier-name">${esc(c.legalName ?? "(unnamed carrier)")}</div>
         <div class="carrier-ids">
           <span class="id-pill">DOT ${c.dotNumber}</span>
           ${c.mcNumber ? `<span class="id-pill">${esc(c.mcNumber)}</span>` : ""}
           ${c.physicalLocation ? `<span class="id-pill">${esc(c.physicalLocation)}</span>` : ""}
         </div>
         ${carrierDetails(c)}
       </div>`
    : "";

  verdictEl.innerHTML =
    `<span class="tier-pill">${esc(v.tier)}</span>` +
    `<div class="headline">${esc(TIER_HEADLINE[v.tier])}</div>` +
    `<div class="summary">${subtext}</div>` +
    seeAll +
    carrierBlock +
    tiles;

  verdictEl.querySelector(".see-checks")?.addEventListener("click", () =>
    checksEl.scrollIntoView({ behavior: "smooth", block: "start" })
  );
}

// ---------- enrichment ----------

function openSignIn() {
  void send({ type: "OPEN_SIGNIN" });
}

function renderLocked() {
  enrichmentEl.hidden = false;
  enrichmentEl.className = "enrichment locked";
  const field = (ico: string, title: string, sub: string) =>
    `<li><span class="lock-ico">${ico}</span><div><div class="l-title">${title}</div><div class="l-sub">${sub}</div></div></li>`;
  enrichmentEl.innerHTML =
    `<h3>Your history with this carrier</h3>` +
    `<ul class="lock-list">
       ${field("🛣️", "Lane history", "Lanes & rates you've run this carrier")}
       ${field("👤", "Owning rep", "Who on your team owns the relationship")}
       ${field("📅", "Days since last shipment", "When you last tendered them a load")}
     </ul>` +
    `<button class="btn-primary" type="button">Sign in to Augie</button>`;
  enrichmentEl.querySelector(".btn-primary")?.addEventListener("click", openSignIn);
}

function renderEnrichment(e: CarrierEnrichment) {
  enrichmentEl.hidden = false;

  if (!e.hasRelationship) {
    enrichmentEl.className = "enrichment history empty";
    enrichmentEl.innerHTML =
      `<h3><span class="hist-star">★</span> Your history with this carrier</h3>` +
      `<div class="empty-history">
         <div class="eh-title">No prior shipments</div>
         <div class="eh-sub">You haven't booked this carrier before. If you do, it'll show up here — loads, lanes, rates, and the owning rep.</div>
       </div>`;
    return;
  }

  enrichmentEl.className = "enrichment history unlocked";

  // Header status pill — recency-based (we don't have FMCSA status here).
  const active = e.dsls != null && e.dsls <= 120;
  const statusPill =
    e.dsls == null
      ? ""
      : `<span class="hist-pill ${active ? "ok" : "stale"}">${active ? "Active" : "Dormant"}</span>`;

  // Big stats: DSLS · loads ("since <month>"). On-time %s are intentionally not
  // shown — without the appointment window END they read biased-low/unreliable.
  const sinceLabel = e.firstShipmentDate ? `Loads since ${monthYear(e.firstShipmentDate)}` : "Loads together";

  // Owner card.
  const badge = brokerageLabel();
  const ownerCard = e.repOwner
    ? `<div class="owner-card">
         <span class="avatar lg">${esc(initials(e.repOwner.name))}</span>
         <div class="owner-main">
           <div class="owner-name">Owned by <b>${esc(e.repOwner.name)}</b></div>
           <div class="owner-sub">${e.repLoadCount ? `${e.repLoadCount} of ${e.loadCount} loads` : "owning rep"}</div>
         </div>
         ${badge ? `<span class="brokerage-badge">${esc(badge)}</span>` : ""}
       </div>`
    : `<div class="owner-card">
         <div class="owner-main">
           <div class="owner-name">Unassigned</div>
           <div class="owner-sub">No owning rep on these loads</div>
         </div>
       </div>`;

  // Lane history.
  const laneList = Array.isArray(e.lanes) ? e.lanes : [];
  const laneRows = laneList
    .map((l) => {
      const rate = l.lastRate ?? l.avgRate;
      const tr = l.trend ? `<span class="lane-trend ${l.trend}">${TREND_GLYPH[l.trend]}</span>` : "";
      return `<div class="lane-row">
        <span class="lane-route">${esc(l.origin)} → ${esc(l.destination)}</span>
        <span class="lane-count">${l.count}×</span>
        <span class="lane-rate">${rate != null ? usd(rate) : "—"}</span>
        ${tr}
      </div>`;
    })
    .join("");

  enrichmentEl.innerHTML =
    `<div class="hist-head"><span class="hist-title"><span class="hist-star">★</span> Your history with this carrier</span>${statusPill}</div>` +
    `<div class="hist-stats">
       <div class="hstat">
         <div class="hstat-v">${e.dsls == null ? "—" : e.dsls}<span class="hstat-u"> days</span></div>
         <div class="hstat-l">Since last shipment</div>
       </div>
       <div class="hstat">
         <div class="hstat-v">${e.loadCount}</div>
         <div class="hstat-l">${esc(sinceLabel)}</div>
       </div>
     </div>` +
    ownerCard +
    (laneRows
      ? `<div class="lane-head"><span>Lane history</span><span>Loads · Last rate</span></div>${laneRows}`
      : "");
}

// ---------- safety checks ----------

let hidePassed = false;
let hideSkipped = false;

const ICON: Record<CheckRow["status"], string> = { failed: "✗", passed: "✓", skipped: "–", info: "i" };

function renderChecks(checks: CheckRow[]) {
  if (!checks.length) {
    checksEl.hidden = true;
    return;
  }
  checksEl.hidden = false;

  // info = explanatory notes (e.g. "why the SMS scores look clean") — sit right
  // after the failures they explain, never hidden by the pass/skip toggles.
  const order: Record<CheckRow["status"], number> = { failed: 0, info: 1, passed: 2, skipped: 3 };
  const sorted = [...checks].sort((a, b) => order[a.status] - order[b.status]);
  const passed = checks.filter((r) => r.status === "passed").length;
  const failed = checks.filter((r) => r.status === "failed").length;
  const skipped = checks.filter((r) => r.status === "skipped").length;

  const rows = sorted
    .map((r) => {
      const hidden =
        (r.status === "passed" && hidePassed) || (r.status === "skipped" && hideSkipped);
      return `<div class="check ${r.status}${hidden ? " hidden" : ""}">
        <span class="c-ico">${ICON[r.status]}</span>
        <div><div class="c-title">${esc(r.label)}</div><div class="c-detail">${esc(r.detail)}</div></div>
      </div>`;
    })
    .join("");

  const toggles: string[] = [];
  if (passed) toggles.push(`<button class="toggle" data-t="passed">${hidePassed ? "Show" : "Hide"} passed checks</button>`);
  if (skipped) toggles.push(`<button class="toggle" data-t="skipped">${hideSkipped ? "Show" : "Hide"} skipped</button>`);

  const tally =
    `<span class="tally"><b class="p">${passed}</b> passed · ` +
    `<b class="f">${failed}</b> failed · <b>${skipped}</b> skipped</span>`;

  checksEl.innerHTML =
    `<div class="section-h"><span>Safety checks</span>${tally}</div>` +
    rows +
    (toggles.length ? `<div class="checks-toggles">${toggles.join("")}</div>` : "");

  checksEl.querySelectorAll<HTMLButtonElement>(".toggle").forEach((btn) =>
    btn.addEventListener("click", () => {
      if (btn.dataset.t === "passed") hidePassed = !hidePassed;
      else hideSkipped = !hideSkipped;
      renderChecks(checks);
    })
  );
}

// ---------- FMCSA BASIC bars ----------

function renderBasics(c: VerdictCarrier | null) {
  const basics = c?.basics?.filter((b) => b.percentile != null) ?? [];
  if (!basics.length) {
    basicsEl.hidden = true;
    return;
  }
  basicsEl.hidden = false;
  const bar = (b: { name: string; percentile: number | null; alert: boolean }) => {
    const p = b.percentile ?? 0;
    const pct = Math.round(p);
    const cls = b.alert || p >= 90 ? "bad" : p >= 75 ? "warn" : "";
    return `<div class="bar-row">
      <span class="bar-name">${esc(b.name)}</span>
      <span class="bar-track"><span class="bar-fill ${cls}" style="width:${Math.max(3, pct)}%"></span></span>
      <span class="bar-val ${cls}">${pct}</span>
    </div>`;
  };
  basicsEl.innerHTML =
    `<div class="section-h"><span>FMCSA BASIC percentiles</span><span class="detected">higher = worse</span></div>` +
    basics.map(bar).join("");
}

// ---------- recent checks (persisted) ----------

interface RecentCheck {
  name: string | null;
  dot: number | null;
  tier: AuditVerdict["tier"];
  ts: number;
}

async function storeRecentCheck(entry: RecentCheck) {
  const { recentChecks } = await chrome.storage.local.get("recentChecks");
  const list: RecentCheck[] = Array.isArray(recentChecks) ? recentChecks : [];
  const deduped = [entry, ...list.filter((r) => r.dot !== entry.dot)].slice(0, 12);
  await chrome.storage.local.set({ recentChecks: deduped });
}

function relTime(ts: number): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return days === 1 ? "Yesterday" : `${days}d ago`;
}

// ---------- run ----------

const SOURCE = (title: string, sub: string) =>
  `<div class="source-card"><span class="src-dot"></span><div><div class="src-title">${title}</div><div class="src-sub">${sub}</div></div></div>`;

async function renderRecentChecks() {
  const { recentChecks } = await chrome.storage.local.get("recentChecks");
  const list: RecentCheck[] = Array.isArray(recentChecks) ? recentChecks : [];
  if (!list.length || verdictEl.querySelector(".recent")) return;
  const rows = list
    .slice(0, 6)
    .map(
      (r) =>
        `<div class="recent-item" data-dot="${r.dot ?? ""}">
           <div><div class="ri-name">${esc(r.name ?? "Unknown carrier")}</div>` +
        `<div class="ri-sub">${r.dot ? `DOT ${r.dot}` : ""} · ${relTime(r.ts)}</div></div>` +
        `<span class="ri-tier tier-${r.tier}">${esc(r.tier)}</span></div>`
    )
    .join("");
  const block = document.createElement("div");
  block.className = "recent";
  block.innerHTML = `<div class="nc-section-h">Recent checks</div>${rows}`;
  verdictEl.appendChild(block);
  block.querySelectorAll<HTMLElement>(".recent-item").forEach((el) =>
    el.addEventListener("click", () => {
      const dot = el.dataset.dot;
      if (dot) void runCheck(dot);
    })
  );
}

function renderNoCarrier() {
  metaEl.textContent = ""; // nothing checked → no status line
  for (const el of [enrichmentEl, checksEl, basicsEl]) el.hidden = true;
  verdictEl.hidden = false;
  verdictEl.className = "verdict no-carrier";
  verdictEl.innerHTML =
    `<div class="nc-head"><span class="nc-ico">🔍</span><div>
       <div class="nc-title">No carrier detected</div>
       <div class="nc-sub">No DOT or MC number is visible on this page. Open a carrier's email, a load, or their FMCSA SAFER page — or paste a number below — and the check runs automatically.</div>
     </div></div>` +
    `<div class="nc-section-h">Check a number now</div>` +
    `<div class="nc-manual">
       <input class="nc-input" type="text" placeholder="DOT or MC number" inputmode="numeric" aria-label="DOT or MC number" />
       <button class="btn-primary nc-check" type="button">Check</button>
     </div>` +
    `<div class="nc-tip">Tip: highlight any DOT/MC on the page and the check runs on its own.</div>` +
    `<div class="nc-section-h">Where Augie reads a carrier</div>` +
    SOURCE("Carrier email or rate con", "DOT/MC in the body or signature") +
    SOURCE("A load or tender", "the assigned carrier's identifiers") +
    SOURCE("FMCSA SAFER / a load board", "the carrier profile you're viewing");

  const input = verdictEl.querySelector<HTMLInputElement>(".nc-input");
  const submit = () => {
    const v = input?.value.trim();
    if (v) void runCheck(v);
  };
  verdictEl.querySelector(".nc-check")?.addEventListener("click", submit);
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });

  void renderRecentChecks();
}

function renderResult(result: CheckResult) {
  statusEl.hidden = true;
  metaEl.innerHTML = `<span class="ok">●</span> Checked this page · just now`;

  // No DOT/MC on the page → a clear prompt, not a fake verdict + errors.
  if (!result.dot && !result.mc) {
    renderNoCarrier();
    return;
  }

  // Be defensive: an older background service worker may not include `checks`.
  const checks = Array.isArray(result.checks) ? result.checks : [];
  renderVerdict(result.verdict, checks);

  if (result.enrichment) renderEnrichment(result.enrichment);
  else if (result.enrichmentError) {
    enrichmentEl.hidden = false;
    enrichmentEl.className = "enrichment locked";
    enrichmentEl.innerHTML = `<h3>Your history with this carrier</h3><div class="summary">${esc(result.enrichmentError)}</div>`;
  } else renderLocked();

  renderChecks(checks);
  renderBasics(result.verdict.carrier);

  const c = result.verdict.carrier;
  if (c?.dotNumber) {
    void storeRecentCheck({
      name: c.legalName,
      dot: c.dotNumber,
      tier: result.verdict.tier,
      ts: Date.now(),
    });
  }
}

let running = false;

async function runCheck(manual?: string) {
  if (running) return; // ignore overlapping triggers (re-check on page change)
  running = true;
  recheckBtn.disabled = true;
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.textContent = "Checking this page…";
  metaEl.textContent = "";
  for (const el of [verdictEl, enrichmentEl, checksEl, basicsEl]) el.hidden = true;

  try {
    const res = await send<{ ok: boolean; result?: CheckResult; error?: string }>({ type: "RUN_CHECK", manual });
    if (!res.ok || !res.result) throw new Error(res.error || "Check failed.");
    renderResult(res.result);
  } catch (e) {
    statusEl.hidden = false;
    statusEl.className = "status error";
    statusEl.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    running = false;
    recheckBtn.disabled = false;
  }
}

// ---------- dev controls ----------

async function renderDevbar() {
  if (!IS_DEV) {
    devbar.hidden = true;
    return;
  }
  devbar.hidden = false;
  const { environment, brokerageKey } = await chrome.storage.local.get(["environment", "brokerageKey"]);
  brokerageOverride = brokerageKey ?? "";
  const staging = environment === "staging";
  envToggle.textContent = staging ? "staging" : "prod";
  envToggle.dataset.env = staging ? "staging" : "production";
  if (document.activeElement !== brokerageInput) brokerageInput.value = brokerageKey ?? "";
}

// ---------- wire up ----------

recheckBtn.addEventListener("click", () => void runCheck());
authChip.addEventListener("click", () => {
  if (!authChip.classList.contains("signed-in")) openSignIn();
});

envToggle.addEventListener("click", async () => {
  const next = envToggle.dataset.env === "staging" ? "production" : "staging";
  await chrome.storage.local.set({ environment: next });
  await renderDevbar();
  void runCheck();
});
brokerageInput.addEventListener("change", async () => {
  const v = brokerageInput.value.trim();
  brokerageOverride = v;
  if (v) await chrome.storage.local.set({ brokerageKey: v });
  else await chrome.storage.local.remove("brokerageKey");
  void runCheck();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "PAGE_CHANGED") {
    void runCheck(); // content changed (SPA nav) — re-check the now-visible carrier
    return;
  }
  if (msg?.type === "AUTH_STATE_CHANGED") {
    renderAuth(msg as AuthStateInfo);
    if ((msg as AuthStateInfo).isAuthenticated) void runCheck();
  }
});

async function init() {
  void renderDevbar();
  const auth = await send<{ ok: boolean } & AuthStateInfo>({ type: "GET_AUTH_STATE" });
  renderAuth(auth);
  void runCheck();
}

void init();
