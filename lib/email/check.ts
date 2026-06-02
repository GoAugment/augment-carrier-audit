/**
 * Deterministic verdict pipeline for audit@augie.ai.
 *
 * Five evaluators run against the parsed email + FMCSA data. Each returns a
 * list of Signals (tier + label + detail). The verdict tier is the worst
 * signal that fired. `info` signals are surfaced as evidence but don't bump
 * the verdict tier, they're context the broker should know.
 *
 * Why deterministic (no LLM here)? Two reasons:
 *   1. Testable. We can hand-construct any ExtractedEmail and verify the
 *      verdict. No flakiness from prompt drift.
 *   2. Defensible. "Why did this email get marked High?" maps to specific
 *      rule hits in this file, not an opaque model decision.
 */
import { fetchCarriers, fetchDotByMc, type FmcsaCarrier } from "../fmcsa";
import { getRule } from "../rules";
import { fetchIdentity, findIdentityByPhone, cargoLabels, type CarrierIdentity } from "../fmcsa-identity";
import { analyze } from "../analyzer";
import { getCutoffs, type AxisKey, type PeerGroup } from "../thresholds";
import { checkDomainAuth } from "./dns-check";
import laneLiability from "../data/lane-liability.json";
import type {
  ExtractedEmail,
  Signal,
  SignalTier,
  Verdict,
  VerdictCarrierSummary,
  VerdictCoverage,
  VerdictTier,
} from "./types";

// ---------- constants ----------

/** Generic / consumer email providers. Used by the email-authenticity
 *  evaluator to soften the verdict ("free email isn't a hard flag unless
 *  the carrier's FMCSA record shows a business domain"). */
const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "aol.com",
  "icloud.com", "live.com", "msn.com", "yandex.com", "protonmail.com",
  "me.com", "mac.com", "comcast.net", "sbcglobal.net", "verizon.net",
  "att.net", "cox.net", "bellsouth.net", "earthlink.net",
]);

/** Company-name fuzzy-match floor. Below this, we flag mismatch.
 *  Token-overlap with token-frequency weighting; "Schneider National Carriers
 *  Inc" vs "Schneider National Inc" = ~0.80, vs "Schneider Dispatch LLC" = ~0.30. */
const COMPANY_NAME_MATCH_THRESHOLD = 0.6;

// ---------- top-level entry ----------

// Per-instance verdict cache. The verdict is a pure function of the FMCSA
// snapshot (static) + these request inputs, so caching by them makes a repeat
// check of the same carrier/lane/sender instant. Short TTL keeps DNS drift
// bounded. Bypassed automatically for distinct inputs.
const verdictCache = new Map<string, { v: Verdict; exp: number }>();
const VERDICT_TTL_MS = 15 * 60 * 1000;

function verdictKey(e: ExtractedEmail): string {
  return [
    e.identity_claims.dot_number ?? "",
    e.identity_claims.mc_number ?? "",
    e.lane.origin_state ?? "",
    e.lane.destination_state ?? "",
    e.lane.is_hazmat_load ? "H" : "",
    (e.sender_metadata.sender_email ?? "").toLowerCase(),
    (e.sender_metadata.reply_to_domain ?? "").toLowerCase(),
    (e.sender_candidates ?? []).join(","),
    (e.phone_candidates ?? []).join(","),
    e.emailAuth ? `${e.emailAuth.spf}/${e.emailAuth.dkim}/${e.emailAuth.dmarc}/${e.emailAuth.dkimDomain ?? ""}` : "",
  ].join("|");
}

export async function checkCarrierEmail(e: ExtractedEmail): Promise<Verdict> {
  const key = verdictKey(e);
  const cached = verdictCache.get(key);
  if (cached && cached.exp > Date.now()) return cached.v;
  const verdict = await computeVerdict(e);
  if (verdictCache.size < 5000) {
    verdictCache.set(key, { v: verdict, exp: Date.now() + VERDICT_TTL_MS });
  }
  return verdict;
}

// Per-call phase timings (ms), for diagnosing where prod latency goes. Read by
// /api/check (Server-Timing header + ?debug). Overwritten each computeVerdict;
// only meaningful right after a cache-miss call.
export let lastTimings: Record<string, number> = {};

async function computeVerdict(e: ExtractedEmail): Promise<Verdict> {
  const T: Record<string, number> = {};
  let _m = Date.now();
  const mark = (k: string) => {
    T[k] = Date.now() - _m;
    _m = Date.now();
  };
  const dotStr = e.identity_claims.dot_number;
  let dot = dotStr ? parseInt(dotStr.replace(/\D/g, ""), 10) : NaN;

  // Fall back to MC lookup when DOT is missing. Many small-carrier outreach
  // emails reference only "MC-133655" without a DOT, the parquet has both,
  // so we can resolve MC → DOT and continue with the full verdict pipeline
  // instead of bailing to Caution.
  if ((!Number.isFinite(dot) || dot <= 0) && e.identity_claims.mc_number) {
    const resolved = await fetchDotByMc(e.identity_claims.mc_number);
    if (resolved && resolved > 0) {
      dot = resolved;
    }
  }
  mark("mcResolve");

  // Still no DOT after MC fallback. Can't cross-check against FMCSA.
  if (!Number.isFinite(dot) || dot <= 0) {
    return verdictNoDot(e);
  }

  const [carriers, identities] = await Promise.all([
    fetchCarriers([dot]),
    fetchIdentity([dot]),
  ]);
  mark("fetchCarrierIdentity");
  const carrier = carriers.get(dot);
  const identity = identities.get(dot);

  // DOT claimed but not found in our parquet. Either dormant (filtered out of
  // the 2.08M-row universe), a typo, or a fabricated number.
  if (!carrier) {
    return verdictDotNotFound(dot, e);
  }

  // Track what we actually checked vs skipped, verdict summary uses this
  // to set the right expectation with the broker. A "Clean" verdict from a
  // sparse email is not the same as a "Clean" verdict from a rich email
  // where every check ran with data.
  const coverage: VerdictCoverage = {
    carrier_resolved: true,
    audit_tier: true, // always runs when carrier is resolved
    mc_match_checked: !!e.identity_claims.mc_number && !!carrier.mcNumber,
    name_match_checked: !!e.identity_claims.claimed_company_name && !!carrier.legalName,
    phone_match_checked: !!e.identity_claims.claimed_phone && !!identity?.phone,
    // Only a real single sender counts as a domain check here; the captured-
    // page multi-candidate match surfaces as its own info signal instead.
    sender_domain_match_checked: !!e.sender_metadata.sender_email_domain && !!identity?.emailDomain,
    lane_viability_checked:
      !!e.lane.origin_state && !!e.lane.destination_state && !!identity,
    chameleon_cluster_checked: !!identity?.phone,
    // True whenever we have a sender domain, the DNS checks run on
    // that domain. We no longer try to verify per-message SPF/DKIM/DMARC
    // because inline forwards make those headers unreliable.
    email_auth_checked: domainAuthApplicable(e),
    hazmat_match_checked: !!e.lane.is_hazmat_load && !!identity,
  };

  const signals: Signal[] = [];
  signals.push(...evalAuditTier(carrier, dot));
  mark("evalAuditTier");
  signals.push(...evalIdentityCoherence(e, carrier, identity));
  signals.push(...evalSenderCandidates(e, identity));
  signals.push(...evalPhoneCandidates(e, identity));
  signals.push(...evalMessageAuth(e, identity));
  signals.push(...evalLaneViability(e, identity));
  signals.push(...evalLaneCoverage(e, carrier));
  signals.push(...evalHazmat(e, identity, carrier));
  signals.push(...evalChameleonAddressCluster(carrier));
  if (identity) {
    signals.push(...(await evalChameleonCluster(identity, dot)));
  }
  mark("chameleonPhone");
  signals.push(...(await evalEmailAuthenticity(e, identity)));
  mark("emailAuth");

  const verdict = composeVerdict(carrier, identity, signals, coverage);
  mark("composeVerdict");
  lastTimings = T;
  return verdict;
}

