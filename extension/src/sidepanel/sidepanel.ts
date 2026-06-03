/**
 * Side panel UI — renders the audit NATIVELY (no iframe) so it's part of the
 * panel, not a squeezed mini-webpage. Two tiers, decided purely by whether an
 * Augie session cookie is present:
 *   - PUBLIC (signed out): the FMCSA verdict + a locked card with a
 *     "Sign in to Augie" button.
 *   - PRIVATE (signed in):  the same verdict + this brokerage's lane history,
 *     rep owner, and days-since-last-shipment.
 */

import type {
  AuditVerdict,
  AuthStateInfo,
  CarrierEnrichment,
  CheckResult,
  VerdictCarrier,
} from "../types";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const authChip = $<HTMLButtonElement>("authChip");
const statusEl = $("status");
const verdictEl = $("verdict");
const enrichmentEl = $("enrichment");
const recheckBtn = $<HTMLButtonElement>("recheck");

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
  Critical: "Do not engage without verification",
};

// ---- auth chip ----

function renderAuth(info: AuthStateInfo) {
  if (info.isAuthenticated && info.user) {
    authChip.textContent = info.user.profile.displayName || info.user.claims.email;
    authChip.title = `Signed in to Augie · ${info.brokerageKey ?? ""}`;
    authChip.classList.add("signed-in");
  } else {
    authChip.textContent = "Sign in";
    authChip.title = "Sign in to Augie for lane history, rep owner & DSLS";
    authChip.classList.remove("signed-in");
  }
}

// ---- verdict (public tier) ----

function fact(label: string, value: string, cls = ""): string {
  return `<div class="fact"><div class="f-label">${esc(label)}</div><div class="f-value ${cls}">${esc(value)}</div></div>`;
}

function carrierFacts(c: VerdictCarrier): string {
  const facts: string[] = [];

  // Authority status — the single most decision-relevant fact.
  const revoked = c.allowedToOperate === "N";
  facts.push(
    fact(
      "Authority",
      revoked ? `Revoked${c.mostRecentRevocationDate ? ` ${c.mostRecentRevocationDate}` : ""}` : "Active",
      revoked ? "bad" : "good"
    )
  );

  const bipd = c.bipdAmount != null ? `$${Math.round(c.bipdAmount / 1000)}k` : "—";
  facts.push(fact("BIPD insurance", c.bipdInsurer ? `${bipd} · ${c.bipdInsurer}` : bipd));
  facts.push(fact("Cargo insurance", c.cargoInsuranceOnFile ? "On file" : "None on file", c.cargoInsuranceOnFile ? "" : "bad"));
  if (c.safetyRating) facts.push(fact("Safety rating", c.safetyRating));
  facts.push(fact("Inspections (24mo)", String(c.inspections24mo), c.inspections24mo === 0 ? "bad" : ""));
  if (c.crashes24mo > 0) facts.push(fact("Crashes (24mo)", String(c.crashes24mo), "bad"));
  if (c.dotIssued) facts.push(fact("Authority since", c.dotIssued));
  if (c.powerUnits != null) facts.push(fact("Fleet", `${c.powerUnits} trucks${c.drivers != null ? ` · ${c.drivers} drivers` : ""}`));
  if (c.fmcsaPhone) facts.push(fact("FMCSA phone", c.fmcsaPhone));

  return `<div class="facts">${facts.join("")}</div>`;
}

