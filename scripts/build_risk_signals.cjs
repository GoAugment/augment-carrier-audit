/**
 * Offline precompute of the three identity-derived risk signals that
 * /api/analyze needs (free-email-domain, residential-address marker, and the
 * shut-down-identity links). Done ONCE here instead of a 2M-row self-join on
 * every request — see lib/fmcsa-identity.ts (fetchIdentityRiskSignals reads
 * this table by DOT instead of scanning the 96MB identity parquet 3x).
 *
 * Inputs (already present locally / from the monthly refresh):
 *   data/carrier_identity.parquet   (email_address, phone, company_officer_1,
 *                                     email_domain, phy_street)
 *   data/carrier_aggregates.parquet (power_units, home_state_insp_share — the
 *                                     size/geo gates. NOTE: home_state_insp_share
 *                                     is a build-only column that
 *                                     prune_app_parquet drops, so this script
 *                                     MUST run before that step; build_all.py
 *                                     orders it that way.)
 *   data/sources/Company_Census_File.csv + Revocation_-_All_With_History.csv
 *                                    (the shut-down universe + its contacts —
 *                                     see the `shutdowns` CTE for why these are
 *                                     read raw instead of via the aggregate)
 * Output:
 *   data/carrier_risk_signals.parquet  — one row per DOT that has >=1 signal:
 *     DOT_NUMBER, free_email_domain, residential_marker, shutdown_links
 *
 *   node scripts/build_risk_signals.cjs
 * Re-run after each monthly parquet refresh. Bundled into the functions
 * (small), so /api/analyze needs neither the identity Blob nor the self-join.
 */
const duckdb = require("duckdb");
const fs = require("node:fs");
const db = new duckdb.Database(":memory:");
const run = (sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));

// InsHist now arrives as the Socrata mirror's .csv (same 17-column order as
// FMCSA's native header-less .txt, just with a header row — which the
// TRY_CAST(...) > 0 filter below discards anyway). build_all.py exports
// FMCSA_INSHIST; fall back to either filename for a standalone run.
const INSHIST =
  process.env.FMCSA_INSHIST ||
  ["data/sources/inshist_allwithhistory.csv", "data/sources/inshist_allwithhistory.txt"].find((p) =>
    fs.existsSync(p),
  );
if (!INSHIST) {
  throw new Error(
    "InsHist file not found (looked for data/sources/inshist_allwithhistory.{csv,txt}). " +
      "Run: uv run pipeline/fmcsa-aggregate/refresh_sms_data.py --monthly",
  );
}

// The shut-down universe comes from Company Census + Revocation, NOT from
// carrier_aggregates — see the `shutdowns` CTE for why. build_all.py exports
// both paths; fall back to the standard refresh filenames standalone.
const CENSUS = process.env.FMCSA_COMPANY_CENSUS || "data/sources/Company_Census_File.csv";
const REVOCATION = process.env.FMCSA_REVOCATION || "data/sources/Revocation_-_All_With_History.csv";
for (const [label, p] of [["Company Census", CENSUS], ["Revocation", REVOCATION]]) {
  if (!fs.existsSync(p)) {
    throw new Error(
      `${label} file not found at ${p}. Run: uv run pipeline/fmcsa-aggregate/refresh_sms_data.py --monthly`,
    );
  }
}

// A contact value shared by more than this many DISTINCT carriers (live AND
// shut-down, counted together) is a shared service — a dispatcher, a filing
// agent, a leasing company — not one operator behind two DOTs. Measured on the
// 2026-08 data: capping across the combined universe rather than the shut-down
// side alone lifts revoke-lift from 2.24x to 2.46x at comparable recall, and
// 6 is the knee (cap 3 buys +0.04x for -3.3k carriers).
const MAX_CONTACT_CLUSTER = 6;
// The consumer (lib/fmcsa-identity.ts) slices to 5 links; cap at the source so
// the bundled parquet can't blow up on a carrier matching hundreds of DOTs.
const MAX_LINKS_PER_DOT = 5;

// Mirror lib/fmcsa-identity.ts FREE_EMAIL_DOMAINS exactly.
const FREE = ["gmail.com","yahoo.com","hotmail.com","outlook.com","aol.com","icloud.com","me.com","msn.com","live.com","comcast.net","sbcglobal.net","att.net","ymail.com","proton.me","protonmail.com","mail.com"];
const freeList = FREE.map((d) => `'${d}'`).join(",");
// Mirror residentialAddressMarker(): APT/APARTMENT/TRLR/TRAILER/LOT/SPC/SPACE/MOBILE HOME as a token.
const RES_RE = '(^|[^A-Z])(APT|APARTMENT|TRLR|TRAILER|LOT|SPC|SPACE|MOBILE HOME)([^A-Z]|$)';

