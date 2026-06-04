/**
 * HTML reply template, matches the design mockup in
 * .context/attachments/XRcItc/. Sent as the text/html alternative alongside
 * the plain-text body so mail clients render either.
 *
 * Email-HTML constraints (NOT regular HTML):
 *   - No <link rel="stylesheet">, embed styles inline or in <style>
 *   - No CSS Grid, no Flexbox, use nested <table> for layout
 *   - No background-image, no @media (well, Apple Mail accepts but Outlook
 *     strips), use bgcolor= and inline color: for colors
 *   - System-font stack only; custom fonts won't survive
 *   - No JavaScript; no <iframe>
 *   - Width capped to 640px (Outlook chokes wider)
 *   - All <img> need width/height attrs (Outlook scales weirdly otherwise)
 *
 * Goal is ~90% visual fidelity to the mockup in Gmail / Apple Mail / Outlook.
 */
import type { ExtractedEmail, Signal, Verdict } from "./types";
import { cancelChurnPercentileText } from "../analyzer";

// Brand palette. Tier colors below match the website's audit-result pill
// palette (components/AuditWidget.tsx), Tailwind red-200/red-950 for
// Critical, red-100/red-900 for Severe, orange-100/orange-900 for High,
// amber-50/amber-900 for Elevated, plus green for Clean. Keeping these in
// sync means the email and the website read as the same product.
const C = {
  pageBg: "#f6f5f1",
  cardBg: "#ffffff",
  border: "#e6e5e0",
  borderStrong: "#d4d3cc",
  ink: "#1e2521",
  inkMuted: "#5e645f",
  inkLabel: "#8a8f8b",
  greenCheck: "#2f9742",
  // Hard-finding accents used inside the body (BASIC alerts, OOS rates,
  // crash rate, insurance churn). Critical-toned red for at-or-above
  // intervention thresholds; amber for "worth knowing".
  redBgPill: "#fee2e2",   // tailwind red-100
  redInkPill: "#7f1d1d",  // tailwind red-900
  amberBgPill: "#fef3c7", // tailwind amber-100
  amberInkPill: "#78350f", // tailwind amber-900
  // Legacy keys kept so other call-sites continue compiling.
  greenBgPill: "#d6efd5",
  greenInkPill: "#1e6b30",
  yellowBgPill: "#fef3c7",
  yellowInkPill: "#78350f",
  ctaBg: "#1e2521",
  ctaInk: "#ffffff",
};

/** Website-aligned 4-tier scale (analyzer.riskLevel) used for the top pill.
 *  We surface the carrier's audit tier here directly so "Critical" on the
 *  website is "Critical" in the email, same scale, same colors. */
type TierStyle = { bg: string; ink: string; headline: string };
// Critical uses white text on solid red for mobile-dark-mode safety.
// Gmail/iOS mobile inverts light-background pills (light pink → dark gray)
// while leaving the text color alone, so dark red text on (inverted) dark
// gray becomes invisible. White ink on saturated red survives the inversion.
// Light tiers (Low/Medium/High) use dark ink on a tinted background; they
// stay legible in dark mode because mobile clients typically leave
// dark-on-light tinted pills alone (or invert symmetrically).
const AUDIT_TIER_STYLES: Record<string, TierStyle> = {
  Low:      { bg: "#dcfce7", ink: "#14532d", headline: "Looks legitimate" },
  Medium:   { bg: "#fffbeb", ink: "#78350f", headline: "Worth a closer look" },
  High:     { bg: "#ffedd5", ink: "#7c2d12", headline: "Verify before tendering" },
  Critical: { bg: "#b91c1c", ink: "#ffffff", headline: "Do not engage without verification" },
};

function auditTierInkOnNeutral(tier: string): string {
  if (tier === "Critical") return C.redInkPill;
  if (tier === "High") return "#7c2d12";
  if (tier === "Medium") return C.amberInkPill;
  if (tier === "Low") return C.greenInkPill;
  return C.ink;
}
// Default style used when no carrier was resolved (no DOT/MC in the email,
// or claimed DOT not in FMCSA snapshot). Headline tells the broker what to
// do, ask for the carrier's DOT/MC, instead of the misleading "verify
// identity" (there's nothing to verify yet).
const DEFAULT_TIER_STYLE: TierStyle = {
  bg: "#fef3c7", ink: "#78350f", headline: "Carrier identity required",
};

// Order matters. BlinkMacSystemFont is the historical workaround for Chrome
// on macOS misbehaving with system-ui. Helvetica Neue covers older macOS Mail.
// Final Arial guarantees a sans-serif on Outlook (which would otherwise pick
// a Times default at heavy weights).
//
// CRITICAL: Use SINGLE quotes inside the stack (e.g. 'Segoe UI'), NOT double.
// This string gets interpolated into inline style="..." attributes, any inner
// double quotes prematurely close the attribute, and every declaration after
// font-family in that style="..." block silently fails to apply.
const FONT_STACK = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";
const FONT_DECL = `font-family:${FONT_STACK};`;

