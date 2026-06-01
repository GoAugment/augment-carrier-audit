/**
 * Does the PUBLIC FMCSA identity parquet reproduce the contact-reuse clusters
 * we saw in the (customer) brokerage directory? Uses ONLY data/carrier_identity.parquet
 * (census-derived: phone, email_address, company_officer_1, phy_street/zip). No customer data.
 *
 *   node scripts/contact_graph_public_test.cjs
 */
const duckdb = require("duckdb");
const db = new duckdb.Database(":memory:");
const q = (sql) => new Promise((res, rej) => db.all(sql, (e, r) => (e ? rej(e) : res(r))));

const COHORT = [1028671,1438983,1439740,1797621,2054876,2072533,2199392,2230916,2321331,2333023,2340662,2383311,2419025,2465329,2469728,2480363,2496627,2519910,2570846,2584454,2781252,2839595,2905560,2929291,2936394,2948736,2951404,2953170,2953461,2956341,2982259,2988367,3026711,3041442,3047924,3056794,3074995,3095937,3103017,3122262,3122689,3133710,3164126,3174359,3177538,3187994,3205537,3277236,3340888,3381341,3411427,3436775,3466263,3476855,3479486,3483627,3526943,3544421,3579740,3662463,3668636,3742489,3778058,3831108,3863628,3887332,3956083,4134798,4257410,4348979,24681012];
// named carriers whose directory clusters we want to compare against
const NAMED = {2054876:"Martin Soria (dir phone shared by 8)",3340888:"Istrati NC",3831108:"Best USA (shares Istrati phone)",2340662:"Chase Carrier",3041442:"Ert Logistics",1797621:"Dhindsa Group"};

async function main() {
  await q(`CREATE TABLE n AS
    SELECT DOT_NUMBER AS dot,
      NULLIF(RIGHT(REGEXP_REPLACE(COALESCE(phone,''),'[^0-9]','','g'),10),'') AS phone10,
      LOWER(NULLIF(TRIM(email_address),'')) AS email,
      UPPER(NULLIF(TRIM(company_officer_1),'')) AS officer,
      NULLIF(UPPER(TRIM(phy_street)),'')||'|'||NULLIF(TRIM(phy_zip),'') AS addr
    FROM read_parquet('data/carrier_identity.parquet')`);
  // scrub junk
  await q(`UPDATE n SET phone10=NULL WHERE phone10 IN ('0000000000','9999999999','1111111111') OR LENGTH(phone10)<10`);
  await q(`UPDATE n SET email=NULL WHERE email NOT LIKE '%@%'`);
  await q(`UPDATE n SET officer=NULL WHERE LENGTH(officer)<3`);
  await q(`CREATE TABLE cohort AS SELECT * FROM (VALUES ${COHORT.map(d=>`(${d})`).join(",")}) t(dot)`);

  const tot = (await q(`SELECT COUNT(*) c FROM read_parquet('data/carrier_identity.parquet')`))[0].c;

  // global coverage of contact fields in the public parquet
  const cov = (await q(`SELECT
      ROUND(100.0*COUNT(phone10)/COUNT(*),1) pct_phone,
      ROUND(100.0*COUNT(email)/COUNT(*),1)   pct_email,
      ROUND(100.0*COUNT(officer)/COUNT(*),1) pct_officer,
      ROUND(100.0*COUNT(addr)/COUNT(*),1)    pct_addr FROM n`))[0];

  // cohort presence + contact coverage
  const cc = (await q(`SELECT
      COUNT(*) cohort_total,
      COUNT(n.dot) in_parquet,
      COUNT(n.phone10) has_phone, COUNT(n.email) has_email, COUNT(n.officer) has_officer
    FROM cohort c LEFT JOIN n ON n.dot=c.dot`))[0];

  // global value->#distinct dots
  await q(`CREATE TABLE pc AS SELECT phone10 v, COUNT(DISTINCT dot) c FROM n WHERE phone10 IS NOT NULL GROUP BY 1`);
  await q(`CREATE TABLE ec AS SELECT email v,  COUNT(DISTINCT dot) c FROM n WHERE email  IS NOT NULL GROUP BY 1`);
  await q(`CREATE TABLE oc AS SELECT officer v,COUNT(DISTINCT dot) c FROM n WHERE officer IS NOT NULL GROUP BY 1`);
  await q(`CREATE TABLE ac AS SELECT addr v,   COUNT(DISTINCT dot) c FROM n WHERE addr   IS NOT NULL GROUP BY 1`);

  // per-cohort cluster sizes
  await q(`CREATE TABLE coh AS
    SELECT c.dot, pc.c AS phone_share, ec.c AS email_share, oc.c AS officer_share, ac.c AS addr_share
    FROM cohort c
    LEFT JOIN n   ON n.dot=c.dot
    LEFT JOIN pc  ON pc.v=n.phone10
    LEFT JOIN ec  ON ec.v=n.email
    LEFT JOIN oc  ON oc.v=n.officer
    LEFT JOIN ac  ON ac.v=n.addr`);

  const repro = (await q(`SELECT
      SUM((phone_share>=2)::int)   phone_linked,
      SUM((email_share>=2)::int)   email_linked,
      SUM((officer_share>=2)::int) officer_linked,
      SUM((addr_share>=2)::int)    addr_linked,
      SUM((COALESCE(phone_share,1)>=2 OR COALESCE(email_share,1)>=2 OR COALESCE(officer_share,1)>=2 OR COALESCE(addr_share,1)>=2)::int) any_linked
    FROM coh`))[0];

  console.log(`\nPublic identity parquet: ${Number(tot).toLocaleString()} carriers`);
  console.log(`Field coverage (whole parquet): phone ${cov.pct_phone}%  email ${cov.pct_email}%  officer ${cov.pct_officer}%  addr ${cov.pct_addr}%`);
  console.log(`\nCohort (confirmed fraud): ${cc.cohort_total} total | in parquet ${cc.in_parquet} | has phone ${cc.has_phone}, email ${cc.has_email}, officer ${cc.has_officer}`);
  console.log(`\nReproduced contact link (shared with >=1 other carrier) among the ${cc.cohort_total}:`);
  console.log(`  phone>=2:   ${repro.phone_linked||0}`);
  console.log(`  email>=2:   ${repro.email_linked||0}`);
  console.log(`  officer>=2: ${repro.officer_linked||0}`);
  console.log(`  addr>=2:    ${repro.addr_linked||0}`);
  console.log(`  ANY link:   ${repro.any_linked||0} / ${cc.cohort_total}`);

  console.log(`\nNamed carriers (public cluster sizes; compare to directory):`);
  const named = await q(`SELECT dot, phone_share, email_share, officer_share, addr_share FROM coh WHERE dot IN (${Object.keys(NAMED).join(",")})`);
  const byDot = new Map(named.map(r=>[Number(r.dot),r]));
  for (const [dot,label] of Object.entries(NAMED)) {
    const r = byDot.get(Number(dot));
    if (!r) { console.log(`  ${dot} ${label}: NOT in public parquet`); continue; }
    console.log(`  ${dot} ${label}: phone=${r.phone_share??'·'} email=${r.email_share??'·'} officer=${r.officer_share??'·'} addr=${r.addr_share??'·'}`);
  }
  process.exit(0);
}
main().catch(e=>{console.error(e);process.exit(1);});