// ============================================================================
// Evaluator 1: Audit tier (reuses existing analyzer)
// ============================================================================

/**
 * Run the existing carrier-audit analyzer.ts against this carrier and map
 * its tier to a Signal. Inherits ALL existing scoring: P95 statistical
 * outliers, recent revocations, lapsed insurance, new-authority Critical,
 * chameleon-pattern cluster, etc. No new logic, just a tier mapping.
 */
function evalAuditTier(carrier: FmcsaCarrier, dot: number): Signal[] {
  const result = analyze(
    [{ dot, loadId: "email-check" }],
    new Map([[dot, carrier]])
  );
  const row = result.rows[0];
  if (!row) return [];

  const reasonsText = row.reasons.length
    ? row.reasons.map((r) => r.label).join(", ")
    : "no specific reasons surfaced";

  // These four "Carrier in X tier" signals are tier echos of the analyzer's
  // overall verdict, not standalone rules. They aggregate the analyzer's
  // individual rule findings (insurance lapsed, prior-revoke, address
  // cluster, etc.) into a single carrier-tier line for brokers who want
  // the bottom line. Labels stay inline because the actual rules (which
  // ARE in the registry) are the ones the analyzer fired to produce the
  // tier; surfacing those four wrappers in the methodology page would be
  // duplicative and confusing.
  switch (row.riskLevel) {
    case "Critical":
      return [
        {
          category: "audit_tier",
          tier: "critical",
          label: "Carrier in Critical tier",
          detail: `Existing carrier audit flags this DOT as Critical: ${reasonsText}.`,
        },
      ];
    case "High":
      return [
        {
          category: "audit_tier",
          tier: "high",
          label: "Carrier in High tier",
          detail: `Existing carrier audit flags this DOT as High: ${reasonsText}.`,
        },
      ];
    case "Medium":
      return [
        {
          category: "audit_tier",
          tier: "caution",
          label: "Carrier in Medium tier",
          detail: `Existing carrier audit flags this DOT as Medium: ${reasonsText}. Context only.`,
        },
      ];
    case "Low":
    default:
      return [];
  }
}

// ============================================================================
// Evaluator 2: Identity coherence
// ============================================================================

/**
 * Cross-check what the email CLAIMS against what FMCSA RECORDS.
 *
 * The pattern this catches: an email pitches a load using DOT 264184
 * (Schneider) but the email comes from `schneider-dispatch@gmail.com`,
 * with phone numbers and an MC# that don't match FMCSA. That's an
 * impersonation attempt where the underlying DOT is legitimate but the
 * email doesn't belong to that carrier.
 */
function evalIdentityCoherence(
  e: ExtractedEmail,
  carrier: FmcsaCarrier,
  identity: CarrierIdentity | undefined
): Signal[] {
  const signals: Signal[] = [];

  // --- MC# match ---
  const claimedMc = normalizeMc(e.identity_claims.mc_number);
  const fmcsaMc = normalizeMc(carrier.mcNumber);
  if (claimedMc && fmcsaMc && claimedMc !== fmcsaMc) {
    signals.push({
      category: "identity_coherence",
      tier: "critical",
      label: getRule("mc-number-mismatch").label,
      detail: `Email claims ${e.identity_claims.mc_number}, FMCSA has ${carrier.mcNumber} for DOT ${carrier.dotNumber}.`,
    });
  }

  // --- Sender email/domain match ---
  // For business-domain FMCSA records we compare domains (sufficient signal).
  // For free-email FMCSA records (gmail.com, etc.) we compare the FULL email
  // address because "matches gmail.com" tells us nothing, every Gmail user
  // matches. The local-part is what identifies the sender.
  const senderEmail = e.sender_metadata.sender_email?.toLowerCase() ?? "";
  const senderDomain = (e.sender_metadata.sender_email_domain ?? "").toLowerCase();
  // Only run the single-sender comparison when there's an authoritative sender
  // (a real From: on an email). On a captured page with no single sender,
  // senderDomain is empty and the multi-candidate check (evalSenderCandidates)
  // handles it instead — comparing an empty sender here would false-flag.
  if (senderDomain && identity?.email) {
    const fmcsaEmail = identity.email.toLowerCase();
    const fmcsaDomain = identity.emailDomain?.toLowerCase() ?? "";
    const fmcsaIsFree = FREE_EMAIL_DOMAINS.has(fmcsaDomain);

    if (fmcsaIsFree) {
      // Compare full local-part@domain. Sender's full address required here
      //, if Stage 1 didn't pull it (older payloads), fall back to a
      // skip-coverage rather than a misleading domain-only pass.
      if (senderEmail && senderEmail !== fmcsaEmail) {
        signals.push({
          category: "identity_coherence",
          tier: "high",
          label: getRule("sender-domain-mismatch").label,
          detail: `Email from ${senderEmail}, FMCSA records this carrier at ${fmcsaEmail}. Free-mail domain match alone is meaningless: the local-part differs, which is the actual identifier on shared providers.`,
        });
      }
    } else if (fmcsaDomain !== senderDomain) {
      const senderIsFree = FREE_EMAIL_DOMAINS.has(senderDomain);
      const carrierName = carrier.legalName ?? "this carrier";
      if (senderIsFree) {
        signals.push({
          category: "identity_coherence",
          tier: "high",
          label: getRule("sender-domain-mismatch").label,
          detail: `Email comes from ${senderDomain}, but FMCSA records ${carrierName} at ${fmcsaDomain}. Possible impersonation. Verify by calling the FMCSA-registered phone before tendering.`,
        });
      } else {
        signals.push({
          category: "identity_coherence",
          tier: "high",
          label: getRule("sender-domain-mismatch").label,
          detail: `Email comes from ${senderDomain}, but FMCSA records ${carrierName} at ${fmcsaDomain}. Verify identity through another channel before tendering.`,
        });
      }
    }
  } else if (senderDomain && identity?.emailDomain) {
    // FMCSA has domain only (older data?), fall back to domain compare.
    const fmcsa = identity.emailDomain.toLowerCase();
    if (fmcsa !== senderDomain) {
      signals.push({
        category: "identity_coherence",
        tier: "high",
        label: getRule("sender-domain-mismatch").label,
        detail: `Email comes from ${senderDomain}, but FMCSA records ${carrier.legalName ?? "this carrier"} at ${fmcsa}. Verify identity before tendering.`,
      });
    }
  } else if (FREE_EMAIL_DOMAINS.has(senderDomain)) {
    // FMCSA has no email on file AND sender is using free email. Surface
    // as info, too common in small-carrier population to flag.
    signals.push({
      category: "identity_coherence",
      tier: "info",
      label: getRule("sender-free-email-no-fmcsa-comparison").label,
      detail: `Sender uses ${e.sender_metadata.sender_email_domain} and FMCSA has no email on file. Common for owner-operators; verify by phone if uncertain.`,
    });
  }

  // --- Company name fuzzy match ---
  const claimedName = e.identity_claims.claimed_company_name;
  if (claimedName && carrier.legalName) {
    const score = nameSimilarity(claimedName, carrier.legalName);
    if (score < COMPANY_NAME_MATCH_THRESHOLD) {
      signals.push({
        category: "identity_coherence",
        tier: "high",
        label: getRule("company-name-mismatch").label,
        detail: `Email claims "${claimedName}", DOT ${carrier.dotNumber} is registered to "${carrier.legalName}".`,
      });
    }
  }

  // --- Phone match ---
  const claimedPhone = digitsOnly(e.identity_claims.claimed_phone);
  const fmcsaPhone = digitsOnly(identity?.phone);
  if (claimedPhone && fmcsaPhone && claimedPhone !== fmcsaPhone) {
    // Phones change more often than other identity fields. Soft flag.
    signals.push({
      category: "identity_coherence",
      tier: "caution",
      label: getRule("phone-mismatch").label,
      detail: `Email lists ${e.identity_claims.claimed_phone}, FMCSA has ${identity?.phone}. Could be a new number; verify if unsure.`,
    });
  }

  return signals;
}

// ============================================================================
// Evaluator 2b: Sender among page candidates (captured-page path)
// ============================================================================