function esc(s: string | number | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Compose the email preheader, the hidden one-liner Gmail (and most other
 *  clients) shows as the inbox preview snippet instead of falling back to
 *  the first visible text in the body. Without one, Gmail picks "Augie ·
 *  Carrier safety check audit@augie.ai" from the top banner, which is
 *  useless for triage. With one, the broker sees the verdict at a glance:
 *
 *    "High · SCHNEIDER NATIONAL · Sender domain doesn't match FMCSA"
 *    "Clean · WERNER ENTERPRISES INC · all checks passed"
 *    "Carrier identity required, send MC or DOT to verify"
 *
 *  Keep it under ~90 chars; Gmail truncates around there. */
function composePreheader(verdict: Verdict): string {
  const c = verdict.carrier;
  if (!c) {
    return "Carrier identity required. Reply with MC or DOT number to run the safety check.";
  }
  const tierLabel = computeDisplayTier(verdict);
  const carrierName = c.legalName ?? `DOT ${c.dotNumber}`;

  // Pick the most decision-relevant finding to surface in the preview.
  // Skip the audit-tier-echo signals ("Carrier in Critical tier" etc.),
  // they restate the tier we already showed and crowd out the actual
  // finding. Prefer a specific analyzer reason if present (insurance
  // lapsed, chameleon, recent revocation); fall back to the first
  // remaining hard email-side signal; final fallback is a generic
  // "verify before tendering" tail.
  const auditReasonLabel = c.audit.reasonLabels[0];
  const hardSignals = verdict.signals.filter(
    (s) => s.tier !== "info" && s.category !== "audit_tier",
  );
  const dominant = auditReasonLabel || hardSignals[0]?.label;

  if (tierLabel === "Low") {
    return `Low · ${carrierName} · all checks passed.`;
  }
  if (dominant) {
    return `${tierLabel} · ${carrierName} · ${dominant}.`;
  }
  return `${tierLabel} · ${carrierName} · verify before tendering.`;
}

/** Render the preheader as a hidden block at the top of the email body.
 *  Belt-and-suspenders styles cover all the major clients:
 *    display:none     , Gmail / Apple Mail / Outlook web
 *    max-height:0     , guards against clients that ignore display:none
 *    overflow:hidden  , pairs with max-height:0
 *    mso-hide:all     , Outlook desktop (Word rendering engine) */
function renderPreheader(text: string): string {
  return (
    `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;` +
    `font-size:1px;line-height:1px;color:transparent;opacity:0;">` +
    `${esc(text)}` +
    `</div>`
  );
}

/** For Critical verdicts, pick a finding-specific headline instead of the
 *  generic "Do not engage without verification", verification can't change a
 *  revoked authority or $0 insurance, so the action is "stop," not "verify."
 *  Returns the base headline unchanged for non-critical tiers or when no
 *  specific finding pattern matches. */
/** A recent revocation reads as "reinstated" (not a current "do not tender")
 *  only when FMCSA shows the carrier currently active (status_code=A) AND
 *  insurance is restored. status_code=A alone isn't enough — a carrier can read
 *  Active while still carrying $0 BIPD, meaning the lapse that drove the
 *  revocation isn't cured. */
function revocationReinstated(c: NonNullable<Verdict["carrier"]>): boolean {
  const code = (c.statusCode ?? "").toUpperCase();
  const allowed = (c.allowedToOperate ?? "").toUpperCase();
  return code === "A" && allowed !== "N" && (c.bipdAmount ?? 0) > 0;
}

function criticalHeadline(verdict: Verdict, base: string): string {
  const c = verdict.carrier;
  if (!c) return base;
  const tier = c.audit.tier;
  if (tier !== "Critical") return base;

  const reasonsText = c.audit.reasonLabels.join(" ").toLowerCase();
  const findings: string[] = [];
  // Revoked authority, strongest possible signal, takes precedence — but ONLY
  // when the carrier is not currently active. A recent revocation date on a
  // carrier FMCSA still shows active (status_code=A) was reinstated, so
  // "Authority revoked. Do not tender." would be false.
  if (
    !revocationReinstated(c) &&
    c.mostRecentRevocationDate &&
    Date.now() - Date.parse(c.mostRecentRevocationDate) < 24 * 30 * 86400000
  ) {
    findings.push("Authority revoked");
  } else if (c.allowedToOperate != null && c.allowedToOperate !== "Y") {
    findings.push("Not allowed to operate");
  }
  // Missing insurance, also unrecoverable in the moment.
  if ((c.bipdAmount ?? 0) === 0 && !c.bipdInsurer) {
    findings.push("No insurance on file");
  }
  // Chameleon / re-incarnation pattern.
  if (/chameleon|re-incarnation|rapid replace/.test(reasonsText)) {
    findings.push("Likely fraud pattern");
  }

  if (findings.length === 0) return base;
  if (findings.length === 1) return `${findings[0]}. Do not tender.`;
  // Capitalize the first finding, join the rest with " · ", and append the action.
  const first = findings[0];
  const rest = findings.slice(1).join(" · ");
  return `${first} · ${rest}. Do not tender.`;
}

/** Decide which 4-scale tier the pill should display. Starts from the
 *  carrier's audit tier and escalates if email-side signals (identity_
 *  coherence, lane_viability, email_authenticity, chameleon_cluster) fire
 *  harder. Without this, an audit-Low carrier with a sender-domain
 *  mismatch would show "Low" + green pill while the body explained an
 *  impersonation pattern, exactly the contradiction we want to avoid. */
function computeDisplayTier(verdict: Verdict): string {
  const RANK: Record<string, number> = {
    Low: 0, Medium: 1, High: 2, Critical: 3, Verify: 1,
  };
  const TIERS = ["Low", "Medium", "High", "Critical"];
  const auditTier = verdict.carrier?.audit.tier ?? "Verify";
  let maxRank = RANK[auditTier] ?? 1;
  for (const s of verdict.signals) {
    if (s.tier === "info" || s.category === "audit_tier") continue;
    // Map signal-tier to 4-scale rank conservatively:
    //   critical → Critical (3), high → High (2), caution → Medium (1)
    const r = s.tier === "critical" ? 3 : s.tier === "high" ? 2 : 1;
    if (r > maxRank) maxRank = r;
  }
  return TIERS[maxRank];
}

/** Per-field status used to color each "FROM THE EMAIL" pill:
 *   match    = green dot, gray border  (we verified it against FMCSA)
 *   mismatch = red dot, red border     (we verified it and it didn't match)
 *   neutral  = amber dot, amber border (extracted but not independently verified)
 */
type FieldStatus = "match" | "mismatch" | "neutral";

const FIELD_STATUS_COLORS: Record<FieldStatus, { dot: string; border: string }> = {
  match:    { dot: "#2f9742", border: "#e6e5e0" },
  mismatch: { dot: "#b91c1c", border: "#ef9a9a" },
  neutral:  { dot: "#d97706", border: "#fcd34d" },
};

/** Break URL-detector patterns in a value so Gmail / Apple Mail / Outlook
 *  don't auto-link it. Inserts a zero-width space (U+200B) before any dot,
 *  which is invisible to the reader but breaks `[a-z]+\.(com|net|...)` URL
 *  detection. Without this, "gmail.com" rendered as plain text becomes a
 *  blue underlined `<a href="https://gmail.com">` in the recipient's
 *  client, which looks like a phishing-vector hyperlink even though it's
 *  just a domain we extracted from the email. */
function breakUrlPattern(s: string): string {
  return s.replace(/\./g, "​.");
}

function renderFieldPill(label: string, value: string, status: FieldStatus): string {
  const { dot, border } = FIELD_STATUS_COLORS[status];
  return (
    `<span style="display:inline-block;border:1px solid ${border};border-radius:999px;` +
    `padding:5px 12px 5px 10px;margin:0 6px 8px 0;background:#ffffff;` +
    `font-size:13px;line-height:1.3;white-space:nowrap;">` +
      `<span style="color:${dot};font-size:14px;line-height:1;vertical-align:-1px;">&bull;</span>` +
      `&nbsp;<span style="color:${C.inkLabel};">${esc(label)}</span>` +
      // Defeat email-client URL auto-detection on the value text. We also
      // force the inline color via the outer span (in case the client wraps
      // an <a> anyway, the override loses to the client's <a> color in
      // some clients but the ZWSP injection prevents that wrap to begin
      // with).
      `&nbsp;<span style="color:${C.ink};font-weight:600;text-decoration:none;">${esc(breakUrlPattern(value))}</span>` +
    `</span>`
  );
}

/** Render the "FROM THE EMAIL" block, a grid of pills showing each field we
 *  extracted from the broker's forwarded message plus a green/amber/red dot
 *  for whether it matched FMCSA. Lets brokers eyeball at a glance which
 *  claimed details checked out and which didn't, without reading the prose
 *  in the safety-checks section.
 *
 *  Status is derived from the verdict signals:
 *    match    when a "matches FMCSA"-style positive signal fired for that field
 *    mismatch when an evaluator hard-signal flagged that field as wrong
 *    neutral  when the field was extracted but no verification was possible
 *             (e.g. sender display names, or fields with no FMCSA record to
 *             compare against)
 *
 *  Returns empty string when extracted is undefined or nothing meaningful was
 *  pulled out of the email. */
function renderFromTheEmailBlock(
  verdict: Verdict,
  extracted: ExtractedEmail | undefined,
): string {
  if (!extracted) return "";
  const sigs = verdict.signals;
  const cov = verdict.coverage;
  const claims = extracted.identity_claims;
  const sender = extracted.sender_metadata;
  const lane = extracted.lane;

  const hasHard = (predicate: (s: Signal) => boolean) =>
    sigs.some((s) => s.tier !== "info" && predicate(s));

  const pills: string[] = [];

  // Carrier (claimed legal name). Match when name_match passed; mismatch when
  // it failed; neutral when we couldn't check (no FMCSA record, or no name in
  // the email).
  if (claims.claimed_company_name) {
    let status: FieldStatus = "neutral";
    if (cov.name_match_checked) {
      status = hasHard((s) => s.label.toLowerCase().includes("company name"))
        ? "mismatch"
        : "match";
    }
    pills.push(renderFieldPill("Carrier", claims.claimed_company_name, status));
  }

  // MC. Match when MC tied to the same legal entity (no mc# mismatch signal);
  // mismatch when the email claims a different MC than FMCSA has on file.
  if (claims.mc_number) {
    let status: FieldStatus = "neutral";
    if (cov.mc_match_checked) {
      status = hasHard((s) => s.label.toLowerCase().includes("mc# mismatch"))
        ? "mismatch"
        : "match";
    }
    pills.push(renderFieldPill("MC", claims.mc_number, status));
  }

  // DOT. Match when the DOT resolved against the FMCSA snapshot (i.e. a
  // carrier was loaded for this verdict). Mismatch when the email named a
  // DOT but lookup came up empty.
  if (claims.dot_number) {
    const status: FieldStatus = verdict.carrier ? "match" : "mismatch";
    pills.push(renderFieldPill("DOT", String(claims.dot_number), status));
  }

  // Email domain (sender). Match when sender domain aligns with FMCSA email;
  // mismatch when an identity_coherence signal flagged a domain/email
  // disparity; neutral when there's no FMCSA email on file to compare.
  if (sender.sender_email_domain) {
    let status: FieldStatus = "neutral";
    if (cov.sender_domain_match_checked) {
      status = hasHard(
        (s) =>
          s.category === "identity_coherence" &&
          /sender|domain|email/i.test(s.label)
      )
        ? "mismatch"
        : "match";
    }
    pills.push(renderFieldPill("Email domain", sender.sender_email_domain, status));
  }

  // Phone (claimed). Same pattern as the other identity fields.
  if (claims.claimed_phone) {
    let status: FieldStatus = "neutral";
    if (cov.phone_match_checked) {
      status = hasHard((s) => s.label.toLowerCase().includes("phone"))
        ? "mismatch"
        : "match";
    }
    pills.push(renderFieldPill("Phone", claims.claimed_phone, status));
  }

  // Sender display name. We never verify these (display names are trivially
  // spoofable on every email client), so it stays neutral by default.
  if (sender.sender_display_name) {
    pills.push(renderFieldPill("Sender name", sender.sender_display_name, "neutral"));
  }

  // Lane. Match when lane viability passed; mismatch when it failed.
  if (lane.origin_city || lane.origin_state || lane.destination_city || lane.destination_state) {
    const origin = [lane.origin_city, lane.origin_state].filter(Boolean).join(", ");
    const dest = [lane.destination_city, lane.destination_state].filter(Boolean).join(", ");
    const text = `${origin || "?"} → ${dest || "?"}`;
    let status: FieldStatus = "neutral";
    if (cov.lane_viability_checked) {
      status = hasHard(
        (s) =>
          s.category === "lane_viability" &&
          !s.label.toLowerCase().includes("hazmat")
      )
        ? "mismatch"
        : "match";
    }
    pills.push(renderFieldPill("Lane", text, status));
  }

  // Equipment + hazmat get their own pills only when present; both stay
  // neutral since there's nothing in FMCSA to verify equipment against, and
  // hazmat is a load characteristic, not a carrier claim.
  if (lane.equipment_type) {
    pills.push(renderFieldPill("Equipment", lane.equipment_type, "neutral"));
  }
  if (lane.is_hazmat_load) {
    const hazStatus: FieldStatus = cov.hazmat_match_checked
      ? (hasHard((s) => s.label.toLowerCase().includes("hazmat")) ? "mismatch" : "match")
      : "neutral";
    pills.push(renderFieldPill("Load", "Hazmat", hazStatus));
  }

  // Page-captured candidate emails / phones (bookmarklet path): show ALL of
  // them and green-dot the one that matches the carrier's FMCSA contact info.
  const cc = verdict.carrier;
  if (extracted.sender_candidates?.length) {
    const fmcsaEmail = cc?.fmcsaEmail?.toLowerCase() ?? "";
    const fmcsaDomain = cc?.fmcsaEmailDomain?.toLowerCase() ?? "";
    const fmcsaDomFree = /^(gmail|yahoo|hotmail|aol|icloud|outlook|live|msn|comcast|sbcglobal|verizon|att|cox)\.[a-z.]+$/.test(fmcsaDomain);
    const isMatch = (e: string) => {
      const el = e.toLowerCase();
      const dom = el.split("@").pop() ?? "";
      return (!!fmcsaEmail && el === fmcsaEmail) || (!!fmcsaDomain && !fmcsaDomFree && dom === fmcsaDomain);
    };
    pills.push(...renderCandidatePills("Email", extracted.sender_candidates, isMatch));
  }
  if (extracted.phone_candidates?.length) {
    const fmcsa10 = (cc?.fmcsaPhone ?? "").replace(/\D/g, "").slice(-10);
    const isMatch = (p: string) => fmcsa10.length === 10 && p.replace(/\D/g, "").slice(-10) === fmcsa10;
    pills.push(...renderCandidatePills("Phone", extracted.phone_candidates, isMatch));
  }

  if (pills.length === 0) return "";

  return `
    <tr><td style="padding:0 32px 24px 32px;">
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;">What we found</div>
      <div style="background:${C.pageBg};border-radius:6px;padding:14px 14px 6px 14px;">
        ${pills.join("\n        ")}
      </div>
    </td></tr>`;
}

/** Pills for the page's email / phone lists, highlighting the carrier's own
 *  contact (matched to FMCSA, green). Behavior:
 *   - match → show the matched value(s) green + "+N more" (collapse the rest)
 *   - no match, many (>6) → ONE compact count pill (don't dump an inbox wall)
 *   - no match, few → list them (neutral) */
function renderCandidatePills(
  label: string,
  candidates: string[],
  isMatch: (v: string) => boolean,
): string[] {
  const lc = label.toLowerCase();
  const matched = candidates.filter(isMatch);
  const out: string[] = [];
  if (matched.length > 0) {
    matched.slice(0, 2).forEach((v, i) =>
      out.push(renderFieldPill(i === 0 ? label : "", v, "match"))
    );
    const more = candidates.length - Math.min(2, matched.length);
    if (more > 0) out.push(renderMissingPill(`${more} more ${lc}${more === 1 ? "" : "s"}`));
    return out;
  }
  if (candidates.length > 6) {
    // Likely an inbox/list — collapse to a single count rather than a wall.
    return [renderMissingPill(`${candidates.length} ${lc}s on the page · none match FMCSA`)];
  }
  candidates.slice(0, 3).forEach((v, i) =>
    out.push(renderFieldPill(i === 0 ? label : "", v, "neutral"))
  );
  if (candidates.length > 3) out.push(renderMissingPill(`${candidates.length - 3} more ${lc}s`));
  return out;
}

/** The two headline-score tiles (Risk + ISS* est.). */
function renderScoreTiles(c: NonNullable<Verdict["carrier"]>): string {
  const riskColor = auditTierInkOnNeutral(c.audit.tier);
  const iss = c.issScore;
  const issColor =
    iss == null ? C.inkMuted : iss >= 75 ? C.redInkPill : iss >= 50 ? C.amberInkPill : C.greenInkPill;
  const issSub = iss == null ? "no public measure" : iss >= 75 ? "Inspect" : iss >= 50 ? "Optional" : "Pass";
  const tile = (label: string, value: string, sub: string, color: string) =>
    `<td width="50%" style="padding:0 6px;vertical-align:top;">
      <div style="background:${C.pageBg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;">
        <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;">${esc(label)}</div>
        <div style="${FONT_DECL}font-size:30px;font-weight:700;color:${color};line-height:1.1;margin-top:6px;">${esc(value)}</div>
        <div style="font-size:12px;color:${C.inkMuted};margin-top:4px;">${esc(sub)}</div>
      </div>
    </td>`;
  return `
    <tr><td style="padding:0 26px 22px 26px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
        ${tile("Risk score", c.riskScore != null ? String(c.riskScore) : "—", c.audit.tier, riskColor)}
        ${tile("ISS* est.", iss != null ? String(iss) : "—", issSub, issColor)}
      </tr></table>
    </td></tr>`;
}

/** Pick the headline for the no-carrier-resolved case. The wording names the
 *  specific identifier the broker should ask for, so the headline is
 *  actionable instead of just "couldn't verify." */
function noCarrierHeadline(extracted: ExtractedEmail | undefined): string {
  const claims = extracted?.identity_claims;
  const hasMc = !!claims?.mc_number;
  const hasDot = !!claims?.dot_number;
  if (!hasMc && !hasDot) return "Can't verify. No MC or DOT found.";
  if (!hasMc) return "Can't verify. No MC number found.";
  if (!hasDot) return "DOT not in FMCSA snapshot.";
  return "Can't verify the sender.";
}

/** "Not found" pill, same shape as the FROM THE EMAIL pills
 *  but with a dashed border, no status dot, and muted ink. Visually
 *  reinforces "this is something we'd need but don't have," distinct from
 *  the solid pills that show what we *did* find. */
function renderMissingPill(label: string): string {
  return (
    `<span style="display:inline-block;border:1px dashed ${C.borderStrong};border-radius:999px;` +
    `padding:5px 12px;margin:0 6px 8px 0;background:#ffffff;` +
    `font-size:13px;line-height:1.3;color:${C.inkLabel};white-space:nowrap;">` +
      `+ ${esc(label)}` +
    `</span>`
  );
}

/** Render the MISSING FROM THE EMAIL + SUGGESTED REPLY block shown when no
 *  carrier was resolved. Lists the specific identifiers we need to actually
 *  run the safety check, then gives the broker copy-pasteable reply text. */
function renderNoCarrierFollowupBlock(extracted: ExtractedEmail | undefined): string {
  const claims = extracted?.identity_claims;
  const missing: string[] = [];
  if (!claims?.mc_number) missing.push("MC number");
  if (!claims?.dot_number) missing.push("DOT number");
  if (!claims?.claimed_company_name) missing.push("Carrier legal name");

  // Reply text, name the carrier's contact when we extracted one, otherwise
  // a generic "Hi". Always include the missing-fields ask so the broker can
  // forward verbatim.
  const contactName =
    claims?.contact_person ||
    extracted?.sender_metadata?.sender_display_name?.split(" ")[0] ||
    "";
  const greeting = contactName ? `Hi ${esc(contactName)},` : "Hi,";
  const ask =
    missing.length === 3
      ? "before I can quote, can you send your MC or DOT number, plus the legal name on your authority?"
      : missing.length > 0
        ? `before I can quote, can you send your ${joinMissingForReply(missing)}?`
        : "can you confirm the MC and DOT on file for your authority?";
  const reply = `${greeting} ${ask} Thanks.`;

  const missingBlock =
    missing.length > 0
      ? `
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;">Not found</div>
      <div style="margin-bottom:18px;">
        ${missing.map(renderMissingPill).join("\n        ")}
      </div>`
      : "";

  const suggestedReplyBlock = `
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;">Suggested reply</div>
      <div style="background:${C.pageBg};border:1px solid ${C.border};border-radius:6px;padding:14px 16px;font-size:14px;color:${C.ink};line-height:1.5;">
        ${esc(reply)}
      </div>`;

  return `
    <tr><td style="padding:0 32px 24px 32px;">
      ${missingBlock}
      ${suggestedReplyBlock}
    </td></tr>`;
}

/** Join missing-field labels into a natural sentence fragment for the reply
 *  text. ["MC number", "DOT number"] -> "MC or DOT number, and legal name". */
function joinMissingForReply(missing: string[]): string {
  // Collapse MC/DOT into "MC or DOT" since they're alternatives.
  const hasMc = missing.includes("MC number");
  const hasDot = missing.includes("DOT number");
  const hasName = missing.includes("Carrier legal name");
  const parts: string[] = [];
  if (hasMc && hasDot) parts.push("MC or DOT number");
  else if (hasMc) parts.push("MC number");
  else if (hasDot) parts.push("DOT number");
  if (hasName) parts.push("legal name on your authority");
  if (parts.length === 0) return "MC and DOT number";
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1];
}