async function main() {
  const t0 = Date.now();
  await run(`
    COPY (
      WITH idn AS (
        SELECT DOT_NUMBER AS dot,
          lower(trim(coalesce(email_address,''))) AS email,
          regexp_replace(coalesce(phone,''),'[^0-9]','','g') AS phone_norm,
          upper(trim(coalesce(company_officer_1,''))) AS officer,
          lower(trim(coalesce(email_domain,''))) AS email_domain,
          upper(coalesce(phy_street,'')) AS street_u,
          upper(trim(coalesce(phy_state,''))) AS phy_state,
          -- NANP area code = first 3 of the last 10 digits, only when plausible
          CASE WHEN length(regexp_replace(coalesce(phone,''),'[^0-9]','','g')) >= 10
               THEN substr(
                 regexp_replace(coalesce(phone,''),'[^0-9]','','g'),
                 length(regexp_replace(coalesce(phone,''),'[^0-9]','','g')) - 9, 3)
               ELSE NULL END AS area_code
        FROM read_parquet('data/carrier_identity.parquet')
      ),
      -- Fleet size + home-region inspection share (gates the geo signals to the
      -- small carriers where they carry lift; megafleets operate nationally).
      sz AS (
        SELECT DOT_NUMBER AS dot, power_units, home_state_insp_share,
          -- A CORROBORATED large fleet: claims >=100 power units AND has been
          -- seen operating >=50 distinct inspected VINs. Contact/policy reuse is
          -- an operator-level tell and is meaningless at this scale — a shared
          -- switchboard or a corporate insurance programme is not a chameleon.
          -- Without this, FedEx, UPS, Amazon, Swift and First Student were all
          -- flagged (Werner scored +24 "shares insurance policy with revoked
          -- carrier"), which is a locked-in false positive on the largest
          -- carriers in the country.
          --
          -- Deliberately keyed on INSPECTED VINS, not claimed power units:
          -- carriers that invent a fleet (SHUNDEL JOHNSON 80,000 PU / 0 VINs,
          -- TREASURE DEALS 30,012 PU / 0 VINs) must stay flagged, since the
          -- inflated claim is itself a fraud signal. Splits 1,045 flagged
          -- large carriers into 807 real (suppressed) and 238 claimed-only (kept).
          (power_units >= 100 AND coalesce(pu_vins_inspected, 0) >= 50) AS corroborated_large
        FROM read_parquet('data/carrier_aggregates.parquet')
      ),
      -- Empirical area-code -> home-state map: US area codes don't cross state
      -- lines, so the plurality domicile per area code is its true home state.
      -- Require >=50 carriers on the code so the mapping is stable.
      ac_map AS (
        WITH c AS (
          SELECT area_code AS ac, phy_state, COUNT(*) n FROM idn
          WHERE area_code ~ '^[2-9][0-9][0-9]$' AND phy_state <> '' GROUP BY 1,2
        ),
        r AS (
          SELECT ac, phy_state, n,
            row_number() OVER (PARTITION BY ac ORDER BY n DESC) rk,
            SUM(n) OVER (PARTITION BY ac) tot
          FROM c
        )
        SELECT ac, MAX(CASE WHEN rk=1 THEN phy_state END) AS home_state, MAX(tot) AS tot
        FROM r GROUP BY ac
      ),
      -- The shut-down universe. Deliberately NOT sourced from
      -- carrier_aggregates: that parquet is built off the SMS census, which
      -- FMCSA prunes to (essentially) active carriers, so it retained only
      -- ~1.2k shut-down DOTs — 0.2% of the real universe, and shrinking every
      -- time FMCSA prunes (the Jul 2026 snapshot alone cut it 4,416 -> 1,187).
      -- Company Census keeps all ~1.94M inactive carriers AND carries the
      -- contact columns, so the graph is built straight from it.
      revoked AS (
        SELECT TRY_CAST(DOT_NUMBER AS BIGINT) AS dot,
               MAX(TRY_CAST(strptime(NULLIF(TRIM(order2_effective_Date),''),'%m/%d/%Y') AS DATE)) AS revoked_on
        FROM read_csv('${REVOCATION}', header=true, all_varchar=true, ignore_errors=true, sample_size=-1)
        WHERE upper(trim(ORDER2_TYPE_DESC)) = 'INVOLUNTARY REVOCATION'
          AND TRY_CAST(DOT_NUMBER AS BIGINT) > 0
        GROUP BY 1
      ),
      shutdowns AS (
        SELECT TRY_CAST(c.DOT_NUMBER AS BIGINT) AS dot,
               trim(coalesce(c.LEGAL_NAME,'')) AS name,
               lower(trim(coalesce(c.EMAIL_ADDRESS,''))) AS email,
               regexp_replace(coalesce(c.PHONE,''),'[^0-9]','','g') AS phone_norm,
               r.revoked_on
        FROM read_csv('${CENSUS}', header=true, all_varchar=true, ignore_errors=true, sample_size=-1) c
        JOIN revoked r ON r.dot = TRY_CAST(c.DOT_NUMBER AS BIGINT)
        -- 'I' only: ~267k carriers hold a revoked authority but are still
        -- registered and operating, which is not a shut-down.
        WHERE upper(trim(coalesce(c.STATUS_CODE,''))) = 'I'
      ),
      -- Cluster sizes across the COMBINED live + shut-down universe (see
      -- MAX_CONTACT_CLUSTER). Counting only the shut-down side would let a
      -- dispatcher phone shared with hundreds of live carriers slip through.
      email_clusters AS (
        SELECT v, COUNT(DISTINCT dot) AS nd FROM (
          SELECT email AS v, dot FROM shutdowns WHERE length(email) > 3
          UNION ALL SELECT email AS v, dot FROM idn WHERE length(email) > 3
        ) GROUP BY 1
      ),
      phone_clusters AS (
        SELECT v, COUNT(DISTINCT dot) AS nd FROM (
          SELECT phone_norm AS v, dot FROM shutdowns WHERE length(phone_norm) >= 10
          UNION ALL SELECT phone_norm AS v, dot FROM idn WHERE length(phone_norm) >= 10
        ) GROUP BY 1
      ),
      -- Officer-name links are deliberately NOT emitted. On the full universe
      -- they flag 224,286 carriers (10.7% of the base) at only 1.33x revoke
      -- lift — no cluster cap rescues them — and common-name collisions carry
      -- a disparate-impact problem. Email 1.87x / phone 2.46x do the work.
      raw_links AS (
        SELECT t.dot AS target, 'email' AS link_type, s.dot AS linked, s.name, s.revoked_on
        FROM idn t
        JOIN shutdowns s ON length(t.email) > 3 AND t.email = s.email AND s.dot <> t.dot
        JOIN email_clusters ec ON ec.v = t.email AND ec.nd <= ${MAX_CONTACT_CLUSTER}
        UNION ALL
        SELECT t.dot, 'phone', s.dot, s.name, s.revoked_on
        FROM idn t
        JOIN shutdowns s ON length(t.phone_norm) >= 10
          AND t.phone_norm NOT IN ('0000000000','9999999999','1111111111','1234567890')
          AND t.phone_norm = s.phone_norm AND s.dot <> t.dot
        JOIN phone_clusters pc ON pc.v = t.phone_norm AND pc.nd <= ${MAX_CONTACT_CLUSTER}
      ),
      links_ranked AS (
        SELECT target, link_type, linked, name,
          row_number() OVER (
            PARTITION BY target
            ORDER BY CASE link_type WHEN 'email' THEN 0 ELSE 1 END,
                     revoked_on DESC NULLS LAST, linked
          ) AS rk
        FROM (SELECT DISTINCT target, link_type, linked, name, revoked_on FROM raw_links)
      ),
      links_agg AS (
        SELECT target AS dot,
          string_agg(
            link_type || ' matches shut-down revoked DOT ' || CAST(linked AS VARCHAR)
              || CASE WHEN name IS NOT NULL AND name <> '' THEN ' (' || name || ')' ELSE '' END,
            ' | ' ORDER BY rk
          ) AS shutdown_links
        FROM links_ranked WHERE rk <= ${MAX_LINKS_PER_DOT} GROUP BY target
      ),
      -- Insurance POLICY NUMBER shared across DOTs (from the L&I insurance-history
      -- file). One policy can't legitimately cover two separate carriers, so a
      -- shared policy# with an involuntarily-revoked DOT is a strong same-operator
      -- chameleon edge (~6x revoke lift; lift test 2026-05). Exclude insurer-generic
      -- policy#s shared by >10 DOTs.
      ins AS (
        SELECT DISTINCT TRY_CAST(column01 AS BIGINT) AS dot, TRIM(column07) AS pol
        FROM read_csv('${INSHIST}',
                      header=false, all_varchar=true, ignore_errors=true, sample_size=-1)
        WHERE TRY_CAST(column01 AS BIGINT) > 0 AND length(TRIM(column07)) >= 4
      ),
      pol_clusters AS (SELECT pol, COUNT(DISTINCT dot) AS nd FROM ins GROUP BY 1),
      policy_links AS (
        SELECT t.dot AS dot,
          string_agg(DISTINCT
            'shares insurance policy with shut-down revoked DOT ' || CAST(s.dot AS VARCHAR)
              || CASE WHEN s.name IS NOT NULL AND s.name <> '' THEN ' (' || s.name || ')' ELSE '' END,
            ' | ') AS shared_policy_links
        FROM ins t
        JOIN ins o ON o.pol = t.pol AND o.dot <> t.dot
        JOIN pol_clusters pc ON pc.pol = t.pol AND pc.nd BETWEEN 2 AND 10
        JOIN shutdowns s ON s.dot = o.dot
        GROUP BY t.dot
      )
      SELECT
        i.dot AS DOT_NUMBER,
        CASE WHEN i.email_domain IN (${freeList}) THEN i.email_domain ELSE NULL END AS free_email_domain,
        NULLIF(regexp_extract(i.street_u, '${RES_RE}', 2), '') AS residential_marker,
        CASE WHEN coalesce(sz.corroborated_large, false) THEN NULL
             ELSE la.shutdown_links END AS shutdown_links,
        CASE WHEN coalesce(sz.corroborated_large, false) THEN NULL
             ELSE pl.shared_policy_links END AS shared_policy_links,
        -- Geo coherence, small carriers only (<=6 PU). Phone area code's home
        -- state differs from the carrier's domicile (~1.9x revoke lift).
        CASE WHEN sz.power_units <= 6
              AND am.home_state IS NOT NULL AND am.tot >= 50
              AND i.phy_state <> '' AND am.home_state <> i.phy_state
             THEN am.home_state ELSE NULL END AS phone_area_state,
        -- Inspected mostly away from home state (~1.4x for small fleets).
        CASE WHEN sz.power_units <= 6
              AND sz.home_state_insp_share IS NOT NULL
              AND sz.home_state_insp_share < 0.10
             THEN sz.home_state_insp_share ELSE NULL END AS home_insp_share
      FROM idn i
      LEFT JOIN links_agg la ON la.dot = i.dot
      LEFT JOIN policy_links pl ON pl.dot = i.dot
      LEFT JOIN sz ON sz.dot = i.dot
      LEFT JOIN ac_map am ON am.ac = i.area_code
      WHERE (i.email_domain IN (${freeList}))
         OR (regexp_extract(i.street_u, '${RES_RE}', 2) <> '')
         OR (la.shutdown_links IS NOT NULL AND NOT coalesce(sz.corroborated_large, false))
         OR (pl.shared_policy_links IS NOT NULL AND NOT coalesce(sz.corroborated_large, false))
         OR (sz.power_units <= 6 AND am.home_state IS NOT NULL AND am.tot >= 50
             AND i.phy_state <> '' AND am.home_state <> i.phy_state)
         OR (sz.power_units <= 6 AND sz.home_state_insp_share IS NOT NULL
             AND sz.home_state_insp_share < 0.10)
    ) TO 'data/carrier_risk_signals.parquet' (FORMAT PARQUET, COMPRESSION ZSTD)
  `);
  const stats = await run(`
    SELECT COUNT(*) n,
      COUNT(free_email_domain) n_free,
      COUNT(residential_marker) n_res,
      COUNT(shutdown_links) n_links,
      COUNT(shared_policy_links) n_policy,
      COUNT(phone_area_state) n_phone_geo,
      COUNT(home_insp_share) n_home_geo
    FROM read_parquet('data/carrier_risk_signals.parquet')`);
  const s = stats[0];
  console.log(`built data/carrier_risk_signals.parquet in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log(`rows=${s.n}  free_email=${s.n_free}  residential=${s.n_res}  shutdown_links=${s.n_links}  shared_policy_links=${s.n_policy}  phone_geo=${s.n_phone_geo}  home_geo=${s.n_home_geo}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
