/**
 * Shared types for the Augie Carrier Check extension.
 *
 * The auth shapes mirror the augment-web session cookies, exactly as the
 * `@goaugment/browser-automation` extension reads them — see that package's
 * extension/src/types.ts. We piggyback on the same `_session` /
 * `_session-extended` cookies so a signed-in Augie user needs no separate
 * login here.
 */

export type Environment = "production" | "staging";

/** Claims embedded in the `_session` cookie's accessToken payload. */
export interface UserClaims {
  userId: string;
  /** Tenant key — scopes all customer-private enrichment to one brokerage. */
  brokerageKey: string;
  roles: string[];
  email: string;
}

export interface UserProfile {
  displayName: string;
  email: string;
}

export interface SessionUser {
  profile: UserProfile;
  claims: UserClaims;
}

/** Decoded `_session` cookie (base64 JSON before the `.signature`). */
export interface SessionCookieData {
  accessToken: string;
  expiresAt: number;
  sessionId: string;
}

/** Decoded `_session-extended` cookie. */
export interface SessionExtendedData {
  refreshToken: string;
  user: SessionUser;
}

export interface AuthStateInfo {
  isAuthenticated: boolean;
  user: SessionUser | null;
  /** Present only so the side panel can show "signed in as"; never logged. */
  brokerageKey: string | null;
}

/** What the content script scrapes from the page (mirrors the bookmarklet). */
export interface PageCapture {
  html: string;
  url: string;
  sel: string;
  fields: string;
  /** Visible rendered text (document.body.innerText) — only what's on screen,
   *  excluding hidden/collapsed DOM. The server scans this for DOT/MC/lane. */
  text: string;
}

/** One lane the customer has historically run this carrier on. */
export interface CarrierLane {
  origin: string;
  destination: string;
  count: number;
  lastDate: string | null;
  /** Average linehaul on this lane (USD), when known. */
  avgRate: number | null;
  /** Most recent linehaul on this lane (USD), when known. */
  lastRate: number | null;
  /** Last rate vs the lane's prior average. */
  trend: "up" | "down" | "flat" | null;
}

/** Customer-private enrichment, scoped to the signed-in user's brokerage. */
export interface CarrierEnrichment {
  hasRelationship: boolean;
  dsls: number | null;
  lastShipmentDate: string | null;
  /** First shipment date (YYYY-MM-DD) in the window — for "loads since …". */
  firstShipmentDate: string | null;
  /** On-time pickup / delivery % (0–100), or null when too few timestamps. */
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  repOwner: { name: string; email: string | null } | null;
  /** Loads owned by the rep (the "N of M" share); 0 when no rep. */
  repLoadCount: number;
  lanes: CarrierLane[];
  loadCount: number;
}

// ---- public audit verdict (subset of the server's Verdict we render) ----

export type VerdictTier = "Critical" | "High" | "Caution" | "Clean";
export type SignalTier = "critical" | "high" | "caution" | "info";

export interface VerdictSignal {
  tier: SignalTier;
  category: string;
  label: string;
  detail: string;
}

/** The fields of lib/email/types.ts `VerdictCarrierSummary` the panel shows. */
export interface VerdictCarrier {
  dotNumber: number;
  mcNumber: string | null;
  legalName: string | null;
  physicalLocation: string | null;
  dotIssued: string | null;
  powerUnits: number | null;
  drivers: number | null;
  operatingArea: string | null;
  riskScore: number | null;
  issScore: number | null;
  issTier: string | null;
  allowedToOperate: string | null;
  statusCode: string | null;
  mostRecentRevocationDate: string | null;
  bipdInsurer: string | null;
  bipdAmount: number | null;
  cargoInsuranceOnFile: boolean;
  safetyRating: string | null;
  inspections24mo: number;
  crashes24mo: number;
  fmcsaPhone: string | null;
  /** Full FMCSA-registered email address, when present. */
  fmcsaEmail: string | null;
  /** Up to 3 self-declared cargo types from MCS-150. */
  cargoCapabilities: string[];
  /** Primary company officer (MCS-150 officer_1), for out-of-band verification. */
  companyOfficer: string | null;
  basicAlerts: string[];
  /** The 7 FMCSA SMS BASICs: peer percentile (0–100, higher = worse; null when
   *  FMCSA publishes none) + whether FMCSA set an alert. */
  basics: Array<{ name: string; percentile: number | null; alert: boolean }>;
}

export interface AuditVerdict {
  tier: VerdictTier;
  summary: string;
  carrier: VerdictCarrier | null;
  signals: VerdictSignal[];
  generatedAt: string;
}

/** One safety check the audit ran (mirrors format-reply-html `CheckRow`). */
export type CheckStatus = "passed" | "failed" | "skipped" | "info";
export interface CheckRow {
  status: CheckStatus;
  label: string;
  detail: string;
}

/** Result of a full check: public verdict + (optional) private enrichment. */
export interface CheckResult {
  verdict: AuditVerdict;
  checks: CheckRow[];
  dot: string | null;
  mc: string | null;
  /** null = not signed in (public tier); object = enrichment attached. */
  enrichment: CarrierEnrichment | null;
  /** Set when signed in but enrichment couldn't be fetched (service down etc). */
  enrichmentError: string | null;
}

// ---- runtime message protocol (sidepanel <-> background) ----

export type BgRequest =
  | { type: "GET_AUTH_STATE" }
  | { type: "REFRESH_AUTH" }
  | { type: "RUN_CHECK"; manual?: string };

export type BgResponse =
  | ({ ok: true } & AuthStateInfo)
  | { ok: true; result: CheckResult }
  | { ok: false; error: string };