/** Map the analyzer's axis status to the same colors the website uses. */
function axisColor(status: string): string {
  if (status === "critical" || status === "severe") return C.redInkPill;
  if (status === "high") return "#7c2d12"; // tailwind orange-900
  if (status === "elevated") return C.amberInkPill;
  return C.ink;
}

/** BIPD amounts come from FMCSA in **thousands** (1000 = $1M, 750 = $750k).
 *  Match the website's formatter (`fmtMoney` in lib/analyzer.ts) so the
 *  email and the web view read the same. */
function formatBipd(amountInThousands: number): string {
  if (amountInThousands >= 1000) {
    const m = amountInThousands / 1000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  return `$${amountInThousands}k`;
}

function formatPhone(p: string): string {
  const d = p.replace(/\D/g, "");
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.length === 11 && d.startsWith("1"))
    return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  return p;
}

const OPERATING_AREA_LABEL: Record<string, string> = {
  interstate_otr: "Interstate, long-haul",
  interstate_local: "Interstate within 100 miles",
  intrastate_long: "Intrastate, beyond 100 miles",
  intrastate_local: "Intrastate within 100 miles",
  unknown: "Unspecified",
};

function ageFromYear(yearStr: string | null | undefined): string | null {
  if (!yearStr) return null;
  const y = parseInt(yearStr, 10);
  if (!Number.isFinite(y)) return null;
  const yrs = new Date().getFullYear() - y;
  return `Issued ${yearStr} · ${yrs} yrs`;
}

