/**
 * Background service worker — auth + orchestration.
 *
 * AUTH (no separate login): we read the augment-web session cookies
 * (`_session` / `_session-extended`) that app.goaugment.com already sets when
 * the user is signed in to Augie, decode the Bearer accessToken + claims, and
 * use them for the private-enrichment call. This is the exact pattern
 * @goaugment/browser-automation uses (its extension/src/background.ts). A user
 * who isn't signed in simply gets the public FMCSA audit — no prompt-wall.
 *
 * A CHECK does two things:
 *   1) PUBLIC tier — capture the active tab and POST it to the carrier-audit
 *      app's /api/check, which runs the FMCSA fraud audit and returns HTML.
 *      Works for everyone, no auth.
 *   2) PRIVATE tier (signed-in only) — call augment-services for this
 *      brokerage's lane history, rep owner, and days-since-last-shipment,
 *      keyed by the carrier identity the audit resolved. Scoped server-side to
 *      the token's brokerageKey; the client never asks for a brokerage.
 */

import type {
  AuditVerdict,
  AuthStateInfo,
  CarrierEnrichment,
  CheckResult,
  CheckRow,
  Environment,
  PageCapture,
  SessionUser,
} from "./types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const AUDIT_URL = "https://augment-carrier-audit.vercel.app";

const AUGMENT_WEB_URLS: Record<Environment, string> = {
  production: "https://app.goaugment.com",
  staging: "https://app.staging.goaugment.com",
};

// The authorized enrichment endpoint (Option A — augment-services owns the
// customer-private data). Lives in load-service, served via the public API
// gateway; returns the CarrierEnrichment shape directly.
// See augment-services PR #12107.
// Per-service host (not a shared api.* gateway): load-service is exposed at
// load.<env>.goaugment.com (env infix: ".prod"/".staging"; bare
// load.goaugment.com does NOT resolve). Both hosts are public + resolve;
// staging is CONFIRMED end-to-end.
const ENRICHMENT_BASE: Record<Environment, string> = {
  production: "https://load.prod.goaugment.com",
  staging: "https://load.staging.goaugment.com",
};
const ENRICHMENT_PATH = "/unstable/loads/carrier-history";
// Environments where we call the live endpoint instead of the stub. Staging is
// deployed + confirmed (augment-services PR #12107). Production stays stubbed
// until load-service (PR #12107) is deployed to prod and security review
// clears — then add "production" here. The prod host is already correct above.
// The stub keeps the prod UI demoable until then.
const LIVE_ENRICHMENT_ENVIRONMENTS = new Set<Environment>(["staging"]);

const SESSION_COOKIE = "_session";
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

interface AuthState {
  accessToken: string | null;
  user: SessionUser | null;
  expiresAt: number | null;
}

let authState: AuthState = { accessToken: null, user: null, expiresAt: null };

async function getEnvironment(): Promise<Environment> {
  const { environment } = await chrome.storage.local.get("environment");
  return environment === "staging" ? "staging" : "production";
}

/** Decode a `base64json.signature` cookie value to its JSON payload. */
function decodeCookie(value: string): unknown {
  const b64 = decodeURIComponent(value).split(".")[0];
  return JSON.parse(atob(b64));
}

/**
 * Load auth from the augment-web cookies for the given env. Returns false (and
 * clears state) if no valid, unexpired session is present.
 */
async function loadAuthForEnv(env: Environment): Promise<boolean> {
  const url = AUGMENT_WEB_URLS[env];
  try {
    const sessionCookie = await chrome.cookies.get({ url, name: SESSION_COOKIE });
    const extendedCookie = await chrome.cookies.get({
      url,
      name: `${SESSION_COOKIE}-extended`,
    });
    if (!sessionCookie?.value || !extendedCookie?.value) return false;

    const session = decodeCookie(sessionCookie.value) as {
      accessToken?: string;
      expiresAt?: number;
    };
    const extended = decodeCookie(extendedCookie.value) as { user?: SessionUser };

    if (
      !session?.accessToken ||
      typeof session.expiresAt !== "number" ||
      !extended?.user?.claims?.brokerageKey
    ) {
      return false;
    }
    if (session.expiresAt < Date.now() + EXPIRY_BUFFER_MS) return false;

    authState = {
      accessToken: session.accessToken,
      user: extended.user,
      expiresAt: session.expiresAt,
    };
    return true;
  } catch (e) {
    console.warn("[Augie] cookie decode failed", e);
    return false;
  }
}