/**
 * Multi-email check for the captured-page (bookmarklet) path. A page — a TMS
 * load or a carrier contact directory — can list several emails (customer,
 * broker, carrier dispatch), so instead of betting on one "sender" we check
 * whether the carrier's FMCSA-registered email/domain appears among ALL the
 * emails we extracted. Only runs when there's no single authoritative sender
 * (evalIdentityCoherence handles that real-From: case). Never hard-flags a
 * mismatch — the carrier's real email may simply not be on the page — so it's
 * a positive when a match exists and a soft "verify" note when none do.
 */
function evalSenderCandidates(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined
): Signal[] {
  // An authoritative single sender is handled by evalIdentityCoherence.
  if (e.sender_metadata.sender_email) return [];
  const cands = Array.from(
    new Set((e.sender_candidates ?? []).map((c) => c.toLowerCase().trim()))
  ).filter((c) => c.includes("@"));
  if (cands.length === 0) return [];

  const fmcsaEmail = identity?.email?.toLowerCase() ?? "";
  const fmcsaDomain = identity?.emailDomain?.toLowerCase() ?? "";
  if (!fmcsaEmail && !fmcsaDomain) return []; // nothing to match against

  const fmcsaIsFree = FREE_EMAIL_DOMAINS.has(fmcsaDomain);
  const domainOf = (a: string) => a.split("@").pop() ?? "";
  const match = fmcsaIsFree
    ? cands.find((c) => c === fmcsaEmail)
    : cands.find((c) => domainOf(c) === fmcsaDomain);

  const n = cands.length;
  // NB: labels avoid the words the reply's Context filter strips
  // ("matches"/"registered"/"active"/…), so these info signals actually render.
  if (match) {
    return [
      {
        category: "email_authenticity",
        tier: "info",
        label: "Carrier email found among page contacts",
        detail: fmcsaIsFree
          ? `One of the ${n} email${n === 1 ? "" : "s"} on the page (${match}) is the address FMCSA has on file for this carrier.`
          : `One of the ${n} email${n === 1 ? "" : "s"} on the page (${match}) is on the carrier's FMCSA email domain (${fmcsaDomain}).`,
      },
    ];
  }
  return [
    {
      category: "email_authenticity",
      tier: "info",
      label: "Carrier email not among page contacts",
      detail: fmcsaIsFree
        ? `None of the ${n} email${n === 1 ? "" : "s"} found on the page are the address FMCSA has on file (${fmcsaEmail}). The carrier's own email may not be listed here — verify out-of-band before tendering.`
        : `None of the ${n} email${n === 1 ? "" : "s"} found on the page are on the carrier's FMCSA email domain (${fmcsaDomain}). The carrier's own email may not be listed here — verify out-of-band before tendering.`,
    },
  ];
}

// ============================================================================
// Evaluator 2c: Phone among page candidates (captured-page path)
// ============================================================================

/**
 * Phone counterpart to evalSenderCandidates. A captured page lists several
 * phone numbers (customer, broker, carrier), so instead of betting on one
 * "claimed phone" we check whether the carrier's FMCSA-registered phone is
 * among ALL the numbers on the page. Match → positive info; none → soft
 * "verify" info. Never a hard flag (the carrier's number may not be listed).
 * Only runs when there's no single claimed phone (the inbound-email path sets
 * one from the signature and is handled by evalIdentityCoherence).
 */
function fmtPhone(d: string): string {
  const x = d.slice(-10);
  return x.length === 10 ? `(${x.slice(0, 3)}) ${x.slice(3, 6)}-${x.slice(6)}` : d;
}
function evalPhoneCandidates(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined
): Signal[] {
  if (e.identity_claims.claimed_phone) return []; // single claimed phone handled elsewhere
  const fmcsa10 = (identity?.phone ?? "").replace(/\D/g, "").slice(-10);
  if (fmcsa10.length !== 10) return []; // no FMCSA phone to match against
  const cands = Array.from(
    new Set(
      (e.phone_candidates ?? [])
        .map((c) => c.replace(/\D/g, "").slice(-10))
        .filter((c) => c.length === 10)
    )
  );
  if (cands.length === 0) return [];

  const n = cands.length;
  if (cands.includes(fmcsa10)) {
    return [
      {
        category: "identity_coherence",
        tier: "info",
        label: "Carrier phone found among page contacts",
        detail: `One of the ${n} phone number${n === 1 ? "" : "s"} on the page is the number FMCSA has on file for this carrier (${fmtPhone(fmcsa10)}).`,
      },
    ];
  }
  return [
    {
      category: "identity_coherence",
      tier: "info",
      label: "Carrier phone not among page contacts",
      detail: `None of the ${n} phone number${n === 1 ? "" : "s"} on the page are the number FMCSA has on file for this carrier (${fmtPhone(fmcsa10)}). The carrier's own line may not be listed here — verify out-of-band before tendering.`,
    },
  ];
}

// ============================================================================
// Evaluator 2d: Per-message email authentication (SPF/DKIM/DMARC)
// ============================================================================

/**
 * Surface per-message SPF/DKIM/DMARC when the captured page exposed them (Gmail
 * "Show original" / details). Meaningful HERE because the bookmarklet reads the
 * actually-received message — no forwarding to launder the headers. DKIM's
 * signing domain is cryptographically verified, so a DKIM pass whose domain
 * matches the carrier's FMCSA domain is strong proof the email came from that
 * carrier; a DKIM/DMARC fail is a spoofing flag.
 */
function evalMessageAuth(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined
): Signal[] {
  const a = e.emailAuth;
  if (!a) return [];
  const out: Signal[] = [];

  if (a.dkim === "fail" || a.dmarc === "fail") {
    out.push({
      category: "email_authenticity",
      tier: "high",
      label: "Message failed DKIM/DMARC authentication",
      detail: `This message ${a.dkim === "fail" ? "failed DKIM" : ""}${a.dkim === "fail" && a.dmarc === "fail" ? " and " : ""}${a.dmarc === "fail" ? "failed DMARC" : ""}. The From address may be spoofed — verify the carrier through another channel before tendering.`,
    });
    return out;
  }
  if (a.spf === "fail") {
    out.push({
      category: "email_authenticity",
      tier: "caution",
      label: "Message failed SPF",
      detail: "SPF failed — the sending server isn't authorized for the From domain. Often benign (relays/mailing lists) but worth a second look.",
    });
  }

  const dkimDom = a.dkimDomain?.toLowerCase() ?? "";
  const fmcsaDom = identity?.emailDomain?.toLowerCase() ?? "";
  if (a.dkim === "pass" && dkimDom && fmcsaDom && (dkimDom === fmcsaDom || dkimDom.endsWith("." + fmcsaDom))) {
    out.push({
      category: "email_authenticity",
      tier: "info",
      label: "Cryptographically signed by the carrier's domain",
      detail: `DKIM verified the message was signed by ${dkimDom}, the carrier's FMCSA email domain. Strong proof the email genuinely came from this carrier (DKIM can't be spoofed).`,
    });
  } else if (a.dkim === "pass" && dkimDom) {
    out.push({
      category: "email_authenticity",
      tier: "info",
      label: "Message is DKIM-signed",
      detail: `DKIM verified the message was signed by ${dkimDom}${fmcsaDom ? ` (FMCSA has ${fmcsaDom} for this carrier — confirm the sender if these differ)` : ""}.`,
    });
  } else if (a.spf === "pass" || a.dmarc === "pass") {
    out.push({
      category: "email_authenticity",
      tier: "info",
      label: "Message authentication on file",
      detail: `Passed ${[a.spf === "pass" ? "SPF" : "", a.dmarc === "pass" ? "DMARC" : ""].filter(Boolean).join(" + ")} — the message wasn't spoofed in transit.`,
    });
  }
  return out;
}

// ============================================================================
// Evaluator 3: Lane viability
// ============================================================================