/** All the checks the system performs, with each marked as passed (ran and
 *  produced no hard finding), failed (ran and fired a critical/high/caution
 *  signal, those surface separately in "What we found"), or skipped (the
 *  email didn't include the inputs we'd need to run it).
 *
 *  Reads coverage flags + the signal list together so we can confidently say
 *  "MC match passed" only when (a) we had inputs and (b) no MC-mismatch
 *  signal fired. */
export type CheckStatus = "passed" | "failed" | "skipped";
export interface CheckRow {
  status: CheckStatus;
  label: string;
  detail: string;
}

export function buildChecksRun(verdict: Verdict): CheckRow[] {
  const cov = verdict.coverage;
  const sigs = verdict.signals;
  const c = verdict.carrier;

  const hasHardSignal = (predicate: (s: Signal) => boolean) =>
    sigs.some((s) => s.tier !== "info" && predicate(s));
  /** Find the first hard signal matching the predicate, so a failed check row
   *  can surface the concrete evaluator detail (e.g. "Sender at gmail.com
   *  doesn't match FMCSA-registered schneider.com") instead of a generic
   *  fallback. */
  const findHardSignal = (predicate: (s: Signal) => boolean): Signal | undefined =>
    sigs.find((s) => s.tier !== "info" && predicate(s));

  const rows: CheckRow[] = [];

  // Carrier audit, each analyzer reason becomes its own failed-check row so
  // critical issues (insurance lapse, rapid replace, recent revocation,
  // chameleon cluster) get individual visibility instead of being collapsed
  // into one "DOT active" finding. The reason's detail string carries the
  // explanation. When no audit hits fired, surface a single passed row.
  if (cov.audit_tier && c) {
    if (c.audit.reasons.length === 0) {
      rows.push({
        status: "passed",
        label: "DOT active and in good standing",
        detail: "Active authority, no revocations or recent enforcement issues in FMCSA history.",
      });
    } else {
      for (const r of c.audit.reasons) {
        rows.push({
          status: "failed",
          // Labels are plain text (no glyphs) by registry convention; the
          // tier-colored ✗ icon to the left of the row provides the
          // visual severity, so we don't need an emoji in the label too.
          label: r.label,
          detail: r.detail,
        });
      }
    }
  }

  // Insurance, explicit failed row when BIPD is missing AND FMCSA requires
  // it. Many carriers (intrastate-only, private, owner-op without property
  // authority) legally don't need BIPD on file, flagging those as
  // "No insurance" creates Critical-tier false positives. We mirror the
  // audit's logic (analyzer.ts > classifyInsurance), which only fires when
  // fmcsaRequired > 0 AND onFile === 0.
  if (c) {
    const fmcsaRequired = c.bipdRequiredAmount ?? 0;
    const onFile = c.bipdAmount ?? 0;
    const hasInsurance = onFile > 0 || !!c.bipdInsurer;
    if (fmcsaRequired > 0 && !hasInsurance) {
      rows.push({
        status: "failed",
        label: "No active BIPD insurance",
        detail: `FMCSA requires ${formatBipd(fmcsaRequired)} BIPD for this carrier's authority, but $0 is on file. Tendering freight to an uninsured carrier exposes the broker to the full loss.`,
      });
    } else if (hasInsurance) {
      const amount = onFile > 0 ? formatBipd(onFile) : null;
      const insurer = c.bipdInsurer ?? "insurer on file";
      rows.push({
        status: "passed",
        label: amount ? `Active BIPD insurance: ${amount}` : "Active BIPD insurance on file",
        detail: `${insurer}. Coverage current, no lapses in the most recent FMCSA snapshot. Verify the COI before booking; freight over $750k (or hazmat over $1M / $5M) needs higher coverage.`,
      });
    }
    // No row at all when FMCSA doesn't require BIPD AND none is on file,
    // there's nothing wrong, and no positive verification to report either.
  }

  // MC match
  if (cov.mc_match_checked) {
    const sig = findHardSignal((s) => s.label.toLowerCase().includes("mc# mismatch"));
    const fail = !!sig;
    rows.push({
      status: fail ? "failed" : "passed",
      // Label states the OUTCOME so it reads correctly next to the status icon.
      // "MC number matches" + ✓ scans clean; "MC number matches" + ✗ scans as a
      // contradiction. Flip the label per status instead of leaving it neutral.
      label: fail
        ? "MC number doesn't match FMCSA"
        : "MC number tied to same legal entity",
      // When failed, prefer the evaluator's concrete detail (which names the
      // claimed vs. registered MC numbers) over a generic fallback.
      detail: fail
        ? (sig!.detail || "MC number doesn't match FMCSA's registered MC for this DOT.")
        : `MC ties to ${c?.legalName ?? "this carrier"}. No reassignment, no recent changes.`,
    });
  } else {
    rows.push({
      status: "skipped",
      label: "MC number match",
      detail: "No MC number found to compare to FMCSA.",
    });
  }

  // Sender identity (domain for business, full email for free-mail)
  if (cov.sender_domain_match_checked) {
    const sig = findHardSignal(
      (s) => s.category === "identity_coherence" && /sender|domain|email/i.test(s.label)
    );
    const fail = !!sig;
    rows.push({
      status: fail ? "failed" : "passed",
      label: fail
        ? "Sender identity doesn't match FMCSA records"
        : "Sender identity matches FMCSA records",
      // Surface the evaluator's concrete sender-vs-FMCSA domain pair when
      // failed (e.g. "Email comes from gmail.com, but FMCSA records
      // Schneider National at schneider.com..."). The generic fallback only
      // kicks in if the signal detail somehow came through empty.
      detail: fail
        ? (sig!.detail || "Sender's email doesn't match the address FMCSA has on file for this DOT.")
        : "From: address aligns with the email FMCSA has registered for this carrier.",
    });
  } else {
    rows.push({
      status: "skipped",
      label: "Sender domain / email match",
      detail: "FMCSA has no email on file for this DOT, so we couldn't compare.",
    });
  }

  // Company name match
  if (cov.name_match_checked) {
    const sig = findHardSignal((s) => s.label.toLowerCase().includes("company name"));
    const fail = !!sig;
    rows.push({
      status: fail ? "failed" : "passed",
      label: fail
        ? "Carrier name doesn't match FMCSA"
        : "Carrier name matches FMCSA",
      detail: fail
        ? (sig!.detail || "Name doesn't match FMCSA's legal name for this DOT.")
        : "Carrier name in the email matches FMCSA's legal name on file.",
    });
  } else {
    rows.push({
      status: "skipped",
      label: "Company name match",
      detail: "No company name found to compare.",
    });
  }

  // Phone match
  if (cov.phone_match_checked) {
    const sig = findHardSignal((s) => s.label.toLowerCase().includes("phone"));
    const fail = !!sig;
    rows.push({
      status: fail ? "failed" : "passed",
      label: fail
        ? "Phone doesn't match FMCSA"
        : "Phone matches FMCSA",
      detail: fail
        ? (sig!.detail || "Phone doesn't match FMCSA's registered phone.")
        : "Phone in the email matches the number FMCSA has on file.",
    });
  } else {
    rows.push({
      status: "skipped",
      label: "Phone match",
      detail: "No phone number found to verify against FMCSA.",
    });
  }

  // Lane viability, honest phrasing about what we actually checked.
  // For long-haul interstate carriers (the common case) ANY state-to-state
  // lane is in scope; the lane info is confirmational, not gating. The
  // gate is whether the carrier has interstate authority at all, plus a
  // soft check for "interstate within 100 miles" carriers on long lanes.
  if (cov.lane_viability_checked) {
    const fail = hasHardSignal((s) => s.category === "lane_viability" && !s.label.toLowerCase().includes("hazmat"));
    rows.push({
      status: fail ? "failed" : "passed",
      label: "Lane viability",
      detail: fail
        ? "Carrier's MCS-150 operating area doesn't support this lane. See Issues above."
        : "Carrier has interstate authority on file with FMCSA. Any state-to-state lane is in scope.",
    });
  } else {
    rows.push({
      status: "skipped",
      label: "Lane viability",
      detail: "No clear origin / destination lane found to check.",
    });
  }

  // Sender-domain config, based on the DNS lookups (MX/SPF/DMARC existence),
  // NOT per-message SPF/DKIM/DMARC (which inline forwards strip). Passed =
  // configured for authenticated email, no MX issues. Failed = MX missing.
  // Free-email senders (gmail.com etc.) are recorded as "Trusted provider",
  // meaningful in a
  // different way: the domain itself is fine, the open question is whether
  // the specific account was claimed by the carrier (handled by the local-
  // part match check above).
  const senderDomainHard = sigs.some(
    (s) => s.tier !== "info" && s.category === "email_authenticity" &&
    /no mx/i.test(s.label)
  );
  const isFreeMailDomain = sigs.some(
    (s) => s.tier === "info" && s.category === "email_authenticity" &&
    /matches FMCSA/i.test(s.label) && /free-mail/i.test(s.detail)
  );
  if (senderDomainHard) {
    rows.push({
      status: "failed",
      label: "Sender domain configured for business email",
      detail: "Sender's domain is missing mail-server DNS.",
    });
  } else if (isFreeMailDomain) {
    rows.push({
      status: "passed",
      label: "Sender on a trusted email provider",
      detail: "Sender is on a well-known free-mail provider. We verified the full address matches FMCSA's record for this DOT, which is what identifies the sender on shared providers.",
    });
  } else {
    // For business domains: passed when no hard finding fired. Detail
    // explains the domain-level (not per-message) nature of the check.
    rows.push({
      status: "passed",
      label: "Sender domain configured for business email",
      detail: "Sender's domain accepts inbound mail and publishes SPF or DMARC — set up like a real business. This is domain reputation, not message-level authentication.",
    });
  }

  // Chameleon-cluster (sibling/predecessor sharing identity)
  if (cov.chameleon_cluster_checked) {
    const fail = hasHardSignal((s) => s.category === "chameleon_cluster");
    rows.push({
      status: fail ? "failed" : "passed",
      label: fail
        ? "Revoked predecessor DOT shares identity"
        : "No revoked predecessor DOTs sharing identity",
      detail: fail
        ? "Sender's phone matches a DOT with prior revocation. Possible chameleon-carrier pattern."
        : "No re-incarnation / chameleon pattern detected based on shared phone identity.",
    });
  }

  // Hazmat, only show when the email pitched a hazmat load
  if (cov.hazmat_match_checked) {
    const fail = hasHardSignal((s) => s.label.toLowerCase().includes("hazmat"));
    rows.push({
      status: fail ? "failed" : "passed",
      label: fail
        ? "Hazmat authorization missing"
        : "Hazmat authorization on file",
      detail: fail
        ? "Carrier is not registered for hazmat but the email pitched a hazmat load."
        : "Carrier's HM_Ind=Y on Census. They're registered to haul hazmat.",
    });
  }

  return rows;
}

