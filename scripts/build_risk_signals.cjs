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
 *   data/carrier_aggregates.parquet (status_code, involuntary_revocations,
 *                                     LEGAL_NAME — to identify shut-down DOTs)
 * Output:
 *   data/carrier_risk_signals.parquet  — one row per DOT that has >=1 signal:
 *     DOT_NUMBER, free_email_domain, residential_marker, shutdown_links
 *
 *   node scripts/build_risk_signals.cjs
 * Re-run after each monthly parquet refresh. Bundled into the functions
 * (small), so /api/analyze needs neither the identity Blob nor the self-join.
 */
const duckdb = require("duckdb");
const db = new duckdb.Database(":memory:");
const run = (sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));

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
        SELECT DOT_NUMBER AS dot, power_units, home_state_insp_share
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
      shutdowns AS (
        SELECT DOT_NUMBER AS dot, LEGAL_NAME AS name
        FROM read_parquet('data/carrier_aggregates.parquet')
        WHERE (status_code <> 'A' OR status_code IS NULL)
          AND coalesce(involuntary_revocations,0) > 0
      ),
      raw_links AS (
        SELECT t.dot AS target, 'email' AS link_type, s.dot AS linked, s.name
        FROM idn t JOIN idn i ON t.email <> '' AND t.email = i.email AND i.dot <> t.dot
        JOIN shutdowns s ON s.dot = i.dot
        UNION ALL
        SELECT t.dot, 'phone', s.dot, s.name
        FROM idn t JOIN idn i ON length(t.phone_norm) >= 10
          AND t.phone_norm NOT IN ('0000000000','9999999999','1111111111','1234567890')
          AND t.phone_norm = i.phone_norm AND i.dot <> t.dot
        JOIN shutdowns s ON s.dot = i.dot
        UNION ALL
        SELECT t.dot, 'officer', s.dot, s.name
        FROM idn t JOIN idn i ON length(t.officer) >= 5
          AND t.officer NOT IN ('OWNER','UNKNOWN','NONE','N/A','NA')
          AND t.officer = i.officer AND i.dot <> t.dot
        JOIN shutdowns s ON s.dot = i.dot
      ),
      links_ranked AS (
        SELECT DISTINCT target, link_type, linked, name FROM raw_links
      ),
      links_agg AS (
        SELECT target AS dot,
          string_agg(
            link_type || ' matches shut-down revoked DOT ' || CAST(linked AS VARCHAR)
              || CASE WHEN name IS NOT NULL AND name <> '' THEN ' (' || name || ')' ELSE '' END,
            ' | '
          ) AS shutdown_links
        FROM links_ranked GROUP BY target
      ),
      -- Insurance POLICY NUMBER shared across DOTs (from the L&I insurance-history
      -- file). One policy can't legitimately cover two separate carriers, so a
      -- shared policy# with an involuntarily-revoked DOT is a strong same-operator
      -- chameleon edge (~6x revoke lift; lift test 2026-05). Exclude insurer-generic
      -- policy#s shared by >10 DOTs.
      ins AS (
        SELECT DISTINCT TRY_CAST(column01 AS BIGINT) AS dot, TRIM(column07) AS pol
        FROM read_csv('data/sources/inshist_allwithhistory.txt',
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
        la.shutdown_links AS shutdown_links,
        pl.shared_policy_links AS shared_policy_links,
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
         OR (la.shutdown_links IS NOT NULL)
         OR (pl.shared_policy_links IS NOT NULL)
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