/**
 * Does the carrier's MCS-150 operating-area registration support the lane
 * they're asking to be tendered? E.g. an intrastate-only carrier can't run
 * a TX → CA load. We use the third-party operating-area flags (interstate
 * driver counts > 0) from the identity parquet, not the carrier's
 * self-reported claim.
 *
 * Returns no signals when no lane is specified in the email, the absence
 * of a lane isn't a signal.
 */
function evalLaneViability(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined
): Signal[] {
  if (!identity) return [];
  const origin = e.lane.origin_state?.toUpperCase().trim();
  const dest = e.lane.destination_state?.toUpperCase().trim();
  if (!origin || !dest) return [];

  const isInterstate = origin !== dest;
  if (!isInterstate) return []; // intrastate lane, all carriers OK to consider

  // Interstate lane required. Carrier needs at least one interstate driver
  // bucket flagged in their MCS-150.
  const hasInterstate =
    identity.interstateBeyond100mi || identity.interstateWithin100mi;
  if (!hasInterstate) {
    return [
      {
        category: "lane_viability",
        tier: "critical",
        label: getRule("lane-not-authorized-interstate").label,
        detail: `Email proposes lane ${origin} → ${dest} (interstate), but MCS-150 records 0 interstate drivers for this carrier.`,
      },
    ];
  }

  // Interstate-only-local carriers (within 100mi) trying to run long-haul.
  // Soft signal, they might be expanding, but worth noting.
  if (!identity.interstateBeyond100mi && identity.interstateWithin100mi) {
    return [
      {
        category: "lane_viability",
        tier: "caution",
        label: getRule("lane-interstate-local-only").label,
        detail: `MCS-150 records this carrier as interstate within 100 miles only, no long-haul drivers. Proposed lane ${origin} → ${dest} likely exceeds that radius.`,
      },
    ];
  }

  return [];
}

// ============================================================================
// Evaluator 3c: Lane coverage fit (advisory)
// ============================================================================

/**
 * Does the carrier's BIPD coverage fit the lane's injury-LIABILITY exposure?
 * Some lanes (NY/NJ metro especially) produce far more injury crashes than the
 * 36% national average, so a higher bodily-injury liability floor is prudent
 * there — this is why brokers ask NJ-domiciled carriers for ~$1.5M. We key off
 * the LANE (the load's route, which we know) rather than carrier domicile, and
 * read the injury-share-by-state reference (lib/data/lane-liability.json).
 *
 * Advisory only: all signals are `info` tier so they never bump the verdict —
 * this is a coverage-quality tiebreak among acceptable carriers, not a fraud
 * gate. Silent on low-injury lanes. Note: O/D states proxy the full route.
 */
function fmtBipdK(k: number): string {
  if (k >= 1000) return `$${(k / 1000).toFixed(k % 1000 ? 1 : 0)}M`;
  return `$${k}k`;
}
function evalLaneCoverage(e: ExtractedEmail, carrier: FmcsaCarrier): Signal[] {
  const states = [e.lane.origin_state, e.lane.destination_state]
    .map((s) => s?.toUpperCase().trim())
    .filter((s): s is string => !!s);
  if (!states.length) return [];
  // (the JSON also carries a `_meta` key; state lookups by 2-letter code skip it)
  const tbl = laneLiability as unknown as Record<string, { injury_pct: number; tier: string }>;
  // Highest-injury state on the lane drives the recommendation.
  let worst: { st: string; injury_pct: number; tier: string } | null = null;
  for (const st of states) {
    const row = tbl[st];
    if (row && (!worst || row.injury_pct > worst.injury_pct)) {
      worst = { st, injury_pct: row.injury_pct, tier: row.tier };
    }
  }
  if (!worst) return []; // low-injury lane → no advisory
  const floorK = worst.tier === "high" ? 1500 : 1000;
  const bipd = carrier.bipdInsuranceOnFile; // thousands; 0/undefined = none on file
  const where = `${worst.st} (${worst.injury_pct}% of truck crashes there involve an injury, vs 36% nationally)`;
  if (!bipd || bipd <= 0) {
    return [{
      category: "lane_coverage", tier: "info",
      label: "Verify COI — higher-liability lane",
      detail: `This lane runs through ${where}. No BIPD amount is on file with FMCSA, so confirm the certificate carries at least ${fmtBipdK(floorK)} before booking.`,
    }];
  }
  if (bipd >= floorK) {
    return [{
      category: "lane_coverage", tier: "info",
      label: "Coverage fits this lane",
      detail: `${fmtBipdK(bipd)} BIPD on file covers this higher-liability lane (${where}).`,
    }];
  }
  return [{
    category: "lane_coverage", tier: "info",
    label: "Higher coverage advised for this lane",
    detail: `This lane runs through ${where}. Carrier carries ${fmtBipdK(bipd)} BIPD; consider requiring ${fmtBipdK(floorK)} before booking.`,
  }];
}

// ============================================================================
// Evaluator 3b: Hazmat capability
// ============================================================================

/**
 * Did the email pitch a hazmat load, and is this carrier actually authorized
 * to haul hazmat? FMCSA's HM_Ind flag (from Census) is the carrier's own
 * indication that they handle hazmat. Tendering placarded hazmat to a carrier
 * without HM_Ind is a regulatory and liability problem regardless of fraud
 * concerns, even when the carrier is otherwise legitimate.
 *
 * Stage 1 extraction (is_hazmat_load) intentionally errs toward false
 * positives, we'd rather flag "are these chemicals hazmat?" and let the
 * broker confirm than miss an actual hazmat pitch.
 */
function evalHazmat(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined,
  carrier: FmcsaCarrier
): Signal[] {
  if (!e.lane.is_hazmat_load) return [];

  // No identity row → can't check. Stay silent rather than emit a misleading
  // signal, the missing-coverage line in the verdict surfaces the gap.
  if (!identity) return [];

  if (!identity.hazmatFlag) {
    return [
      {
        category: "lane_viability",
        tier: "critical",
        label: getRule("hazmat-not-registered").label,
        detail:
          "Email proposes a hazmat load, but FMCSA Census shows HM_Ind=N for this carrier. They have not indicated they handle hazardous materials on their MCS-150. Tendering placarded hazmat would be a regulatory and liability problem.",
      },
    ];
  }

  // Carrier has the flag. Check that they have any hazmat-inspection
  // activity in the last 24mo, a flag with zero hazmat inspections suggests
  // a stale self-report.
  if (carrier.hazmatInsp === 0) {
    return [
      {
        category: "lane_viability",
        tier: "caution",
        label: getRule("hazmat-no-recent-activity").label,
        detail:
          "Carrier's MCS-150 indicates hazmat capability (HM_Ind=Y), but FMCSA has no hazmat inspections on record for them in the last 24 months. Verify their current hazmat permit and driver endorsements before tendering.",
      },
    ];
  }

  return [
    {
      category: "lane_viability",
      tier: "info",
      label: getRule("hazmat-registered-active").label,
      detail: `Carrier handles hazmat per MCS-150 (HM_Ind=Y) and has ${carrier.hazmatInsp} hazmat inspection${carrier.hazmatInsp === 1 ? "" : "s"} in the last 24 months. Confirm specific endorsements (HM placard, tanker, etc.) match the load.`,
    },
  ];
}

// ============================================================================
// Evaluator 4: Chameleon cluster
// ============================================================================

/**
 * Does this carrier share a phone number with another DOT? Strongest when
 * the focal DOT is NEW and the matched DOT was revoked BEFORE the focal
 * registered, that's the textbook re-incarnation pattern.
 *
 * Patterns this distinguishes:
 *   - Corporate phone (mega fleet w/ many subsidiary DOTs sharing 800-line)
 *     → info, single rolled-up message
 *   - Sister company (focal predates matched, both still active)
 *     → info, no flag
 *   - True chameleon (focal newer than matched; matched revoked)
 *     → Critical
 *
 * Phone-only for v1. Officer-name and address fuzzy match are higher-value
 * but need normalization (false positives on "JOHN SMITH"/"DISPATCH").
 */
const CORPORATE_PHONE_MATCH_THRESHOLD = 3; // >=3 matches → likely corporate switchboard
const CHAMELEON_FOCAL_NEW_DAYS = 365 * 3; // focal carrier "new" if <3 years old