function pill(text: string, bg: string, ink: string, opts?: { large?: boolean }): string {
  const padding = opts?.large ? "8px 18px" : "5px 12px";
  const fontSize = opts?.large ? "15px" : "12px";
  // border-radius:999px gives a true pill shape on every modern email client.
  // Outlook desktop strips border-radius entirely and shows a rectangle,
  // acceptable fallback.
  return `<span style="display:inline-block;padding:${padding};background:${bg};color:${ink};font-size:${fontSize};font-weight:600;border-radius:999px;letter-spacing:0.02em;line-height:1.1;margin-right:6px;">${esc(text)}</span>`;
}

function labelValueCell(label: string, value: string): string {
  return `<td style="padding:14px 0;vertical-align:top;width:50%;">
    <div style="color:${C.inkLabel};font-size:11px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;">${esc(label)}</div>
    <div style="color:${C.ink};font-size:14px;font-weight:500;line-height:1.4;">${value}</div>
  </td>`;
}

/**
 * Email-safe horizontal bar with P85/P90/P95 tick markers, plus a fill that
 * shows where the observed value falls. Uses nested <table> with bgcolor
 * attributes so Outlook renders the colors and tick lines.
 *
 * Layout (4 segments + 3 tick lines):
 *   [   0→P85 (green-tint)   ] | [ P85→P90 (amber-tint) ] | [ P90→P95 (orange-tint) ] | [ P95→max (red-tint) ]
 *
 * Fill within each segment shows the observed value: bar is filled from 0
 * to observed-position, and tinted by the band observed lands in.
 *
 * Max-scale = 1.5× P95 so there's always headroom past P95.
 */