/** Try the configured env, then the other one (so staging testers Just Work). */
async function loadAuthFromCookies(): Promise<boolean> {
  const env = await getEnvironment();
  if (await loadAuthForEnv(env)) return true;
  const other: Environment = env === "production" ? "staging" : "production";
  if (await loadAuthForEnv(other)) return true;
  authState = { accessToken: null, user: null, expiresAt: null };
  return false;
}

function isAuthenticated(): boolean {
  return (
    !!authState.accessToken &&
    !!authState.expiresAt &&
    authState.expiresAt > Date.now() + EXPIRY_BUFFER_MS
  );
}

function authStateInfo(): AuthStateInfo {
  const authed = isAuthenticated();
  return {
    isAuthenticated: authed,
    user: authed ? authState.user : null,
    brokerageKey: authed ? authState.user?.claims.brokerageKey ?? null : null,
  };
}

// Refresh auth whenever the session cookie changes (login / logout / refresh).
chrome.cookies.onChanged.addListener((info) => {
  if (info.cookie.name === SESSION_COOKIE && info.cookie.domain.includes("goaugment.com")) {
    void loadAuthFromCookies().then(() => {
      chrome.runtime
        .sendMessage({ type: "AUTH_STATE_CHANGED", ...authStateInfo() })
        .catch(() => { /* no panel open */ });
    });
  }
});

// ---------------------------------------------------------------------------
// Page capture
// ---------------------------------------------------------------------------

async function captureActiveTab(): Promise<{ tabId: number; capture: PageCapture }> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.id) throw new Error("No active tab to check.");
  if (tab.url && /^(chrome|edge|about|chrome-extension):/i.test(tab.url)) {
    throw new Error("Open a load, email, or carrier page, then run the check.");
  }
  const tabId = tab.id;

  const ask = () =>
    chrome.tabs.sendMessage<{ type: string }, { ok: boolean; capture?: PageCapture; error?: string }>(
      tabId,
      { type: "CAPTURE_PAGE" }
    );

  let res: { ok: boolean; capture?: PageCapture; error?: string };
  try {
    res = await ask();
  } catch {
    // Page was open before the extension loaded → inject the content script.
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    res = await ask();
  }
  if (!res?.ok || !res.capture) throw new Error(res?.error || "Could not read the page.");
  return { tabId, capture: res.capture };
}

// ---------------------------------------------------------------------------
// Public audit (carrier-audit /api/check)
// ---------------------------------------------------------------------------

async function runAudit(
  capture: PageCapture
): Promise<{ verdict: AuditVerdict; checks: CheckRow[]; dot: string | null; mc: string | null }> {
  const res = await fetch(`${AUDIT_URL}/api/check?format=json`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(capture),
  });
  if (!res.ok) throw new Error(`Audit failed (${res.status}).`);
  const data = (await res.json()) as {
    verdict: AuditVerdict;
    checks: CheckRow[];
    dot: string | null;
    mc: string | null;
  };
  return { verdict: data.verdict, checks: data.checks ?? [], dot: data.dot, mc: data.mc };
}

// ---------------------------------------------------------------------------
// Private enrichment (augment-services, scoped to token's brokerageKey)
// ---------------------------------------------------------------------------