function renderVerdict(v: AuditVerdict) {
  verdictEl.hidden = false;
  const c = v.carrier;

  const tiles = c
    ? `<div class="tiles">
         <div class="tile"><div class="t-label">Risk score</div><div class="t-value">${c.riskScore ?? "—"}</div><div class="t-sub">0–100 · higher = riskier</div></div>
         <div class="tile"><div class="t-label">ISS*</div><div class="t-value">${c.issScore ?? "—"}</div><div class="t-sub">${esc(c.issTier ?? "est.")}</div></div>
       </div>`
    : "";

  const identity = c
    ? `<div class="identity">
         <div class="legal">${esc(c.legalName ?? "Unknown carrier")}</div>
         <div class="ids">DOT ${c.dotNumber}${c.mcNumber ? ` · ${esc(c.mcNumber)}` : ""}${c.physicalLocation ? ` · ${esc(c.physicalLocation)}` : ""}</div>
       </div>`
    : "";

  // Findings: tier-bumping signals first, info last.
  const order = { critical: 0, high: 1, caution: 2, info: 3 };
  const signals = [...v.signals].sort((a, b) => order[a.tier] - order[b.tier]);
  const findings = signals.length
    ? `<div class="section-h">What we found</div>
       <ul class="findings">${signals
         .map(
           (s) =>
             `<li class="finding ${s.tier}"><span class="f-dot"></span><div>` +
             `<div class="f-label">${esc(s.label)}</div>` +
             `<div class="f-detail">${esc(s.detail)}</div></div></li>`
         )
         .join("")}</ul>`
    : "";

  const basics =
    c && c.basicAlerts.length
      ? `<div class="section-h">FMCSA BASIC alerts</div>` +
        `<ul class="findings">${c.basicAlerts
          .map((b) => `<li class="finding high"><span class="f-dot"></span><div><div class="f-label">${esc(b)}</div><div class="f-detail">Over FMCSA's intervention threshold.</div></div></li>`)
          .join("")}</ul>`
      : "";

  verdictEl.className = `verdict tier-${v.tier}`;
  verdictEl.innerHTML =
    `<div class="verdict-head tier-${v.tier}">
       <div class="badge">${esc(v.tier)}</div>
       <div class="headline">${esc(TIER_HEADLINE[v.tier])}</div>
       <div class="summary">${esc(v.summary)}</div>
       ${tiles}
     </div>` +
    identity +
    (c ? carrierFacts(c) : "") +
    findings +
    basics +
    `<div class="generated">FMCSA snapshot · ${esc((v.generatedAt || "").slice(0, 10))}</div>`;
}

// ---- enrichment card (private tier) ----

function openSignIn() {
  void send({ type: "OPEN_SIGNIN" });
}

function renderLocked() {
  enrichmentEl.hidden = false;
  enrichmentEl.className = "enrichment locked";
  enrichmentEl.innerHTML =
    `<h3>Your relationship</h3>` +
    `<div class="lock-msg">Sign in to Augie to unlock, for this carrier:</div>` +
    `<ul class="lock-fields"><li>Lane history</li><li>Owning rep</li><li>Days since last shipment</li></ul>` +
    `<button class="signin-btn" type="button">Sign in to Augie</button>`;
  enrichmentEl.querySelector(".signin-btn")?.addEventListener("click", openSignIn);
}

function renderEnrichment(e: CarrierEnrichment) {
  enrichmentEl.hidden = false;
  enrichmentEl.className = "enrichment";

  if (!e.hasRelationship) {
    enrichmentEl.innerHTML =
      `<h3>Your relationship</h3><div class="lock-msg">No prior loads with this carrier in your book.</div>`;
    return;
  }

  const dslsClass = e.dsls == null ? "" : e.dsls <= 30 ? "dsls-fresh" : "dsls-stale";
  const dsls =
    e.dsls == null
      ? "—"
      : `${e.dsls} day${e.dsls === 1 ? "" : "s"} ago${e.lastShipmentDate ? ` · ${esc(e.lastShipmentDate)}` : ""}`;

  const lanes = e.lanes.length
    ? `<ul class="lanes">${e.lanes
        .map(
          (l) =>
            `<li><span class="lane-route">${esc(l.origin)} → ${esc(l.destination)}</span>` +
            `<span class="lane-meta">${l.count}×${l.lastDate ? ` · ${esc(l.lastDate)}` : ""}</span></li>`
        )
        .join("")}</ul>`
    : `<div class="lock-msg">No lane history on file.</div>`;

  enrichmentEl.innerHTML =
    `<h3>Your relationship</h3>` +
    `<div class="row"><span class="label">Last shipment</span><span class="value ${dslsClass}">${dsls}</span></div>` +
    `<div class="row"><span class="label">Owning rep</span><span class="value">${e.repOwner ? esc(e.repOwner.name) : "Unassigned"}</span></div>` +
    `<div class="row"><span class="label">Total loads</span><span class="value">${e.loadCount}</span></div>` +
    `<div class="row"><span class="label">Top lanes</span></div>` +
    lanes;
}

// ---- run a check ----

function renderResult(result: CheckResult) {
  statusEl.hidden = true;
  renderVerdict(result.verdict);

  if (result.enrichment) renderEnrichment(result.enrichment);
  else if (result.enrichmentError) {
    enrichmentEl.hidden = false;
    enrichmentEl.className = "enrichment locked";
    enrichmentEl.innerHTML =
      `<h3>Your relationship</h3><div class="lock-msg">${esc(result.enrichmentError)}</div>`;
  } else {
    renderLocked();
  }
}

async function runCheck() {
  recheckBtn.disabled = true;
  statusEl.hidden = false;
  statusEl.className = "status";
  statusEl.textContent = "Checking this page…";
  verdictEl.hidden = true;
  enrichmentEl.hidden = true;

  try {
    const res = await send<{ ok: boolean; result?: CheckResult; error?: string }>({ type: "RUN_CHECK" });
    if (!res.ok || !res.result) throw new Error(res.error || "Check failed.");
    renderResult(res.result);
  } catch (e) {
    statusEl.hidden = false;
    statusEl.className = "status error";
    statusEl.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    recheckBtn.disabled = false;
  }
}

// ---- wire up ----

recheckBtn.addEventListener("click", () => void runCheck());
authChip.addEventListener("click", () => {
  if (!authChip.classList.contains("signed-in")) openSignIn();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "AUTH_STATE_CHANGED") {
    renderAuth(msg as AuthStateInfo);
    // Signing in mid-session → re-run so the enrichment fills in.
    if ((msg as AuthStateInfo).isAuthenticated) void runCheck();
  }
});

async function init() {
  const auth = await send<{ ok: boolean } & AuthStateInfo>({ type: "GET_AUTH_STATE" });
  renderAuth(auth);
  void runCheck();
}

void init();