/**
 * Address-cluster chameleon evaluator. Reads pre-computed counters from the
 * carrier_aggregates parquet (built by the Polars pipeline) which tally how
 * many OTHER active + OOS DOTs share this carrier's normalized physical
 * address.
 *
 * Definition + thresholds are documented in
 * `lib/rules/index.ts > chameleon-address-cluster`. Both surfaces (email +
 * website) consume the rule's label/definition from there so they can't
 * drift.
 */
function evalChameleonAddressCluster(carrier: FmcsaCarrier | null): Signal[] {
  if (!carrier) return [];
  const rule = getRule("chameleon-address-cluster");
  const oos = carrier.addressDupeOosCount;
  const active = carrier.addressDupeActiveCount;

  let tier: "critical" | "high" | "caution" | null = null;
  if (oos >= 10) tier = "critical";
  else if (oos >= 5) tier = "high";
  else if (oos >= 3) tier = "caution";
  if (!tier) return [];

  const siblingsClause = active > 0
    ? ` Also ${active} other active DOT${active === 1 ? "" : "s"} at this address.`
    : "";
  const detail =
    `${oos} out-of-service DOT${oos === 1 ? "" : "s"} share this carrier's ` +
    `physical address on FMCSA.${siblingsClause} ` +
    `${rule.thresholds[tier]} This is a common chameleon-carrier pattern; ` +
    `verify the operating address out-of-band before tendering.`;

  return [{
    category: "chameleon_cluster",
    tier,
    label: rule.label,
    detail,
  }];
}

async function evalChameleonCluster(
  identity: CarrierIdentity,
  focalDot: number
): Promise<Signal[]> {
  if (!identity.phone) return [];

  const matchDots = await findIdentityByPhone(identity.phone);
  const otherDots = matchDots.filter((d) => d !== focalDot);
  if (otherDots.length === 0) return [];

  const others = otherDots; // alias kept for the threshold checks below
  const otherCarriers = await fetchCarriers(otherDots);
  const focal = (await fetchCarriers([focalDot])).get(focalDot);
  const focalAddDate = focal?.dotAddDate ? Date.parse(focal.dotAddDate) : null;

  // Corporate-phone heuristic: when many DOTs share the phone, it's almost
  // always a corporate switchboard (Schneider's 800-558-6767 is on 6+ DOTs).
  // Even if one of them happens to have revocation history, that's not a
  // chameleon signal for the focal, it's just a sibling DOT.
  if (others.length >= CORPORATE_PHONE_MATCH_THRESHOLD) {
    const revokedSibling = others.find((o) => {
      const c = otherCarriers.get(o);
      return c && (c.involuntaryRevocations > 0 || c.priorRevokeFlag);
    });
    return [
      {
        category: "chameleon_cluster",
        tier: "info",
        label: getRule("phone-corp-switchboard").label,
        detail: revokedSibling
          ? `${others.length} other DOTs use this phone. Appears to be a corporate dispatch line. One sibling DOT (${revokedSibling}) has historical revocations, but this is sibling/family history, not re-incarnation of the focal carrier.`
          : `${others.length} other DOTs use this phone. Appears to be a corporate dispatch line shared across affiliated authorities.`,
      },
    ];
  }

  // Few matches (1-2). Now distinguish "true chameleon" from "sister entity"
  // by relative timing.
  const signals: Signal[] = [];
  for (const o of otherDots) {
    const c = otherCarriers.get(o);
    if (!c) continue;

    const hasRevocation = c.involuntaryRevocations > 0 || c.priorRevokeFlag;
    const matchedRevokeDate = c.mostRecentInvoluntaryDate
      ? Date.parse(c.mostRecentInvoluntaryDate)
      : null;

    // True chameleon: focal is younger than matched's revocation date AND
    // focal itself is newish (less than 3 years old). Older established
    // carriers don't get tagged as chameleons just because they once shared
    // a phone with a now-defunct sibling.
    const focalNew = focalAddDate && Date.now() - focalAddDate < CHAMELEON_FOCAL_NEW_DAYS * 86400000;
    const focalPostdatesRevoke =
      focalAddDate && matchedRevokeDate && focalAddDate > matchedRevokeDate;

    if (hasRevocation && focalNew && focalPostdatesRevoke) {
      signals.push({
        category: "chameleon_cluster",
        tier: "critical",
        label: getRule("phone-chameleon-revoked-predecessor").label,
        detail: `Sender's phone matches DOT ${o} (${c.legalName ?? "unnamed"}), which had authority revoked ${c.mostRecentInvoluntaryDate}. Focal DOT ${focalDot} was registered after that revocation. Textbook chameleon pattern.`,
      });
    } else if (hasRevocation) {
      // Phone match with a revoked carrier, but timing doesn't support
      // chameleon, surface as caution, broker decides.
      signals.push({
        category: "chameleon_cluster",
        tier: "caution",
        label: getRule("phone-shared-with-revoked-carrier").label,
        detail: `Phone matches DOT ${o} (${c.legalName ?? "unnamed"}), which has revocation history. Timing doesn't fit a re-incarnation pattern (focal carrier is older or the revocation is more recent than focal registration). Likely a sibling/family entity; verify if uncertain.`,
      });
    } else {
      // Few live siblings on the same phone. Previously dismissed as a benign
      // owner-operator pattern, but a lift test (2026-05, internal do-not-use
      // outcomes) found carriers sharing a phone are flagged ~1.3x more often
      // than carriers on a unique line, and the 1-2 sibling case is the most
      // elevated bucket. So it's a weak fraud corroborator, not benign: surface
      // at caution and let the broker confirm it's the same legitimate operator.
      signals.push({
        category: "chameleon_cluster",
        tier: "caution",
        label: getRule("phone-shared-one-other-dot").label,
        detail: `Sender's phone also belongs to active DOT ${o} (${c.legalName ?? "unnamed"}), which has no revocation history. Shared contact between separate active carriers can mean one operator running multiple authorities, verify they're the same legitimate business before tendering.`,
      });
    }
  }

  return signals;
}

// ============================================================================
// Evaluator 5: Email authenticity (DNS + headers + behavior)
// ============================================================================