function stubEnrichment(dot: string | null, mc: string | null): CarrierEnrichment {
  // Deterministic mock so the signed-in UI is demoable on environments not yet
  // in LIVE_ENRICHMENT_ENVIRONMENTS (currently production).
  if (!dot && !mc) {
    return { hasRelationship: false, dsls: null, lastShipmentDate: null, repOwner: null, lanes: [], loadCount: 0 };
  }
  return {
    hasRelationship: true,
    dsls: 47,
    lastShipmentDate: new Date(Date.now() - 47 * 864e5).toISOString().slice(0, 10),
    repOwner: { name: "Dana Whitfield", email: "dana.whitfield@example.com" },
    loadCount: 134,
    lanes: [
      { origin: "Chicago, IL", destination: "Dallas, TX", count: 18, lastDate: "2026-04-12", avgRate: 3180 },
      { origin: "Chicago, IL", destination: "Atlanta, GA", count: 11, lastDate: "2026-03-28", avgRate: 2640 },
      { origin: "Joliet, IL", destination: "Memphis, TN", count: 7, lastDate: "2026-03-09", avgRate: 2510 },
      { origin: "Chicago, IL", destination: "Kansas City, MO", count: 6, lastDate: "2026-02-22", avgRate: 1980 },
    ],
  };
}

async function fetchEnrichment(dot: string | null, mc: string | null): Promise<CarrierEnrichment> {
  const env = await getEnvironment();
  if (!LIVE_ENRICHMENT_ENVIRONMENTS.has(env)) return stubEnrichment(dot, mc);

  const params = new URLSearchParams();
  if (dot) params.set("dotNumber", dot.replace(/\D/g, ""));
  if (mc) params.set("mcNumber", mc.replace(/\D/g, ""));
  // Optional brokerage override (testing/cross-tenant). Normally unset → the
  // endpoint scopes to the signed-in user's own brokerage. The endpoint
  // enforces access, so this can only widen to brokerages the user is
  // authorized for.
  const { brokerageKey } = await chrome.storage.local.get("brokerageKey");
  if (brokerageKey) params.set("brokerageKey", String(brokerageKey));
  const res = await fetch(`${ENRICHMENT_BASE[env]}${ENRICHMENT_PATH}?${params}`, {
    headers: { Authorization: `Bearer ${authState.accessToken ?? ""}` },
  });
  if (res.status === 401 || res.status === 403) {
    authState = { accessToken: null, user: null, expiresAt: null };
    throw new Error("Augie session expired — sign in again.");
  }
  if (!res.ok) throw new Error(`Enrichment unavailable (${res.status}).`);
  return (await res.json()) as CarrierEnrichment;
}

// ---------------------------------------------------------------------------
// Full check
// ---------------------------------------------------------------------------

async function runCheck(): Promise<CheckResult> {
  const { capture } = await captureActiveTab();
  const { verdict, checks, dot, mc } = await runAudit(capture);

  let enrichment: CarrierEnrichment | null = null;
  let enrichmentError: string | null = null;
  if (isAuthenticated() || (await loadAuthFromCookies())) {
    try {
      enrichment = await fetchEnrichment(dot, mc);
    } catch (e) {
      enrichmentError = e instanceof Error ? e.message : String(e);
    }
  }
  return { verdict, checks, dot, mc, enrichment, enrichmentError };
}

// ---------------------------------------------------------------------------
// Side panel + messaging
// ---------------------------------------------------------------------------

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

void loadAuthFromCookies();

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "GET_AUTH_STATE":
          await loadAuthFromCookies();
          sendResponse({ ok: true, ...authStateInfo() });
          return;
        case "REFRESH_AUTH":
          await loadAuthFromCookies();
          sendResponse({ ok: true, ...authStateInfo() });
          return;
        case "RUN_CHECK":
          sendResponse({ ok: true, result: await runCheck() });
          return;
        case "OPEN_SIGNIN": {
          // No in-extension login: send the user to the Augie web app to sign
          // in normally. The cookie that drops there is picked up by
          // chrome.cookies.onChanged, which flips us to the signed-in tier.
          const env = await getEnvironment();
          await chrome.tabs.create({ url: AUGMENT_WEB_URLS[env] });
          sendResponse({ ok: true });
          return;
        }
        default:
          sendResponse({ ok: false, error: `Unknown message: ${String(msg?.type)}` });
      }
    } catch (e) {
      sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  })();
  return true; // async sendResponse
});