function renderBar(
  observed: number,
  cutoffs: { p85: number; p90: number; p95: number },
  height = 10,
  fillColorOverride?: string,
  // Optional tick-label override for rules whose tick positions don't map
  // to the "P85/P90/P95" peer-group percentile metaphor. Order matches
  // the cutoff fields: [label_at_p85, label_at_p90, label_at_p95].
  tickLabelOverride?: [string, string, string],
): string {
  if (!Number.isFinite(observed) || cutoffs.p95 <= 0) return "";
  const { p85, p90, p95 } = cutoffs;
  const maxScale = Math.max(p95 * 1.5, observed * 1.05);
  const pct = (v: number) => Math.max(0, Math.min(100, (v / maxScale) * 100));

  // Convert observed value into a fill width.
  const obsPct = pct(observed);
  // Decide overall fill color from which band observed lands in. When the
  // caller has a non-standard tier mapping (e.g. insurance churn's 2-tier
  // structure), they pass an explicit override.
  const fillColor = fillColorOverride ?? (
    observed >= p95 ? "#a01919" :  // ≥P95, Severe (red)
    observed >= p90 ? "#c2410c" :  // P90-P95, High (orange)
    observed >= p85 ? "#a16207" :  // P85-P90, Elevated (amber)
    "#2f9742"                       // <P85, Clean (green)
  );

  // Track (un-filled) background with subtle zone tints so brokers see where
  // the percentile bands sit even when observed is low.
  const trackP85 = pct(p85);
  const trackP90 = pct(p90);
  const trackP95 = pct(p95);

  // Tick lines: 1px-wide dark cells inserted at the percentile boundaries.
  // We render the BACKGROUND track as zones, then OVERLAY a filled "fill"
  // bar on top via a wrapper trick, but email doesn't have z-index, so
  // instead we render the bar AS the fill and put ticks AS overlay borders.
  // Simpler approach: render the fill row (one solid color up to observed),
  // followed by a SECOND tiny row with tick labels at the boundaries.

  const TICK = "#888888";
  const TRACK = "#eef0eb";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
    <tr>
      <td>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${TRACK};border-radius:${height / 2}px;border-collapse:separate;">
          <tr>
            <!-- 0 → observed: filled -->
            ${obsPct > 0 ? `<td bgcolor="${fillColor}" width="${obsPct.toFixed(2)}%" height="${height}" style="font-size:0;line-height:0;border-radius:${height / 2}px 0 0 ${height / 2}px;">&nbsp;</td>` : ""}
            ${obsPct < 100 ? `<td width="${(100 - obsPct).toFixed(2)}%" height="${height}" style="font-size:0;line-height:0;"></td>` : ""}
          </tr>
        </table>
      </td>
    </tr>
    <!-- Tick label row: P85 / P90 / P95 markers at proportional positions
         (or caller-supplied labels). When two ticks are very close
         (gap < 8% of bar width), we drop the middle label so they don't
         overlap visually. -->
    <tr>
      <td style="padding-top:4px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
          <tr>
            <td width="${trackP85.toFixed(2)}%" align="right" style="font-size:10px;color:${TICK};line-height:1;padding-right:2px;">${tickLabelOverride?.[0] ?? "P85"}</td>
            <td width="${Math.max(0, trackP90 - trackP85).toFixed(2)}%" align="right" style="font-size:10px;color:${TICK};line-height:1;padding-right:2px;">${trackP90 - trackP85 >= 8 ? (tickLabelOverride?.[1] ?? "P90") : ""}</td>
            <td width="${Math.max(0, trackP95 - trackP90).toFixed(2)}%" align="right" style="font-size:10px;color:${TICK};line-height:1;padding-right:2px;">${trackP95 - trackP90 >= 8 ? (tickLabelOverride?.[2] ?? "P95") : ""}</td>
            <td width="${Math.max(0, 100 - trackP95).toFixed(2)}%"></td>
          </tr>
        </table>
      </td>
    </tr>
  </table>`;
}

/** A row in the safety-profile chart, label, observed, multiplier, bar with
 *  P85/P90/P95 markers. Falls back to a text-only row when cutoffs are
 *  degenerate (e.g. owner-op peer group where most carriers have 0 OOS and
 *  all three percentiles collapse to 0), the bar wouldn't be meaningful. */
function renderBarRow(
  label: string,
  observedDisplay: string,
  observed: number | null,
  cutoffs: { p85: number; p90: number; p95: number } | null,
  unit: string = "",
  // Optional override for rules whose tier structure doesn't fit the
  // P85/P90/P95 → Elevated/High/Severe mapping (e.g. insurance churn is a
  // two-tier rule: 3-6 = Elevated, ≥7 = Severe, no High band). When set,
  // these replace the auto-computed badge text and fill color.
  badgeOverride?: { label: string; color: string; fillColor: string },
  // Optional override for the bar's three tick labels. Used when the
  // cutoffs don't correspond to the P85/P90/P95 percentile metaphor.
  tickLabels?: [string, string, string],
): string {
  const cutoffsDegenerate =
    !cutoffs ||
    cutoffs.p95 <= 0 ||
    (cutoffs.p85 === cutoffs.p90 && cutoffs.p90 === cutoffs.p95);
  if (observed == null || cutoffsDegenerate) {
    // Peer group has too few non-zero values to form a meaningful
    // distribution (e.g. owner-op hazmat OOS where most carriers have 0).
    // Still render a placeholder bar for visual consistency with other
    // axes, fully empty when observed=0 (just the gray track), fully red
    // when observed>0 (above peer typical).
    const nonTrivial = observed != null && observed > 0;
    const indicator = nonTrivial
      ? `<span style="color:${C.redInkPill};font-weight:600;font-size:12px;">above peer typical</span>`
      : `<span style="color:${C.inkMuted};font-size:12px;">peer baseline ≈ 0</span>`;
    const placeholderBar = nonTrivial
      ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef0eb;border-radius:5px;border-collapse:separate;">
          <tr><td bgcolor="#a01919" width="100%" height="10" style="font-size:0;line-height:0;border-radius:5px;">&nbsp;</td></tr>
        </table>`
      : `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#eef0eb;border-radius:5px;border-collapse:separate;">
          <tr><td width="100%" height="10" style="font-size:0;line-height:0;"></td></tr>
        </table>`;
    return `<tr>
      <td colspan="2" style="padding:12px 0 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="font-size:13px;color:${C.ink};font-weight:500;">${esc(label)}</td>
            <td style="font-size:13px;color:${C.ink};text-align:right;">
              <span style="color:${C.ink};font-weight:600;">${esc(observedDisplay)}</span>
              &nbsp;&nbsp; ${indicator}
            </td>
          </tr>
        </table>
        <div style="margin-top:6px;">${placeholderBar}</div>
      </td>
    </tr>`;
  }
  const { p85, p90, p95 } = cutoffs;
  // Band label: where does observed fall in the percentile distribution?
  // Auto-computed unless the caller supplied a badgeOverride.
  const band = badgeOverride ?? (
    observed >= p95 ? { label: "≥P95 · Severe", color: C.redInkPill, fillColor: "#a01919" } :
    observed >= p90 ? { label: "≥P90 · High", color: "#7c2d12", fillColor: "#c2410c" } :
    observed >= p85 ? { label: "≥P85 · Elevated", color: C.amberInkPill, fillColor: "#a16207" } :
    { label: "below P85", color: C.inkMuted, fillColor: "#2f9742" }
  );
  return `<tr>
    <td colspan="2" style="padding:12px 0 0 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr>
          <td style="font-size:13px;color:${C.ink};font-weight:500;">${esc(label)}</td>
          <td style="font-size:13px;color:${C.ink};text-align:right;">
            <span style="color:${C.ink};font-weight:600;">${esc(observedDisplay)}</span>
            &nbsp;&nbsp; <span style="color:${band.color};font-weight:600;font-size:12px;">${band.label}</span>
          </td>
        </tr>
      </table>
      <div style="margin-top:6px;">${renderBar(observed, cutoffs, 10, badgeOverride?.fillColor, tickLabels)}</div>
    </td>
  </tr>`;
}

/** Parse the analyzer's detail string to extract the peer-group cutoff value.
 *
 *  Two formats to handle, depending on whether the axis is flagged:
 *    - Clean axis: "...P85 cutoff of 24%." or "...P85 cutoff of 0.99."
 *      (cutoff value follows "of", not parenthesized)
 *    - Flagged axis: "...cutoff for Large (251-1000) fleets (29%)."
 *      (cutoff value in trailing parens, but the peer-group descriptor
 *      "(251-1000)" is also parenthesized, so a naive "last parens" match
 *      would have picked that up. Use "fleets (X)" anchor instead.)
 */
function parseP95(detail: string | null | undefined): number | null {
  if (!detail) return null;
  // Format 1: "cutoff of X" (clean, below threshold).
  const m1 = detail.match(/cutoff\s+of\s+([\d.]+)/i);
  if (m1) {
    const v = parseFloat(m1[1]);
    return Number.isFinite(v) ? v : null;
  }
  // Format 2: "fleets (X)" or "fleets (X%)" (flagged, above threshold).
  const m2 = detail.match(/fleets\s+\(([\d.]+)%?\)/i);
  if (m2) {
    const v = parseFloat(m2[1]);
    return Number.isFinite(v) ? v : null;
  }
  return null;
}

function renderDetailSection(c: NonNullable<Verdict["carrier"]>): string {
  // The 7 FMCSA SMS BASICs as peer-ranked percentiles (0-100, higher = worse).
  // FMCSA only publishes a percentile when the carrier has enough inspection
  // data, so many read "no public measure" — that's the real FMCSA state.
  const pctCell = (pct: number | null, alert: boolean): string => {
    if (pct == null) {
      return `<span style="color:${C.inkMuted};font-size:13px;">no public measure</span>`;
    }
    const v = Math.round(pct);
    const color = alert ? C.redInkPill : v >= 90 ? "#7c2d12" : v >= 80 ? C.amberInkPill : C.ink;
    const weight = alert || v >= 80 ? "700" : "600";
    return (
      `<span style="color:${color};font-weight:${weight};font-size:14px;">${v}` +
      `<span style="color:${C.inkLabel};font-weight:400;font-size:11px;"> /100</span></span>` +
      (alert ? ` <span style="color:${C.redInkPill};font-weight:700;font-size:11px;">ALERT</span>` : "")
    );
  };
  const rows = c.basics
    .map(
      (b) => `<tr>
        <td style="padding:8px 0;color:${C.ink};font-size:13px;border-top:1px solid ${C.border};">${esc(b.name)}</td>
        <td style="padding:8px 0;text-align:right;border-top:1px solid ${C.border};">${pctCell(b.percentile, b.alert)}</td>
      </tr>`
    )
    .join("\n");
  const alerted = c.basics.filter((b) => b.alert).map((b) => b.name);
  const alertBlock = alerted.length
    ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid ${C.border};">
        <div style="font-size:11px;font-weight:600;color:${C.redInkPill};letter-spacing:0.06em;text-transform:uppercase;margin-bottom:8px;">FMCSA alerts</div>
        <div>${alerted
          .map(
            (a) =>
              `<span style="display:inline-block;padding:3px 10px;background:${C.redBgPill};color:${C.redInkPill};font-size:12px;font-weight:600;border-radius:999px;margin:0 4px 6px 0;">${esc(a)}</span>`
          )
          .join("")}</div>
        <div style="font-size:12px;color:${C.inkMuted};margin-top:2px;line-height:1.5;">At or above FMCSA's intervention threshold on the flagged BASIC(s) — eligible for compliance review.</div>
      </div>`
    : `<div style="margin-top:14px;padding-top:12px;border-top:1px solid ${C.border};font-size:12px;color:${C.inkMuted};">No BASIC alerts above FMCSA's intervention threshold.</div>`;
  return `
    <tr><td style="padding:24px 32px;border-top:1px solid ${C.border};">
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:4px;">FMCSA SMS BASICs</div>
      <div style="font-size:12px;color:${C.inkMuted};margin-bottom:8px;line-height:1.5;">Peer-ranked percentile (0–100, higher = worse). FMCSA publishes one only with enough inspection data.</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        ${rows}
      </table>
      ${alertBlock}
    </td></tr>`;
}

