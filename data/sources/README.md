# FMCSA source data

Raw bulk files used to build `data/carrier_aggregates.parquet`. Not committed
to git — drop fresh files in this folder, then run the build script.

```bash
node scripts/build_parquet.mjs
```

## Files we use

All ten files below are required for a full rebuild. Filenames may include a
month-stamp suffix (e.g. `_20260518`); the build script picks the
most-recent file matching each glob.

| File (glob) | Size | Source | Used for |
|---|---|---|---|
| `Company_Census_File.csv` | ~1.7 GB | [data.transportation.gov — Company Census File](https://data.transportation.gov/Trucking-and-Motorcoaches/Company-Census-File/az4n-8mr2) | Identity, MCS-150 date, review date/type, safety rating + date, chameleon flag (`PRIOR_REVOKE_FLAG`), cargo flags, fleet composition |
| `Carrier_All_With_History.csv` | ~335 MB | **Auto-downloaded** by `refresh_sms_data.py` (Socrata `6eyk-hxee`) | Operating authority, BIPD / cargo / bond insurance, business + mailing address |
| `ActPendInsur_All_With_History.csv` | ~50 MB | [data.transportation.gov — ActPendInsur](https://data.transportation.gov/Trucking-and-Motorcoaches/ActPendInsur-All-With-History/ypue-kdue) | Current/pending insurance policies (insurer name, policy number, effective/cancel dates, amounts) |
| `Revocation_-_All_With_History*.csv` | ~120 MB | **Auto-downloaded** by `refresh_sms_data.py` (Socrata `sa6p-acbp`) | Authority revocations (voluntary + involuntary) |
| `inshist_allwithhistory.csv` | ~1.3 GB | **Auto-downloaded** by `refresh_sms_data.py` (Socrata `6sqe-dvqs`) | Historical insurance policy lifecycle (cancellation reasons: Cancelled / Replaced / Name Change / Transferred — chameleon detection) |
| `closed_enforcement_cases_*.xlsx` | ~25 KB | [data.transportation.gov — Closed Enforcement Cases](https://data.transportation.gov/Trucking-and-Motorcoaches/Closed-Enforcement-Cases/cur9-tfg7) | FMCSA civil-penalty cases against carriers/brokers |
| `SMS_AB_PassProperty*.csv` | ~65 MB | **Auto-downloaded** by `refresh_sms_data.py` (Socrata `4y6x-dmck`) | FMCSA's pre-computed BASIC measures + alert flags (Unsafe Driving, HOS, Driver Fitness, Controlled Substances, Vehicle Maintenance) |
| `SMS_Input_-_Inspection_*.csv` | ~1.45 GB | [data.transportation.gov — SMS Input: Inspection](https://data.transportation.gov/Trucking-and-Motorcoaches/SMS-Input-Inspection/v7sb-zsx5) | Per-inspection record with hazmat-placardable flag, BASIC inspection counts, VIN. **Fixes the hazmat undercount bug.** |
| `SMS_Input_-_Violation_*.csv` | ~1.25 GB | [data.transportation.gov — SMS Input: Violation](https://data.transportation.gov/Trucking-and-Motorcoaches/SMS-Input-Violation/eaqq-trat) | Per-violation detail: violation code, BASIC mapping, OOS flag, FMCSA severity/time weights, section/group description |
| `SMS_Input_-_Crash_*.csv` | ~55 MB | [data.transportation.gov — SMS Input: Crash](https://data.transportation.gov/Trucking-and-Motorcoaches/SMS-Input-Crash/eskx-7szm) | Per-crash-vehicle with FMCSA severity/time weights, preventability flag, hazmat-released flag |

## Files we explicitly do NOT use

| Skip | Why |
|---|---|
| `Vehicle_Inspection_File.csv` (2.87 GB) | Superseded by `SMS_Input_-_Inspection`, which already has FMCSA's BASIC + hazmat classifications applied |
| `Crash_File.csv` (1.85 GB) | Superseded by `SMS_Input_-_Crash`, which adds FMCSA's official severity/time weights |
| `SMS_Input_-_Motor_Carrier_Census_Information_*.csv` (752 MB) | Subset of `Company_Census_File` — Census file is fresher and has more columns |
| `OOS_Orders.csv` | Currently empty (FMCSA ships a header-only file when no active OOS orders) |
| `SMS_C_PassProperty_*.csv` | Intrastate non-hazmat carriers — out of scope for interstate freight brokerage |
| `SMS_AB_Pass_*.csv` / `SMS_C_Pass_*.csv` | Passenger carriers (buses) — out of scope |
| `BOC3 / Special_Studies / Rejected / Inspections_Per_Unit` | Niche or future-feature — see the README's "future" section below |

## Refresh runbook (monthly + daily insurance)

FMCSA publishes new SMS snapshots around the 13th–18th of each month; the L&I
insurance feeds are *supposed* to update **daily** (but see the ActPendInsur
warning below). The canonical builder is the Polars pipeline
in `pipeline/fmcsa-aggregate/` (orchestrated by `build_all.py`). Everything
below runs in THIS repo — there is no longer a sibling-workspace dependency.

> 🚨 **FMCSA retired the L&I feeds on 2026-05-14 — see `merge_motus.py`.**
> FMCSA replaced Licensing & Insurance with a new system ("Motus") that day and
> stopped updating the four L&I bulk datasets. Their Socrata descriptions say it
> outright: *"This dataset was last refreshed on 05/14/2026 and will no longer
> be updated."* Affected: `ActPendInsur` (`qh9u-swkp`), `Carrier - All With
> History` (`6eyk-hxee`), `Revocation` (`sa6p-acbp`), `InsHist` (`6sqe-dvqs`).
> Company Census and every SMS dataset are unaffected.
>
> The live replacements are small (~100k rows, a few MB — so they're in the
> `--daily` set) and only accumulate from the cutover, so every signal must
> UNION old (≤2026-05-14) + Motus (>2026-05-14):
>
> | Retired | Motus replacement |
> |---|---|
> | Revocation `sa6p-acbp` | RevokeSuspend AWH `wb4f-neki` |
> | ActPendInsur `qh9u-swkp` | Insur AWH `c5y8-a4uz` |
> | Carrier AWH `6eyk-hxee` | Carrier AWH `inys-ebih` |
> | — | AuthHist AWH `yu5v-wbh6` |
>
> `merge_motus.py` (pipeline step 1) does the splice and re-emits the OLD schema
> into `data/sources/merged/`, so no downstream step knows any of this happened —
> `build_all.py` just points `FMCSA_REVOCATION` and `FMCSA_CARRIER_AUTH` at the
> merged files (the raw feeds stay available as `*_RAW`).
>
> **Revocations are migrated** (UNION: old events + Motus events).
> **Insurance is migrated** (`merge_insurance`): BIPD-on-file is rebuilt from
> **Motus_Insur** (`c5y8-a4uz`) — the BMC-91/91X filings, summed primary +
> excess, de-duped on (policy_no, insurer, amount).
>
> Validated against the frozen L&I file as ground truth, split on whether the
> carrier had any post-cutover insurance transaction:
>
> | cohort | agreement with L&I |
> |---|---|
> | no post-cutover activity (n=51,738) | **99.3%** — the correctness check |
> | post-cutover activity (n=17,780) | 54.4% — i.e. the new information |
>
> Reference points: Werner 4M + 1M self-insured = $5M; JB Hunt 2.5M + 1M = $3.5M.
>
> ⚠️ **Do NOT use Motus Carrier's `BIPD_FILE` — it is a different field.**
> Schneider National has one L&I docket row with BIPD_FILE `"01000"` ($1M), but
> FOUR Motus_Carrier rows for the same docket (one per authority type) with
> BIPD_FILE `"0"` on every one. Upserting that flips Schneider to "Insurance
> lapsed" and would do the same to ~1,399 carriers. The failed attempt is kept,
> disabled, in `merge_motus.merge_carrier_auth` as a warning.
>
> Cargo is BMC-34, broker surety BMC-84/85, bond BMC-82 — those are NOT BIPD and
> are excluded from the sum. Carriers are only zeroed when they have
> post-cutover activity AND no remaining BMC-91 filing, so an unchanged old
> policy that Motus simply doesn't relist can never zero a carrier.
>
> ⚠️ **The two files use different UNITS and nothing warns you.** L&I stores
> BIPD/min-coverage as zero-padded $-**thousands** (`"00750"` = $750k); Motus
> stores whole **dollars** (`"750000"`). Copying Motus across verbatim inflates
> every carrier's coverage 1000× and makes the `$0 BIPD` Critical gate
> meaningless. `merge_motus` divides by 1,000 back into the old convention —
> `build_aggregates` parses these as $-thousands (Werner = 5000.0 = $5M).
>
> **The vocabulary changed, not just the ids.** Motus issues a *suspension
> notice* with a future effective date instead of revoking outright, and the
> resulting status change lands in AuthHist — so one old `INVOLUNTARY
> REVOCATION` can appear as two rows across two datasets. merge_motus unions
> both and de-dups within ±45 days. Future-dated notices are NOT counted as
> revocations; they go to `merged/motus_pending_suspension.csv`, which is the
> replacement for the dead imminent-lapse signal (and a better one — it's
> FMCSA's own enforcement action, not our inference from a cancel date).

> ⚠️ **`rowsUpdatedAt` lies — verify vintage from file content, not metadata.**
> Every Socrata mirror we pull reported `rowsUpdatedAt` = the current day on
> 2026-08-12, but `ActPendInsur` (`qh9u-swkp`) came back **byte-identical to the
> Jun 26 pull once sorted** (same 467,983 rows, max `trans_date` = 2026-05-14 in
> both). FMCSA re-uploads the same snapshot daily, which advances the metadata
> timestamp without changing the data. Carrier auth, Revocation and InsHist *did*
> genuinely change. The duplicate catalog entry `y77m-3nfx` is not an alternative
> — it's an `assetType: file` attachment with 0 columns.
>
> Practical consequence: the imminent-BIPD-lapse signal is pinned to the FMCSA
> **2026-05-14** pending-cancellation vintage and does not improve with a refresh
> until FMCSA unfreezes the feed. To re-check after a pull:
> `sort <new>.csv | md5` vs the previous vintage, or histogram `trans_date`.

> ⚠️ Insurance is NOT a standalone refresh. BIPD-on-file comes from
> `build_aggregates` (reads `Carrier_All_With_History`); lapse/cancellation/
> chameleon signals come from `add_inshist` + `add_pending_lapse` +
> `add_revocations`. So "refresh insurance" = re-run the core build with fresh
> `Company_Census` + `Carrier_All_With_History` + `ActPendInsur` + `inshist` +
> `Revocation`.

### 1. Download fresh sources → `data/sources/`

**Automated (Socrata, resumable, uses `SOCRATA_API_KEY`/`SECRET` from `.env.local`):**
```bash
uv run pipeline/fmcsa-aggregate/refresh_sms_data.py --monthly   # SMS Inspection/Violation/Crash + Census + InsHist + Carrier auth + Revocation + SMS_AB PassProperty
uv run pipeline/fmcsa-aggregate/refresh_sms_data.py --daily     # ActPendInsur (insurance pending-cancel dates)
```
Paths are resolved from the repo root (`Path(__file__).parents[2]`), so this runs
in any workspace/checkout; override with `FMCSA_ENV_FILE` / `FMCSA_SOURCES_DIR`.

**The download is the expensive part of a refresh — not the build.** Socrata
throttles each connection to ~1.5 MB/s no matter the file, so the 10 monthly
datasets take ~81 min of pure streaming if fetched one at a time. They now run
**4 at a time** (`--jobs=N` to change), dispatched biggest-first, which puts the
floor at the single slowest file — Company Census, ~20 min. Per-file progress
lines are prefixed with the filename since they interleave.

Both stream to `data/sources/refresh_<YYYYMMDD>/` as `.part` → atomic rename;
re-runs skip files whose row count already matches Socrata (large files like
Census + InsHist page via SODA chunks — see `PAGINATED`). The working Socrata
dataset IDs live in `refresh_sms_data.py` (`MONTHLY`/`DAILY` dicts) — **dataset
IDs drift / get duplicated, so if a download 404s, re-confirm the live id via the
catalog API** (`https://api.us.socrata.com/api/catalog/v1?domains=data.transportation.gov&q=<name>`),
picking the entry with a recent `rowsUpdatedAt` and non-zero column count.

`--monthly` now auto-pulls **9** datasets, including the four that used to be
manual: InsHist (`6sqe-dvqs`), Carrier - All With History (`6eyk-hxee`),
Revocation - All With History (`sa6p-acbp`), and SMS AB PassProperty
(`4y6x-dmck`). Several old README ids are dead (`n76j-r3iz`, `2eyu-5pc4`,
InsHist `szfe-tikd`) — the live ids are in the script.

**Still manual — exactly one file:**
- `closed_enforcement_cases_*.xlsx` — see "Closed enforcement cases" below. It's an **A&I-portal Excel export** (not a usable Socrata dataset) with a two-row header, so it can't go through the downloader.

After downloading, move/symlink everything into `data/sources/` with the names
`build_all.py` expects (see step 2's gotcha). The auto-downloaded files use
undated names; `build_all.py` resolves InsHist (`.csv`/`.txt`), Revocation, and
SMS_AB PassProperty (newest matching glob) automatically.

### 2. Bump the date pins, then build

`build_all.py`'s `DEFAULT_ENV` pins **hard-coded dated filenames**
(`..._20260514.csv`, `..._20260518.csv`) and `add_inshist.py` has a
`SNAPSHOT_DATE = "2026-05-14"` constant. Before building:
```bash
grep -rn "20260514\|20260518\|2026-05-14\|SNAPSHOT_DATE" pipeline/fmcsa-aggregate/
```
Update those to the new snapshot date (or rename the downloaded files to match
the existing pins). Then:
```bash
# ~4 min: reuses the existing PU-history + serious-violation scrape parquets.
# Insurance/authority/BIPD/BASIC do NOT need fresh scrapes.
uv run pipeline/fmcsa-aggregate/build_all.py --no-scrape

# ~2.4 h: full rebuild INCLUDING the two ZenRows scrapes (needs SCRAPE_PROXY_URL).
# Essentially all of that is the two scrapes; the 19 data steps are ~4 min total.
# Only when you want fresh Crash-Indicator + PU-history + serious-violations.
uv run pipeline/fmcsa-aggregate/build_all.py
```
`build_all.py --list` shows all steps + runtimes; `--from <step>` resumes.
Outputs land directly in `data/`: `carrier_aggregates.parquet`,
`carrier_identity.parquet`, `national_thresholds.json`, and the
`lib/data/*-risk.json` lookup tables.

### 3. Rebuild the single-carrier artifacts (low-latency `/check` path)
```bash
pnpm build:single-check-buckets    # data/single-check-buckets/{carriers,identities}/bucket=*, mc_index, phone_index
pnpm build:single-check-compact    # data/single-check-compact/{mc,phone}/prefix=*.json.gz
```

### 4. Upload to Vercel Blob (parquets are too big to bundle)
```bash
export BLOB_READ_WRITE_TOKEN=vercel_blob_rw_...   # from Vercel → Storage → Blob
node scripts/upload-identity-blob.mjs             # carrier_identity.parquet → Blob (same pathname/URL)
pnpm upload:single-check-buckets                  # bucket parquets → Blob
pnpm upload:single-check-compact                  # compact json.gz → Blob
```
`upload-identity-blob.mjs` overwrites the same pathname, so `BLOB_IDENTITY_URL`
doesn't change. `carrier_aggregates.parquet` (~95 MB) stays bundled in the
function; `carrier_identity.parquet` (~96 MB) is Blob-only (250 MB limit).

### 5. Validate, then deploy
```bash
pnpm test:rules        # 55 rule fixtures
pnpm test:snapshots    # ~27 real-DOT audit snapshots — UPDATE with --update if tier drift is expected from fresh data
```
Spot-check a handful of known DOTs (`/check/<dot>`) against live SAFER. Then
commit the refreshed `data/*` + bumped date pins and push to `main` (the deploy
swaps the data globally for every user — that's the irreversible step).

> A second DuckDB-based builder (`scripts/build_parquet.mjs`) was prototyped
> early on but is no longer maintained — the Polars pipeline is the source of
> truth for column schema and chameleon-cluster derivations.

## `inshist` — now automated (was the manual gotcha)

`inshist` used to require a manual browser download of FMCSA's native
header-less positional `inshist_allwithhistory.txt`. It's now auto-downloaded
from the **Socrata mirror** `InsHist - All With History` (dataset **`6sqe-dvqs`**;
the old README id `szfe-tikd` was stale) by `refresh_sms_data.py --monthly`.

Why this works without a parser rewrite: the Socrata bulk export
(`/api/views/6sqe-dvqs/rows.csv?accessType=DOWNLOAD`) has the **same 17 columns
in the same order** as the native dump, with `MM/DD/YYYY` dates — the only
differences are a header row and a zero-padded `dot_number`. `add_inshist.py`
sniffs the first line and skips the header when present (so it still reads the
native `.txt` too), and the `Int64` cast absorbs the DOT padding. Verified
against a 5k-row sample: cancel types (`Cancelled`/`Replaced`/`Name Changed`/
`Transferred`), policy numbers, insurers, and parsed dates all land correctly.

If you ever need the native file instead (e.g. Socrata outage), it's in FMCSA's
**Data Dissemination Program** "Entities with Operating Authority" bulk set —
<https://www.fmcsa.dot.gov/registration/fmcsa-data-dissemination-program> /
<https://li-public.fmcsa.dot.gov/> (browser only; these 403 to scripts). Drop it
in as `inshist_allwithhistory.txt` and the build picks it up (`build_all.py`
prefers the `.csv`, falls back to the `.txt`).

Note: `inshist` only feeds the chameleon insurance-*history* signals
(cancel/replace-within-30-days, distinct-policy churn). Daily lapse detection
keys off `ActPendInsur` (DAILY) instead, so `inshist` tolerates a monthly vintage.

## Closed enforcement cases (the one remaining manual file)

`closed_enforcement_cases_*.xlsx` comes from FMCSA's **A&I (Analysis &
Information) Online** "Closed Enforcement Cases" report —
<https://ai.fmcsa.dot.gov/EnforcementPrograms/EnforcementCases/Index?type=ClosedCases>
— which is backed by FMCSA's **EMIS** (Enforcement Management Information System)
and covers settled civil-penalty cases for the last 7 years (~200 rows). Export
it to Excel from that page; the filename's long numeric suffix
(`…_20260515005306`) is the A&I export timestamp.

Why it stays manual: the data.transportation.gov mirror (`dxqq-yjrs`) is **dead**
(stale 2018 snapshot, 0 columns, export errors), and `add_enforcement.py` reads
the A&I **Excel layout** directly — `pl.read_excel(..., header_row=1)`, since the
real header is on **row 2** (row 1 holds descriptive labels). So it's an A&I
browser export, not a Socrata pull.

`add_enforcement.py` aggregates per DOT into `enforcement_cases_count`,
`enforcement_total_settled` ($), `enforcement_recent_date`, and
`enforcement_violations` (semicolon-joined codes).

**Is it used?** Yes — `classifyEnforcement` in `lib/analyzer.ts` makes it a
verdict driver: a closed case within the last **24 months** (`recent`) **bumps
the tier up one level**, and a "large" settlement (≥ `ENFORCEMENT_LARGE_SETTLEMENT`,
currently **$25k** in code — note the `recent-enforcement` rule copy still says
$75k) **floors the verdict at High**. It's also a CSV column + a reply pill. But
coverage is tiny: only **~195 carriers** in the whole 2.08M-row parquet have any
enforcement case, so for everyone else it's a clean no-op. Low-churn (a few new
cases/month), so a slightly stale copy is low-risk — and it's worth keeping
because when it *does* fire it's a strong signal (FMCSA found violations serious
enough to fine).

## `SMS_AB_PassProperty` (now automated)

"AB Pass Property" = the A/B-eligible (interstate + intrastate-hazmat)
**Property** carrier file. It's FMCSA's own **pre-computed BASIC output**: the
five published BASIC measures (`UNSAFE_DRIV_MEASURE`, `HOS_DRIV_MEASURE`,
`DRIV_FIT_MEASURE`, `CONTR_SUBST_MEASURE`, `VEH_MAINT_MEASURE`), their roadside
inspection counts, and FMCSA's alert flags.

It used to be a manual download from FMCSA's SMS Tools page
(<https://ai.fmcsa.dot.gov/SMS/Tools/Downloads.aspx>), but data.transportation.gov
carries a **Socrata mirror** — "SMS AB PassProperty", dataset **`4y6x-dmck`** —
with the **identical 21-column schema**, so `refresh_sms_data.py --monthly` now
auto-pulls it.

`build_aggregates.py` (step 2) reads it for those five measures + alert flags;
`compute_basics.py` then ranks them into the peer-group percentiles the analyzer
shows. It's the FMCSA-authoritative source for the 5 public BASICs — we only
*reconstruct* the two FMCSA doesn't publish (Crash Indicator, Hazmat Compliance)
from the raw SMS Crash/Inspection files.

## Derived columns worth knowing about

Beyond the raw FMCSA fields, the aggregate parquet emits a few computed columns
the analyzer + email-check depend on:

| Column | Source | Meaning |
|---|---|---|
| `prior_revoke_flag` + `prior_revoke_dot_number` | Company Census | FMCSA's own flag identifying a re-incarnation of a revoked predecessor DOT. Strongest single chameleon signal — no inference. |
| `address_dupe_active_count` | derived (Company Census self-join) | # of OTHER currently-active DOTs registered at this carrier's normalized physical address. Excludes PO boxes and addresses with ≥50 carriers (registered agents / virtual offices). |
| `address_dupe_oos_count` | derived (Company Census self-join) | # of OTHER out-of-service DOTs at the same address. High count + recent ADD_DATE = classic chameleon pattern. |
| `name_reused_from_oos_dot` | derived (Company Census self-join) | DOT_NUMBER of the OLDEST out-of-service DOT sharing this active carrier's normalized legal name. Catches the GenLogs-style "Logistics LLC was previously USDOT 3702012 (OOS)" pattern that `prior_revoke_flag` misses (it only fires for formal revocations). |
| `crashes_per_million_miles` | derived (crashes ÷ MCS-150 mileage) | Industry-standard fleet metric. Werner ≈ 0.42, JB Hunt ≈ 0.50, fleet avg ≈ 1.0, problem carrier ≥ 2.0. |
| `peer_group` | derived (power_units bucketing) | `owner_op` / `small` / `mid` / `large` / `mega` — anchors P95 cutoffs to comparable fleets. |

## Future / not yet pulled

- `SMS_Input_-_Violation_Codes` (reference table of every violation code) — would let us pretty-print `§393.47A1` → "Brake — out of adjustment". Small file, easy add.
- `Inspections_Per_Unit` — per-VIN detail for concentration analysis ("3 of 60 trucks generate 80% of OOS"). Multi-GB, defer until UI supports it.
- `AuthHist` — full grant/termination history per authority. Useful complement to revocations.
- `NCCDB` (consumer complaints) — web-only, no bulk download.
