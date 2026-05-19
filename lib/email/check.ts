/**
 * Deterministic verdict pipeline for safe@augie.ai.
 *
 * Five evaluators run against the parsed email + FMCSA data. Each returns a
 * list of Signals (tier + label + detail). The verdict tier is the worst
 * signal that fired. `info` signals are surfaced as evidence but don't bump
 * the verdict tier — they're context the broker should know.
 *
 * Why deterministic (no LLM here)? Two reasons:
 *   1. Testable. We can hand-construct any ExtractedEmail and verify the
 *      verdict. No flakiness from prompt drift.
 *   2. Defensible. "Why did this email get marked High?" maps to specific
 *      rule hits in this file, not an opaque model decision.
 */
import { fetchCarriers, type FmcsaCarrier } from "../fmcsa";
import { fetchIdentity, findIdentityByPhone, type CarrierIdentity } from "../fmcsa-identity";
import { analyze } from "../analyzer";
import type {
  ExtractedEmail,
  Signal,
  SignalTier,
  Verdict,
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

export async function checkCarrierEmail(e: ExtractedEmail): Promise<Verdict> {
  const dotStr = e.identity_claims.dot_number;
  const dot = dotStr ? parseInt(dotStr.replace(/\D/g, ""), 10) : NaN;

  // Email claims no DOT at all. Can't cross-check against FMCSA without one.
  if (!Number.isFinite(dot) || dot <= 0) {
    return verdictNoDot(e);
  }

  const [carriers, identities] = await Promise.all([
    fetchCarriers([dot]),
    fetchIdentity([dot]),
  ]);
  const carrier = carriers.get(dot);
  const identity = identities.get(dot);

  // DOT claimed but not found in our parquet. Either dormant (filtered out of
  // the 2.08M-row universe), a typo, or a fabricated number.
  if (!carrier) {
    return verdictDotNotFound(dot, e);
  }

  // Track what we actually checked vs skipped — verdict summary uses this
  // to set the right expectation with the broker. A "Clean" verdict from a
  // sparse email is not the same as a "Clean" verdict from a rich email
  // where every check ran with data.
  const coverage: VerdictCoverage = {
    carrier_resolved: true,
    audit_tier: true, // always runs when carrier is resolved
    mc_match_checked: !!e.identity_claims.mc_number && !!carrier.mcNumber,
    name_match_checked: !!e.identity_claims.claimed_company_name && !!carrier.legalName,
    phone_match_checked: !!e.identity_claims.claimed_phone && !!identity?.phone,
    sender_domain_match_checked: !!identity?.emailDomain,
    lane_viability_checked:
      !!e.lane.origin_state && !!e.lane.destination_state && !!identity,
    chameleon_cluster_checked: !!identity?.phone,
    email_auth_checked: true,
  };

  const signals: Signal[] = [];
  signals.push(...evalAuditTier(carrier, dot));
  signals.push(...evalIdentityCoherence(e, carrier, identity));
  signals.push(...evalLaneViability(e, identity));
  if (identity) {
    signals.push(...(await evalChameleonCluster(identity, dot)));
  }
  signals.push(...evalEmailAuthenticity(e, identity));

  return composeVerdict(carrier, identity, signals, coverage);
}

// ============================================================================
// Evaluator 1: Audit tier (reuses existing analyzer)
// ============================================================================

/**
 * Run the existing carrier-audit analyzer.ts against this carrier and map
 * its tier to a Signal. Inherits ALL existing scoring: P95 statistical
 * outliers, recent revocations, lapsed insurance, new-authority Critical,
 * chameleon-pattern cluster, etc. No new logic — just a tier mapping.
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
    case "Severe":
      return [
        {
          category: "audit_tier",
          tier: "high",
          label: "Carrier in Severe tier",
          detail: `Existing carrier audit flags this DOT as Severe: ${reasonsText}.`,
        },
      ];
    case "High":
      return [
        {
          category: "audit_tier",
          tier: "caution",
          label: "Carrier in High tier",
          detail: `Existing carrier audit flags this DOT as High: ${reasonsText}.`,
        },
      ];
    case "Elevated":
      return [
        {
          category: "audit_tier",
          tier: "info",
          label: "Carrier in Elevated tier",
          detail: `Existing carrier audit flags this DOT as Elevated: ${reasonsText}. Context only.`,
        },
      ];
    case "Clean":
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
      label: "MC# mismatch",
      detail: `Email claims ${e.identity_claims.mc_number}, FMCSA has ${carrier.mcNumber} for DOT ${carrier.dotNumber}.`,
    });
  }

  // --- Sender domain match ---
  // Compare to FMCSA-registered email_domain (from identity parquet). The
  // signal is "claim doesn't match record," NOT "free email = bad."
  if (identity?.emailDomain) {
    const fmcsa = identity.emailDomain.toLowerCase();
    const sender = e.sender_metadata.sender_email_domain.toLowerCase();
    if (fmcsa !== sender) {
      // Free email on the sender side is suspicious when FMCSA has a
      // business domain on file. Free-on-free is fine for small carriers.
      const senderIsFree = FREE_EMAIL_DOMAINS.has(sender);
      const fmcsaIsFree = FREE_EMAIL_DOMAINS.has(fmcsa);
      if (senderIsFree && !fmcsaIsFree) {
        signals.push({
          category: "identity_coherence",
          tier: "high",
          label: "Sender uses free email but FMCSA has business domain",
          detail: `Email comes from ${sender} but FMCSA records this carrier at ${fmcsa}. Possible impersonation.`,
        });
      } else {
        signals.push({
          category: "identity_coherence",
          tier: "high",
          label: "Sender domain doesn't match FMCSA registration",
          detail: `Sender at ${sender}, FMCSA registered ${fmcsa} for this DOT.`,
        });
      }
    }
  } else if (FREE_EMAIL_DOMAINS.has(e.sender_metadata.sender_email_domain)) {
    // FMCSA has no email on file AND sender is using free email. Surface
    // as info — too common in small-carrier population to flag.
    signals.push({
      category: "identity_coherence",
      tier: "info",
      label: "Sender at free email (no FMCSA email to compare)",
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
        label: "Company name doesn't match FMCSA",
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
      label: "Phone in email doesn't match FMCSA",
      detail: `Email lists ${e.identity_claims.claimed_phone}, FMCSA has ${identity?.phone}. Could be a new number; verify if unsure.`,
    });
  }

  return signals;
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
 * Returns no signals when no lane is specified in the email — the absence
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
  if (!isInterstate) return []; // intrastate lane — all carriers OK to consider

  // Interstate lane required. Carrier needs at least one interstate driver
  // bucket flagged in their MCS-150.
  const hasInterstate =
    identity.interstateBeyond100mi || identity.interstateWithin100mi;
  if (!hasInterstate) {
    return [
      {
        category: "lane_viability",
        tier: "critical",
        label: "Not authorized for interstate",
        detail: `Email proposes lane ${origin} → ${dest} (interstate), but MCS-150 records 0 interstate drivers for this carrier.`,
      },
    ];
  }

  // Interstate-only-local carriers (within 100mi) trying to run long-haul.
  // Soft signal — they might be expanding, but worth noting.
  if (!identity.interstateBeyond100mi && identity.interstateWithin100mi) {
    return [
      {
        category: "lane_viability",
        tier: "caution",
        label: "Carrier registers as interstate-local only",
        detail: `MCS-150 records this carrier as interstate within 100 miles only — no long-haul drivers. Proposed lane ${origin} → ${dest} likely exceeds that radius.`,
      },
    ];
  }

  return [];
}

// ============================================================================
// Evaluator 4: Chameleon cluster
// ============================================================================

/**
 * Does this carrier share a phone number with another DOT? Strongest when
 * the focal DOT is NEW and the matched DOT was revoked BEFORE the focal
 * registered — that's the textbook re-incarnation pattern.
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

async function evalChameleonCluster(
  identity: CarrierIdentity,
  focalDot: number
): Promise<Signal[]> {
  if (!identity.phone) return [];

  const matches = await findIdentityByPhone(identity.phone);
  const others = matches.filter((m) => m.dotNumber !== focalDot);
  if (others.length === 0) return [];

  const otherDots = others.map((m) => m.dotNumber);
  const otherCarriers = await fetchCarriers(otherDots);
  const focal = (await fetchCarriers([focalDot])).get(focalDot);
  const focalAddDate = focal?.dotAddDate ? Date.parse(focal.dotAddDate) : null;

  // Corporate-phone heuristic: when many DOTs share the phone, it's almost
  // always a corporate switchboard (Schneider's 800-558-6767 is on 6+ DOTs).
  // Even if one of them happens to have revocation history, that's not a
  // chameleon signal for the focal — it's just a sibling DOT.
  if (others.length >= CORPORATE_PHONE_MATCH_THRESHOLD) {
    const revokedSibling = others.find((o) => {
      const c = otherCarriers.get(o.dotNumber);
      return c && (c.involuntaryRevocations > 0 || c.priorRevokeFlag);
    });
    return [
      {
        category: "chameleon_cluster",
        tier: "info",
        label: `Phone shared with ${others.length} other DOTs (corporate switchboard)`,
        detail: revokedSibling
          ? `${others.length} other DOTs use this phone — appears to be a corporate dispatch line. One sibling DOT (${revokedSibling.dotNumber}) has historical revocations, but this is sibling/family history, not re-incarnation of the focal carrier.`
          : `${others.length} other DOTs use this phone — appears to be a corporate dispatch line shared across affiliated authorities.`,
      },
    ];
  }

  // Few matches (1-2). Now distinguish "true chameleon" from "sister entity"
  // by relative timing.
  const signals: Signal[] = [];
  for (const o of others) {
    const c = otherCarriers.get(o.dotNumber);
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
        label: "New DOT shares phone with revoked predecessor",
        detail: `Sender's phone matches DOT ${o.dotNumber} (${c.legalName ?? "unnamed"}), which had authority revoked ${c.mostRecentInvoluntaryDate}. Focal DOT ${focalDot} was registered after that revocation — textbook chameleon pattern.`,
      });
    } else if (hasRevocation) {
      // Phone match with a revoked carrier, but timing doesn't support
      // chameleon — surface as caution, broker decides.
      signals.push({
        category: "chameleon_cluster",
        tier: "caution",
        label: "Phone shared with carrier that had revocation history",
        detail: `Phone matches DOT ${o.dotNumber} (${c.legalName ?? "unnamed"}), which has revocation history. Timing doesn't fit a re-incarnation pattern (focal carrier is older or the revocation is more recent than focal registration). Likely a sibling/family entity — verify if uncertain.`,
      });
    } else {
      // Single non-revoked match — common owner-operator pattern.
      signals.push({
        category: "chameleon_cluster",
        tier: "info",
        label: "Phone shared with one other DOT",
        detail: `Phone matches DOT ${o.dotNumber} (${c.legalName ?? "unnamed"}). Common when an operator holds multiple authorities; not necessarily suspicious.`,
      });
    }
  }

  return signals;
}

// ============================================================================
// Evaluator 5: Email authenticity (DNS + headers + behavior)
// ============================================================================

function evalEmailAuthenticity(
  e: ExtractedEmail,
  identity: CarrierIdentity | undefined
): Signal[] {
  const signals: Signal[] = [];
  const sm = e.sender_metadata;

  // --- Hard signal: SPF/DKIM/DMARC explicit fail ---
  // Only fire on explicit FAIL (not neutral/missing — many legit small senders
  // don't have full email auth set up).
  const authFails: string[] = [];
  if (sm.spf_pass === false) authFails.push("SPF");
  if (sm.dkim_pass === false) authFails.push("DKIM");
  if (sm.dmarc_pass === false) authFails.push("DMARC");
  if (authFails.length > 0) {
    signals.push({
      category: "email_authenticity",
      tier: "high",
      label: `Email authentication failed: ${authFails.join(", ")}`,
      detail: `Sending server failed ${authFails.join(", ")} verification. The email may be spoofed.`,
    });
  }

  // --- Hard signal: Reply-To domain mismatch ---
  if (
    sm.reply_to_domain &&
    sm.reply_to_domain.toLowerCase() !== sm.sender_email_domain.toLowerCase()
  ) {
    signals.push({
      category: "email_authenticity",
      tier: "high",
      label: "Reply-To domain differs from sender",
      detail: `From: ${sm.sender_email_domain}, but Reply-To: ${sm.reply_to_domain}. Replies will go to a different party — classic phishing pattern.`,
    });
  }

  // --- Soft signal: urgency markers ---
  if (e.behavioral_signals.urgency_markers.length > 0) {
    signals.push({
      category: "email_authenticity",
      tier: "info",
      label: "Email uses urgency language",
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
      label: "Vague cold pitch without signature",
      detail:
        "Email is a cold inquiry with no signature block and no specific lane/load reference. Common with bulk spam; verify identity before responding.",
    });
  }

  // --- Soft signal: free email domain with no FMCSA business domain ---
  // (Only fires when identity coherence didn't already cover it.)
  if (
    FREE_EMAIL_DOMAINS.has(sm.sender_email_domain) &&
    identity?.emailDomain &&
    !FREE_EMAIL_DOMAINS.has(identity.emailDomain) &&
    sm.sender_email_domain !== identity.emailDomain.toLowerCase()
  ) {
    // Already covered by identity_coherence — skip duplicate signal.
  }

  return signals;
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

  let summary: string;
  if (dominantSignal) {
    summary = `${tier} risk — ${dominantSignal.label.toLowerCase()}.`;
  } else if (richChecksCount <= 1) {
    // Clean verdict from a sparse email — be honest about why.
    summary =
      "Carrier audit is clean and email headers look legitimate, but the email itself didn't include enough info (no lane, no claimed phone or company name) to fully verify identity. Treat as the equivalent of running the website audit.";
  } else {
    summary =
      "Looks legitimate — sender identity matches FMCSA records and carrier audit is clean.";
  }

  // Re-run analyze() to populate the audit summary block on the verdict.
  const dot = carrier.dotNumber as number;
  const audit = analyze(
    [{ dot, loadId: "email-check" }],
    new Map([[dot, carrier]])
  ).rows[0];

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
      },
    },
    signals,
    coverage,
    generatedAt: new Date().toISOString(),
  };
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
};

function verdictNoDot(e: ExtractedEmail): Verdict {
  return {
    tier: "Caution",
    summary: "Email doesn't claim a DOT number — can't verify carrier identity.",
    carrier: null,
    signals: [
      {
        category: "identity_coherence",
        tier: "caution",
        label: "No DOT number in email",
        detail:
          "The email doesn't include a DOT number, so we can't cross-check the sender against FMCSA. Ask the carrier for their DOT before tendering.",
      },
    ],
    coverage: { ...ZERO_COVERAGE, email_auth_checked: true },
    generatedAt: new Date().toISOString(),
  };
}

function verdictDotNotFound(dot: number, _e: ExtractedEmail): Verdict {
  return {
    tier: "Critical",
    summary: `DOT ${dot} is not in our FMCSA snapshot — carrier may be dormant, unregistered, or the number is fabricated.`,
    carrier: null,
    signals: [
      {
        category: "identity_coherence",
        tier: "critical",
        label: "DOT not found in FMCSA snapshot",
        detail: `DOT ${dot} is not present in the active-carrier universe. Possibilities: the carrier is fully dormant (no current authority, no recent inspections), the DOT was deregistered, or the number was fabricated.`,
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