async function evalEmailAuthenticity(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined
): Promise<Signal[]> {
  const signals: Signal[] = [];
  const sm = e.sender_metadata;

  // NOTE: per-message SPF/DKIM/DMARC was removed. Inline forwards strip the
  // original carrier's Authentication-Results; the remaining header reflects
  // the broker's forwarding server (always passes, meaningless). Reply-To
  // mismatch IS preserved across forwards and stays useful below.

  // --- Hard signal: Reply-To domain mismatch ---
  if (
    sm.reply_to_domain &&
    sm.reply_to_domain.toLowerCase() !== (sm.sender_email_domain ?? "").toLowerCase()
  ) {
    signals.push({
      category: "email_authenticity",
      tier: "high",
      label: getRule("reply-to-differs-from-sender").label,
      detail: `From: ${sm.sender_email_domain}, but Reply-To: ${sm.reply_to_domain}. Replies will go to a different party. Classic phishing pattern.`,
    });
  }

  // --- Soft signal: urgency markers ---
  if (e.behavioral_signals.urgency_markers.length > 0) {
    signals.push({
      category: "email_authenticity",
      tier: "info",
      label: getRule("urgency-language").label,
      detail: `Phrases detected: ${e.behavioral_signals.urgency_markers
        .slice(0, 3)
        .map((s) => `"${s}"`)
        .join(", ")}. Common in pressured fraud pitches, but also normal in legitimate freight.`,
    });
  }

  // --- Soft signal: missing signature block + cold pitch ---
  if (
    !e.behavioral_signals.has_signature_block &&
    !e.behavioral_signals.is_response_to_load_posting &&
    e.behavioral_signals.specificity_score <= 1
  ) {
    signals.push({
      category: "email_authenticity",
      tier: "info",
      label: getRule("vague-cold-pitch").label,
      detail:
        "Email is a cold inquiry with no signature block and no specific lane/load reference. Common with bulk spam; verify identity before responding.",
    });
  }

  // --- Positive info signal: sender identity matches FMCSA ---
  // For business domains, surface domain match. For free-mail, surface full
  // address match (when we have FMCSA's email on file). The mismatch cases
  // fire under identity_coherence.
  const senderDomainLc = (sm.sender_email_domain ?? "").toLowerCase();
  const senderEmailLc = sm.sender_email?.toLowerCase() ?? "";
  if (
    identity?.email &&
    FREE_EMAIL_DOMAINS.has(senderDomainLc) &&
    identity.email.toLowerCase() === senderEmailLc
  ) {
    signals.push({
      category: "email_authenticity",
      tier: "info",
      label: getRule("sender-email-matches-fmcsa").label,
      detail: `Full address ${senderEmailLc} matches the email on file with FMCSA for this DOT. Strong identity signal on a free-mail domain.`,
    });
  } else if (
    identity?.emailDomain &&
    !FREE_EMAIL_DOMAINS.has(senderDomainLc) &&
    identity.emailDomain.toLowerCase() === senderDomainLc
  ) {
    signals.push({
      category: "email_authenticity",
      tier: "info",
      label: getRule("sender-domain-matches-fmcsa").label,
      detail: `Sender at ${sm.sender_email_domain} matches the email domain on file with FMCSA for this DOT.`,
    });
  }

  // --- Domain-level config check ---
  // Skip free email providers (gmail/yahoo/etc., well-established and the
  // domain isn't owned by the sender anyway) and skip when the domain matches
  // FMCSA's registration (the carrier's history with FMCSA is stronger
  // evidence than these external lookups).
  const senderDomain = (sm.sender_email_domain ?? "").toLowerCase();
  const skipDomainLookups =
    FREE_EMAIL_DOMAINS.has(senderDomain) ||
    identity?.emailDomain?.toLowerCase() === senderDomain;
  if (!skipDomainLookups && senderDomain) {
    const dnsConfig = await checkDomainAuth(senderDomain);

    if (dnsConfig) {
      if (!dnsConfig.hasMx) {
        signals.push({
          category: "email_authenticity",
          tier: "high",
          label: getRule("sender-domain-no-mx").label,
          detail: `${senderDomain} has no mail servers configured to receive email. Replies to this address will bounce. Typical of parked, throwaway, or typo-squat domains.`,
        });
      } else if (!dnsConfig.hasSpf && !dnsConfig.hasDmarc) {
        signals.push({
          category: "email_authenticity",
          tier: "caution",
          label: getRule("sender-domain-no-email-auth").label,
          detail: `${senderDomain} accepts mail (MX on file) but publishes neither SPF nor DMARC. Unusual for a real business; most legitimate carriers configure at least one. Worth confirming the carrier's identity through another channel.`,
        });
      } else {
        // Positive info signal: domain is properly set up. NOT the same as
        // "this email passed auth", we can't claim that from forwarded mail.
        const parts: string[] = [];
        if (dnsConfig.hasSpf) parts.push("SPF");
        if (dnsConfig.hasDmarc) parts.push("DMARC");
        signals.push({
          category: "email_authenticity",
          tier: "info",
          label: getRule("sender-domain-auth-configured").label,
          detail: `${senderDomain} publishes ${parts.join(" + ")} on DNS and accepts inbound mail (MX configured) — set up like a real business. This is domain reputation, not proof a specific message is authentic.`,
        });
      }
    }
  }

  return signals;
}

/** True when at least one of the email-authenticity domain checks could be
 *  evaluated for this email, i.e. the email had a sender domain we could
 *  look up. Free-mail domains count as "checked" too (their setup is known
 *  good by definition). */
function domainAuthApplicable(e: ExtractedEmail): boolean {
  return !!e.sender_metadata.sender_email_domain;
}

// ============================================================================
// Verdict composition
// ============================================================================

const TIER_ORDER: SignalTier[] = ["info", "caution", "high", "critical"];
function tierRank(t: SignalTier): number {
  return TIER_ORDER.indexOf(t);
}