function verifiedRow(signal: Signal): string {
  return `<tr>
    <td style="padding:10px 0;vertical-align:top;width:28px;">
      <div style="width:20px;height:20px;border-radius:10px;background:${C.greenCheck};color:#fff;font-size:13px;line-height:20px;text-align:center;font-weight:700;">✓</div>
    </td>
    <td style="padding:10px 0 10px 12px;vertical-align:top;">
      <div style="color:${C.ink};font-size:14px;font-weight:600;line-height:1.4;margin-bottom:2px;">${esc(signal.label)}</div>
      <div style="color:${C.inkMuted};font-size:13px;line-height:1.5;">${esc(signal.detail)}</div>
    </td>
  </tr>`;
}

function hardSignalRow(signal: Signal): string {
  const tierBg = signal.tier === "critical" ? C.redBgPill : signal.tier === "high" ? C.amberBgPill : C.yellowBgPill;
  const tierInk = signal.tier === "critical" ? C.redInkPill : signal.tier === "high" ? C.amberInkPill : C.yellowInkPill;
  const tierGlyph = signal.tier === "critical" ? "!" : signal.tier === "high" ? "!" : "·";
  return `<tr>
    <td style="padding:10px 0;vertical-align:top;width:28px;">
      <div style="width:20px;height:20px;border-radius:10px;background:${tierBg};color:${tierInk};font-size:13px;line-height:20px;text-align:center;font-weight:700;">${tierGlyph}</div>
    </td>
    <td style="padding:10px 0 10px 12px;vertical-align:top;">
      <div style="color:${C.ink};font-size:14px;font-weight:600;line-height:1.4;margin-bottom:2px;">${esc(signal.label)}</div>
      <div style="color:${C.inkMuted};font-size:13px;line-height:1.5;">${esc(signal.detail)}</div>
    </td>
  </tr>`;
}

export function buildReplyHtml(verdict: Verdict, extracted?: ExtractedEmail): string {
  const c = verdict.carrier;
  // Pill label: start with the carrier's audit tier (website 5-scale), then
  // escalate if email-side signals (identity coherence, lane viability,
  // email authenticity) fire harder than the audit. A Clean-on-FMCSA carrier
  // emailed-from-impersonator should NOT show as Clean, that contradicts
  // the body's findings and misleads a glancing reader.
  const computedTierLabel = computeDisplayTier(verdict);
  const baseTier = AUDIT_TIER_STYLES[computedTierLabel] ?? DEFAULT_TIER_STYLE;
  // For Critical/Severe, "do not engage without verification" is misleading
  // when no verification can change the outcome (revoked authority, $0
  // insurance, chameleon pattern). Override the generic headline with the
  // dominant decision-relevant finding so a glancing reader gets the actual
  // recommended action.
  //
  // For the no-carrier case (no DOT/MC, or DOT not found in FMCSA), the
  // generic "Elevated · Worth a closer look" reads as if we found something
  // mild. Override with a specific "Need MC / DOT" pill and a headline that
  // names the missing identifier so the broker knows exactly what to ask for.
  const tier = !c
    ? { ...DEFAULT_TIER_STYLE, headline: noCarrierHeadline(extracted) }
    : { ...baseTier, headline: criticalHeadline(verdict, baseTier.headline) };
  const tierLabel = !c ? "Need MC / DOT" : computedTierLabel;

  // Checks list, every system check with pass/fail/skip status. Powers both
  // the counter and the VERIFIED + SKIPPED sections so they stay in sync.
  const checks = buildChecksRun(verdict);
  const passedChecks = checks.filter((r) => r.status === "passed");
  const failedChecks = checks.filter((r) => r.status === "failed");
  const skippedChecks = checks.filter((r) => r.status === "skipped");
  const cov = {
    passed: passedChecks.length,
    failed: failedChecks.length,
    skipped: skippedChecks.length,
  };

  // Hard signals fired (critical/high/caution) → "What we found" section.
  // Suppress audit_tier signals here, their reasons already populate the
  // headline summary, and the FMCSA DETAIL block surfaces the underlying
  // data (BASIC alerts, insurance churn, crashes, OOS rates). Showing the
  // audit-tier wrapper too would be a third statement of the same finding.
  // Context = info-tier signals NOT already covered by passedChecks.
  const hardSignals = verdict.signals.filter(
    (s) => s.tier !== "info" && s.category !== "audit_tier"
  );
  const contextSignals = verdict.signals.filter(
    (s) =>
      s.tier === "info" &&
      !/passed|matches|active|registered|years|good standing/i.test(s.label)
  );

  // Carrier identity grid rows: build pairs of cells, two per <tr>.
  const carrierRows: string[] = [];
  if (c) {
    const cells: string[] = [];
    // Authority cell, when authority has been recently revoked OR is
    // currently flagged as not-allowed-to-operate, that fact replaces the
    // issue date entirely (red). The revocation date is the single most
    // decision-relevant fact for a flagged carrier, a glancing reader
    // should not come away thinking "valid authority since 2022" when the
    // carrier was actually revoked 4 months ago.
    const revokeMs = c.mostRecentRevocationDate ? Date.parse(c.mostRecentRevocationDate) : NaN;
    const revokeRecent =
      Number.isFinite(revokeMs) && Date.now() - revokeMs < 24 * 30 * 86400000;
    const active = revocationReinstated(c);
    const notAllowed = c.allowedToOperate != null && c.allowedToOperate !== "Y";
    if (revokeRecent && c.mostRecentRevocationDate && !active) {
      const daysAgo = Math.round((Date.now() - revokeMs) / 86400000);
      const ago = daysAgo < 60 ? `${daysAgo} days ago` : `${Math.round(daysAgo / 30)} mo ago`;
      cells.push(labelValueCell(
        "Authority",
        `<span style="color:${C.redInkPill};font-weight:700;">REVOKED ${esc(c.mostRecentRevocationDate)}</span> <span style="color:${C.inkMuted};font-weight:400;">(${esc(ago)})</span>`
      ));
    } else if (revokeRecent && c.mostRecentRevocationDate && active) {
      // Revoked then reinstated — currently active. Amber, not red: a pattern
      // risk to verify, not a current "do not tender" revocation.
      const daysAgo = Math.round((Date.now() - revokeMs) / 86400000);
      const ago = daysAgo < 60 ? `${daysAgo} days ago` : `${Math.round(daysAgo / 30)} mo ago`;
      cells.push(labelValueCell(
        "Authority",
        `<span style="color:${C.amberInkPill};font-weight:700;">Active</span> <span style="color:${C.inkMuted};font-weight:400;">· revoked ${esc(c.mostRecentRevocationDate)} (${esc(ago)}), since reinstated</span>`
      ));
    } else if (notAllowed) {
      cells.push(labelValueCell(
        "Authority",
        `<span style="color:${C.redInkPill};font-weight:700;">NOT ALLOWED TO OPERATE</span>`
      ));
    } else {
      const authority = ageFromYear(c.dotIssued);
      if (authority) cells.push(labelValueCell("Authority", esc(authority)));
    }
    if (c.powerUnits) {
      const driverPart = c.drivers ? ` · ${c.drivers} driver${c.drivers === 1 ? "" : "s"}` : "";
      cells.push(labelValueCell("Fleet", `${c.powerUnits} power unit${c.powerUnits === 1 ? "" : "s"}${driverPart}`));
    }
    if (c.operatingArea) cells.push(labelValueCell("Operation", esc(OPERATING_AREA_LABEL[c.operatingArea] ?? c.operatingArea)));
    if (c.cargoCapabilities.length > 0) cells.push(labelValueCell("Cargo", esc(c.cargoCapabilities.join(", "))));
    if (c.fmcsaPhone) cells.push(labelValueCell("Phone on file", esc(formatPhone(c.fmcsaPhone))));
    if (c.fmcsaEmail) cells.push(labelValueCell("Email on file", esc(c.fmcsaEmail)));
    else if (c.fmcsaEmailDomain) cells.push(labelValueCell("Email on file", `@${esc(c.fmcsaEmailDomain)}`));
    if (c.bipdInsurer || c.bipdAmount) {
      const amount = c.bipdAmount ? formatBipd(c.bipdAmount) : null;
      const value = c.bipdInsurer && amount
        ? `${esc(amount)} <span style="color:${C.inkMuted};font-weight:400;">· ${esc(c.bipdInsurer)}</span>`
        : esc(c.bipdInsurer ?? amount ?? "");
      cells.push(labelValueCell("BIPD insurance", value));
    }
    if (c.cargoInsurer || c.cargoInsuranceOnFile) {
      cells.push(labelValueCell(
        "Cargo insurance",
        c.cargoInsurer ? esc(c.cargoInsurer) : "On file (no insurer named)"
      ));
    }
    if (c.inspections24mo > 0) {
      const crashPart = c.crashes24mo > 0
        ? ` <span style="color:${C.amberInkPill};font-weight:600;">· ${c.crashes24mo} crash${c.crashes24mo === 1 ? "" : "es"}</span>`
        : "";
      cells.push(labelValueCell("Activity (24mo)", `${c.inspections24mo} inspections${crashPart}`));
    }
    if (c.safetyRating && c.safetyRatingDate) {
      const ratingColor =
        c.safetyRating === "Satisfactory" ? C.greenInkPill :
        c.safetyRating === "Conditional" ? C.amberInkPill : C.redInkPill;
      cells.push(labelValueCell(
        "Safety rating",
        `<span style="color:${ratingColor};font-weight:600;">${esc(c.safetyRating)}</span> <span style="color:${C.inkMuted};font-weight:400;">· rated ${esc(c.safetyRatingDate.slice(0, 7))}</span>`
      ));
    }
    if (c.companyOfficer) {
      cells.push(labelValueCell("Primary officer", esc(c.companyOfficer)));
    }
    // No separate "Audit tier" cell, the verdict pill at the top of the
    // email already conveys overall risk. The audit-tier scale (Clean /
    // Elevated / High / Severe / Critical) and the verdict scale (Clean /
    // Caution / High / Critical) used to both appear, which was confusing
    // because they're different scales describing the same carrier.
    for (let i = 0; i < cells.length; i += 2) {
      carrierRows.push(`<tr>${cells[i] ?? ""}${cells[i + 1] ?? '<td style="width:50%"></td>'}</tr>`);
    }
  }

  const carrierHeaderPills = c
    ? [
        pill(`DOT ${c.dotNumber}`, "#eef0eb", C.ink),
        c.mcNumber ? pill(c.mcNumber, "#eef0eb", C.ink) : "",
        c.physicalLocation ? pill(c.physicalLocation, "#eef0eb", C.inkMuted) : "",
      ]
        .filter(Boolean)
        .join("")
    : "";

  const auditUrl = c
    ? `https://augment-carrier-audit.vercel.app/?dot=${c.dotNumber}`
    : "https://augment-carrier-audit.vercel.app/";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Augie carrier safety check</title>
<style>
  /* Force the font stack across every element. Webkit/Blink at heavy weights
     can fall through to the browser default serif when font-family is set
     only on <body>, explicit selectors guarantee consistency. */
  body, table, td, div, span, p, a, h1, h2, h3 {
    ${FONT_DECL}
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
</style>
</head>
<body style="margin:0;padding:0;background:${C.pageBg};font-family:${FONT_STACK};color:${C.ink};">
${renderPreheader(composePreheader(verdict))}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.pageBg};">
<tr><td align="center" style="padding:24px 12px;">

  <!-- Outer card -->
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="640" style="max-width:640px;width:100%;background:${C.cardBg};border:1px solid ${C.border};border-radius:2px;">

    <!-- Top banner -->
    <tr><td style="padding:16px 24px;border-bottom:1px solid ${C.border};">
      <div style="font-size:13px;font-weight:600;color:${C.ink};letter-spacing:0.02em;">
        <span style="color:${C.greenCheck};">●</span> &nbsp;Augie · Carrier safety check
      </div>
    </td></tr>

    <!-- Tier headline -->
    <tr><td style="padding:32px 32px 24px 32px;">
      <div style="margin-bottom:18px;">${pill(tierLabel, tier.bg, tier.ink, { large: false })}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">
        <tr><td style="${FONT_DECL}font-size:24px;font-weight:700;color:${C.ink};line-height:1.25;letter-spacing:-0.01em;padding:0 0 8px 0;mso-line-height-rule:exactly;">
          ${esc(tier.headline)}
        </td></tr>
        <tr><td style="${FONT_DECL}font-size:14px;color:${C.inkMuted};line-height:1.5;">
          ${esc(verdict.summary)}
        </td></tr>
      </table>
    </td></tr>

    ${c ? renderScoreTiles(c) : ""}

    ${!c ? "" : `
    <!-- Small inline check tally (the detail lives in the Safety checks section). -->
    <tr><td style="padding:0 32px 24px 32px;">
      <div style="font-size:12px;color:${C.inkMuted};">
        <span style="color:${C.greenCheck};font-weight:600;">${cov.passed} passed</span>${cov.failed > 0 ? ` · <span style="color:${C.redInkPill};font-weight:600;">${cov.failed} failed</span>` : ""} · ${cov.skipped} skipped
      </div>
    </td></tr>`}

    ${renderFromTheEmailBlock(verdict, extracted)}

    ${!c ? renderNoCarrierFollowupBlock(extracted) : ""}

    ${c ? `
    <!-- Carrier identity -->
    <tr><td style="padding:24px 32px;border-top:1px solid ${C.border};">
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:10px;">Carrier · per FMCSA</div>
      <div style="${FONT_DECL}font-size:18px;font-weight:700;color:${C.ink};line-height:1.3;letter-spacing:-0.005em;text-transform:uppercase;">
        ${esc(c.legalName ?? "(unnamed)")}
      </div>
      <div style="margin-top:12px;margin-bottom:20px;">${carrierHeaderPills}</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:4px;border-collapse:collapse;">
        ${carrierRows.join("\n")}
      </table>
    </td></tr>` : ""}

    ${c && (failedChecks.length + passedChecks.length) > 0 ? `
    <!-- Safety checks, combined section with failed (red ✗) first, then
         passed (green ✓). Order matches the counter at the top of the email
         and mirrors how a broker reads the verdict: "show me what failed,
         then reassure me with what passed." -->
    <tr><td style="padding:24px 32px;border-top:1px solid ${C.border};">
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">Safety checks</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${failedChecks.map((r) => `<tr>
          <td style="padding:10px 0;vertical-align:top;width:28px;">
            <div style="width:20px;height:20px;border-radius:10px;background:${C.redInkPill};color:#fff;font-size:13px;line-height:20px;text-align:center;font-weight:700;">✗</div>
          </td>
          <td style="padding:10px 0 10px 12px;vertical-align:top;">
            <div style="color:${C.ink};font-size:14px;font-weight:600;line-height:1.4;margin-bottom:2px;">${esc(r.label)}</div>
            <div style="color:${C.inkMuted};font-size:13px;line-height:1.5;">${esc(r.detail)}</div>
          </td>
        </tr>`).join("\n")}
        ${passedChecks.map((r) => verifiedRow({ category: "audit_tier", tier: "info", label: r.label, detail: r.detail })).join("\n")}
      </table>
    </td></tr>` : ""}

    ${c ? renderDetailSection(c) : ""}

    ${contextSignals.length > 0 ? `
    <!-- Context -->
    <tr><td style="padding:24px 32px;border-top:1px solid ${C.border};">
      <div style="font-size:11px;font-weight:600;color:${C.inkLabel};letter-spacing:0.08em;text-transform:uppercase;margin-bottom:8px;">Context (not flagged)</div>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        ${contextSignals.map((s) => `<tr>
          <td style="padding:8px 0;vertical-align:top;width:28px;color:${C.inkLabel};font-size:14px;">·</td>
          <td style="padding:8px 0 8px 12px;vertical-align:top;">
            <div style="color:${C.ink};font-size:14px;font-weight:500;line-height:1.4;margin-bottom:2px;">${esc(s.label)}</div>
            <div style="color:${C.inkMuted};font-size:13px;line-height:1.5;">${esc(s.detail)}</div>
          </td>
        </tr>`).join("\n")}
      </table>
    </td></tr>` : ""}

    ${c && skippedChecks.length > 0 ? `
    <!-- Skipped panel, checks we couldn't run because the email didn't include the inputs -->
    <tr><td style="padding:24px 32px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${C.pageBg};border-radius:2px;">
        <tr><td style="padding:16px;">
          <div style="font-size:13px;color:${C.ink};font-weight:600;margin-bottom:8px;">${skippedChecks.length} check${skippedChecks.length === 1 ? "" : "s"} skipped — we couldn't find the inputs we'd need</div>
          ${skippedChecks.map((r) => `<div style="font-size:13px;color:${C.inkMuted};padding:3px 0;">+ ${esc(r.label)}</div>`).join("")}
        </td></tr>
      </table>
    </td></tr>` : ""}

    <!-- Footer, single-DOT review is self-contained; the site link is for
         brokers who want to bookmark or share the full audit view. -->
    <tr><td style="padding:14px 32px;background:${C.pageBg};border-top:1px solid ${C.border};">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
      <tr>
        <td style="font-size:12px;color:${C.inkMuted};">
          <a href="${esc(auditUrl)}" style="color:${C.inkMuted};text-decoration:underline;">View on web</a>
        </td>
        <td style="font-size:12px;color:${C.inkLabel};text-align:right;">${esc(verdict.generatedAt.slice(0, 16).replace("T", " "))} UTC</td>
      </tr>
      </table>
    </td></tr>

  </table>
</td></tr>
</table>
</body>
</html>`;
}