function composeVerdict(
  carrier: FmcsaCarrier,
  identity: CarrierIdentity | undefined,
  signals: Signal[],
  coverage: VerdictCoverage
): Verdict {
  // Worst non-info signal sets the tier.
  const worst = signals
    .filter((s) => s.tier !== "info")
    .reduce<SignalTier | null>(
      (acc, s) => (acc === null || tierRank(s.tier) > tierRank(acc) ? s.tier : acc),
      null
    );

  const tier: VerdictTier =
    worst === "critical"
      ? "Critical"
      : worst === "high"
        ? "High"
        : worst === "caution"
          ? "Caution"
          : "Clean";

  // Sparse-email handling: if the email gave us almost nothing to cross-
  // check, a "Clean" verdict needs to communicate that the cleanliness
  // mostly comes from the carrier's FMCSA record, not from verifying the
  // email itself. The broker should know they're effectively getting a
  // website audit + a header check, not a full identity verification.
  const richChecksCount =
    (coverage.mc_match_checked ? 1 : 0) +
    (coverage.name_match_checked ? 1 : 0) +
    (coverage.phone_match_checked ? 1 : 0) +
    (coverage.sender_domain_match_checked ? 1 : 0) +
    (coverage.lane_viability_checked ? 1 : 0);

  const dominantSignal = signals
    .filter((s) => s.tier !== "info")
    .sort((a, b) => tierRank(b.tier) - tierRank(a.tier))[0];

  // Re-run analyze() once, used both to surface concrete reasons in the
  // summary AND to populate the audit summary block at the bottom.
  const dot = carrier.dotNumber as number;
  const audit = analyze(
    [{ dot, loadId: "email-check" }],
    new Map([[dot, carrier]])
  ).rows[0];

  // The headline conveys the tier + recommended action. The summary should say
  // WHY in plain terms and, most usefully, WHAT TO VERIFY before tendering —
  // turned into concrete actions from the findings rather than a jargon list.
  const verifyActions = buildVerifyActions(audit, signals);
  const verifyClause = verifyActions.length
    ? ` Before tendering: ${verifyActions.join(", ")}.`
    : "";
  let summary: string;
  if (dominantSignal) {
    const why =
      dominantSignal.category === "audit_tier" && audit?.reasons?.length
        ? audit.reasons.slice(0, 3).map((r) => phraseReason(r.label)).join("; ")
        : dominantSignal.label;
    summary = `${why}.${verifyClause}`;
  } else if (richChecksCount <= 1) {
    summary =
      `Carrier looks clean on FMCSA, but there wasn't enough to fully verify the contact.${
        verifyClause || " Confirm the MC/DOT, a current COI, and the carrier's contact details before tendering."
      }`;
  } else {
    summary = `Carrier looks clean on FMCSA and the contact details check out.${
      verifyClause || " Standard COI check before tendering."
    }`;
  }

  const physicalLocation =
    identity?.phyCity && identity?.phyState
      ? `${titleCase(identity.phyCity)}, ${identity.phyState}`
      : null;
  const cargoCaps = identity ? cargoLabels(identity.cargo).slice(0, 3) : [];

  return {
    tier,
    summary,
    carrier: {
      dotNumber: dot,
      legalName: carrier.legalName,
      mcNumber: carrier.mcNumber,
      fmcsaPhone: identity?.phone ?? null,
      audit: {
        tier: audit?.riskLevel ?? "Unknown",
        reasonLabels: audit?.reasons.map((r) => r.label) ?? [],
        reasons: audit?.reasons.map((r) => ({ label: r.label, detail: r.detail })) ?? [],
      },
      riskScore: audit?.riskScore ?? null,
      issScore: carrier.issScore ?? null,
      issTier: carrier.issTier ?? null,
      basics: [
        { name: "Unsafe Driving", percentile: carrier.unsafeDrivingPercentile, alert: carrier.unsafeDrivingAlert === "Y" },
        { name: "HOS Compliance", percentile: carrier.hosPercentile, alert: carrier.hosAlert === "Y" },
        { name: "Driver Fitness", percentile: carrier.driverFitnessPercentile, alert: carrier.driverFitnessAlert === "Y" },
        { name: "Controlled Subs", percentile: carrier.controlledSubstancesPercentile, alert: carrier.controlledSubstancesAlert === "Y" },
        { name: "Vehicle Maint.", percentile: carrier.vehicleMaintenancePercentile, alert: carrier.vehicleMaintenanceAlert === "Y" },
        { name: "Crash Indicator", percentile: carrier.crashIndicatorPercentile, alert: carrier.crashIndicatorAlert === "Y" },
        { name: "Hazmat", percentile: carrier.hmCompliancePercentile, alert: carrier.hmComplianceAlert === "Y" },
      ],
      physicalState: identity?.phyState ?? carrier.physicalState ?? null,
      physicalLocation,
      powerUnits: carrier.totalPowerUnits || null,
      drivers: carrier.totalDrivers || null,
      dotIssued: carrier.dotAddDate?.slice(0, 4) ?? null,
      mostRecentRevocationDate: carrier.mostRecentInvoluntaryDate ?? null,
      allowedToOperate: carrier.allowedToOperate ?? null,
      statusCode: carrier.statusCode ?? null,
      operatingArea: identity?.operatingArea ?? null,
      cargoCapabilities: cargoCaps,
      fmcsaEmailDomain: identity?.emailDomain ?? null,
      fmcsaEmail: identity?.email ?? null,
      bipdInsurer: carrier.bipdInsurerName ?? null,
      bipdAmount: carrier.bipdInsuranceOnFile || null,
      bipdRequiredAmount: carrier.bipdRequiredAmount ?? 0,
      cargoInsurer: carrier.cargoInsurerName ?? null,
      cargoInsuranceOnFile: carrier.cargoInsuranceOnFile,
      inspections24mo: carrier.driverInsp + carrier.vehicleInsp,
      crashes24mo: carrier.crashTotal,
      safetyRating: isSafetyRatingFresh(carrier.safetyRatingDate)
        ? carrier.safetyRating
        : null,
      safetyRatingDate: isSafetyRatingFresh(carrier.safetyRatingDate)
        ? carrier.safetyRatingDate
        : null,
      companyOfficer: identity?.companyOfficer ?? null,
      driverInspections: [carrier.driverInsp, carrier.driverOosInsp],
      vehicleInspections: [carrier.vehicleInsp, carrier.vehicleOosInsp],
      hazmatInspections: [carrier.hazmatInsp, carrier.hazmatOosInsp],
      crashBreakdown: [carrier.fatalCrash, carrier.injCrash, carrier.towawayCrash],
      insuranceCancellations24mo: carrier.insuranceCancellations24mo,
      insuranceCancellationDate: carrier.mostRecentCancelDate ?? null,
      crashesPerMillionMiles: carrier.crashesPerMillionMiles ?? null,
      crashMeasure: carrier.crashMeasure && carrier.crashMeasure > 0 ? carrier.crashMeasure : null,
      crashMeasureBand: labelCrashMeasure(carrier.crashMeasure),
      basicAlerts: collectBasicAlerts(carrier),
      auditAxes: audit
        ? (() => {
            const peer = audit.peerGroup as PeerGroup;
            // Observed values for each axis match the analyzer's peer-group
            // cutoff scale. OOS + Unsafe Driving + HOS are all "violation
            // rates" (count / driver-or-vehicle inspections) shown as %.
            // Crash is crashes-per-million-miles. The SMS measure (1.88
            // etc.) is referenced in the audit detail string but the bar
            // visualization uses the comparable per-peer-group rate.
            const driverOosObs = carrier.driverInsp > 0 ? (carrier.driverOosInsp / carrier.driverInsp) * 100 : null;
            const vehicleOosObs = carrier.vehicleInsp > 0 ? (carrier.vehicleOosInsp / carrier.vehicleInsp) * 100 : null;
            const hazmatOosObs = carrier.hazmatInsp > 0 ? (carrier.hazmatOosInsp / carrier.hazmatInsp) * 100 : null;
            const unsafeDrivingRate = carrier.driverInsp > 0 ? (carrier.unsafeDrivingViolations / carrier.driverInsp) * 100 : null;
            const hosRate = carrier.driverInsp > 0 ? (carrier.hosViolations / carrier.driverInsp) * 100 : null;
            return {
              crash: pickAxis(audit.axes.crash, "crashesPerMillionMiles", peer, carrier.crashesPerMillionMiles ?? null),
              unsafeDriving: pickAxis(audit.axes.unsafeDriving, "unsafeDriving", peer, unsafeDrivingRate),
              hos: pickAxis(audit.axes.hos, "hos", peer, hosRate),
              driverOos: pickAxis(audit.axes.driverOos, "driverOos", peer, driverOosObs),
              vehicleOos: pickAxis(audit.axes.vehicleOos, "vehicleOos", peer, vehicleOosObs),
              hazmatOos: pickAxis(audit.axes.hazmatOos, "hazmatOos", peer, hazmatOosObs),
            };
          })()
        : {
            crash: null, unsafeDriving: null, hos: null,
            driverOos: null, vehicleOos: null, hazmatOos: null,
          },
      peerGroupLabel: audit?.peerGroupLabel ?? "",
    },
    signals,
    coverage,
    generatedAt: new Date().toISOString(),
  };
}

/** Scale factor to convert analyzer-internal cutoff units into the units the
 *  email renderer expects (matching `observed`). OOS rates live as decimals
 *  (0.003 = 0.3%) in national_thresholds.json but the email shows percents,
 *  so we scale them by 100. Crash rate and FMCSA SMS measures already share
 *  units with the observed values, so scale = 1. */
const AXIS_SCALE_FOR_DISPLAY: Record<AxisKey, number> = {
  driverOos: 100,
  vehicleOos: 100,
  hazmatOos: 100,
  crashesPerMillionMiles: 1,
  crashMeasure: 1,
  // Unsafe Driving + HOS rate cutoffs are stored as decimals (0-1) in
  // thresholds.json. The email displays them as %, so multiply by 100 to
  // keep observed (also in %) on the same scale.
  unsafeDriving: 100,
  hos: 100,
};

/** Strip the analyzer's AxisCell down to plain JSON + attach the peer-group
 *  percentile cutoffs so the email renderer can draw bars with markers at
 *  P85/P90/P95 positions. Cutoffs are normalized to match `observed`'s
 *  display unit so the renderer can compare them directly. */
function pickAxis(
  cell: { status: string; display: string; detail?: string },
  axisKey: AxisKey | null,
  peer: PeerGroup,
  observed: number | null
): VerdictCarrierSummary["auditAxes"]["crash"] {
  if (!cell || cell.status === "na" || cell.display === "—") return null;
  let cutoffs = axisKey ? getCutoffs(axisKey, peer) : null;
  if (cutoffs && axisKey) {
    const scale = AXIS_SCALE_FOR_DISPLAY[axisKey];
    cutoffs = {
      p85: cutoffs.p85 * scale,
      p90: cutoffs.p90 * scale,
      p95: cutoffs.p95 * scale,
    };
  }
  return {
    status: cell.status,
    display: cell.display,
    detail: cell.detail ?? null,
    cutoffs,
    observed,
  };
}

/** National percentile cutoffs for FMCSA's Crash Indicator (CSI), computed
 *  from the May 2026 parquet population (~112k carriers with non-zero CSI).
 *  Used to label a carrier's raw CSI value as "top 5% nationally" etc.,
 *  matching the framing the analyzer already uses for SMS BASIC measures. */
const CRASH_MEASURE_CUTOFFS = { p85: 3.0, p95: 6.0, p99: 9.0 } as const;

function labelCrashMeasure(measure: number | null | undefined): string | null {
  if (measure == null || measure <= 0) return null;
  const c = CRASH_MEASURE_CUTOFFS;
  if (measure >= c.p99) return "≥P99, top 1% nationally";
  if (measure >= c.p95) return "≈P95, top 5%";
  if (measure >= c.p85) return "≈P85, top 15%";
  return "below P85";
}

/** FMCSA's BASIC "alert" flags are Y when a carrier is over the intervention
 *  threshold on that SMS dimension. These are the most actionable single
 *  safety signal, FMCSA itself uses them to prioritize compliance review.
 *  We only surface fired alerts; "all 5 cleared" is the silent default. */
function collectBasicAlerts(
  c: import("../fmcsa").FmcsaCarrier
): VerdictCarrierSummary["basicAlerts"] {
  const out: VerdictCarrierSummary["basicAlerts"] = [];
  if (c.unsafeDrivingAlert === "Y") out.push("Unsafe Driving");
  if (c.hosAlert === "Y") out.push("HOS Compliance");
  if (c.driverFitnessAlert === "Y") out.push("Driver Fitness");
  if (c.controlledSubstancesAlert === "Y") out.push("Controlled Substances");
  if (c.vehicleMaintenanceAlert === "Y") out.push("Vehicle Maintenance");
  return out;
}

/** The analyzer emits terse table-cell labels for reasons (e.g. "Crashes",
 *  "Driver OOS", "Vehicle OOS") that work in a scorecard column but read
 *  awkwardly as a standalone summary sentence. This map expands those into
 *  natural prose phrases. Labels not in the map pass through after stripping
 *  any leading glyph (e.g. "🛑 Severe insurance churn" → "Severe insurance
 *  churn"), which is the case for the already-descriptive labels. */
const REASON_PHRASING: Record<string, string> = {
  Crashes: "Crash rate above peer P95 cutoff",
  "Driver OOS": "Driver-OOS rate above peer P95 cutoff",
  "Vehicle OOS": "Vehicle-OOS rate above peer P95 cutoff",
  "Hazmat OOS": "Hazmat-OOS rate above peer P95 cutoff",
  "Unsafe Driving": "Unsafe Driving BASIC above peer P95 cutoff",
  HOS: "HOS Compliance BASIC above peer P95 cutoff",
};

function phraseReason(label: string): string {
  const stripped = label.replace(/^[^\w]+\s*/, "");
  return REASON_PHRASING[stripped] ?? stripped;
}

/** Turn the fired findings into concrete "verify before tendering" actions, so
 *  the summary tells the broker what to DO rather than just listing jargon.
 *  Keyword-matched against the audit reasons + hard signals; deduped, capped. */
function buildVerifyActions(
  audit: { reasons?: Array<{ label: string }> } | undefined,
  signals: Signal[]
): string[] {
  const txt = [
    ...(audit?.reasons?.map((r) => r.label) ?? []),
    ...signals.filter((s) => s.tier !== "info").map((s) => s.label),
  ]
    .join(" • ")
    .toLowerCase();
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  // Hard authority/insurance problems first.
  if (/(revoked|not allowed|not active|deregister)/.test(txt) && !/reinstat/.test(txt)) {
    add("confirm the operating authority is active");
  }
  if (/(insur|bipd|cancel|\bcoi\b|lapse|churn|reinstat)/.test(txt)) {
    add("confirm a current COI (insurance)");
  }
  if (/(oos|out-of-service|crash|unsafe|hos|vehicle|maintenance|inspection|basic|\biss\b|inspect)/.test(txt)) {
    add("review the inspection & out-of-service history");
  }
  if (/(chameleon|fleet|equipment spread|address|sibling|re-?incarnat|prior.?revoke)/.test(txt)) {
    add("confirm which DOT will actually haul");
  }
  if (/(sender|email|phone|domain|impersonat|mismatch)/.test(txt)) {
    add("verify the carrier's email & phone against FMCSA");
  }
  if (/(lane|coverage)/.test(txt)) {
    add("confirm BIPD coverage fits this lane");
  }
  return out.slice(0, 3);
}

/** A safety rating older than 5 years is misleading as a positive signal,
 *  the carrier may have changed entirely. Suppress old ratings to avoid
 *  giving brokers false confidence. */
function isSafetyRatingFresh(rated: string | null): boolean {
  if (!rated) return false;
  const t = Date.parse(rated);
  if (Number.isNaN(t)) return false;
  return Date.now() - t < 5 * 365 * 86400000;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

// ============================================================================
// "Failed before evaluators" verdict shortcuts
// ============================================================================

const ZERO_COVERAGE: VerdictCoverage = {
  carrier_resolved: false,
  audit_tier: false,
  mc_match_checked: false,
  name_match_checked: false,
  phone_match_checked: false,
  sender_domain_match_checked: false,
  lane_viability_checked: false,
  chameleon_cluster_checked: false,
  email_auth_checked: false,
  hazmat_match_checked: false,
};

function verdictNoDot(e: ExtractedEmail): Verdict {
  return {
    tier: "Caution",
    summary: "Provide the carrier's DOT or MC number and we'll run the full safety check. Carriers without a clear DOT/MC are unverifiable — never tender without one.",
    carrier: null,
    signals: [
      {
        category: "identity_coherence",
        tier: "caution",
        label: getRule("no-dot-or-mc-in-email").label,
        detail:
          "No DOT or MC number was found, so we can't cross-check this carrier against FMCSA. Confirm the carrier's USDOT or MC number before tendering.",
      },
    ],
    coverage: { ...ZERO_COVERAGE, email_auth_checked: true },
    generatedAt: new Date().toISOString(),
  };
}

function verdictDotNotFound(dot: number, _e: ExtractedEmail): Verdict {
  return {
    tier: "Critical",
    summary: `DOT ${dot} is not in our FMCSA snapshot. Likely fabricated or fully deregistered. Do not tender; confirm a valid DOT via FMCSA SAFER before any further engagement.`,
    carrier: null,
    signals: [
      {
        category: "identity_coherence",
        tier: "critical",
        label: getRule("dot-not-found-in-fmcsa").label,
        detail: `DOT ${dot} isn't in the active-carrier universe. Possibilities: the number was fabricated (most concerning), the DOT was fully deregistered, or the carrier has been dormant long enough to fall out of the active dataset. Verify the claimed DOT on FMCSA SAFER (safer.fmcsa.dot.gov) before any further engagement.`,
      },
    ],
    coverage: { ...ZERO_COVERAGE, email_auth_checked: true },
    generatedAt: new Date().toISOString(),
  };
}

// ============================================================================
// Small string helpers
// ============================================================================

function normalizeMc(s: string | null | undefined): string | null {
  if (!s) return null;
  // Keep prefix + digits, uppercase. "mc-133655" / "MC 133655" / "MC#133655"
  // → "MC133655". Reject stray standalone digits.
  const m = s.match(/^(MC|MX|FF)[-_# ]*(\d+)/i);
  if (!m) return null;
  return `${m[1].toUpperCase()}${m[2]}`;
}

function digitsOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  const d = s.replace(/\D/g, "");
  return d.length >= 7 ? d : null;
}

/**
 * Token-overlap similarity. Lowercases, strips common suffixes (INC, LLC,
 * CORP, etc.), splits on whitespace, returns |A ∩ B| / max(|A|, |B|).
 *
 * Examples:
 *   "Schneider National Carriers Inc" vs "Schneider National Inc"
 *     → tokens {schneider, national, carriers} vs {schneider, national}
 *     → |∩|=2, max=3, score=0.67
 *   "Schneider National" vs "Schneider Dispatch LLC"
 *     → {schneider, national} vs {schneider, dispatch}
 *     → |∩|=1, max=2, score=0.50
 *   "Schneider National" vs "Werner Enterprises"
 *     → score=0
 */
function nameSimilarity(a: string, b: string): number {
  const SUFFIXES = new Set(["inc", "llc", "corp", "corporation", "co", "ltd", "limited", "lp", "llp"]);
  const tokens = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[.,]/g, " ")
        .split(/\s+/)
        .filter((t) => t.length > 0 && !SUFFIXES.has(t))
    );
  const A = tokens(a);
  const B = tokens(b);
  if (A.size === 0 || B.size === 0) return 0;
  let intersect = 0;
  for (const t of A) if (B.has(t)) intersect++;
  return intersect / Math.max(A.size, B.size);
}
