# FMCSA Aggregation Pipeline

Monthly batch pipeline that turns FMCSA bulk data files into the canonical
`data/carrier_aggregates.parquet` — the single carrier-row dataset consumed by
the Next.js audit application at request time.

The web app reads this parquet via DuckDB; nothing in this directory runs
inside the API request path. All scripts here are Python (Polars), invoked
manually or via cron when FMCSA publishes a new monthly SMS snapshot.

## Pipeline overview

```
                FMCSA bulk CSVs                            Output
                ───────────────                            ──────
SMS_AB_PassProperty            ─┐
SMS_Input_-_Crash              ─┤
SMS_Input_-_Inspection         ─┤      [build_aggregates.py]
SMS_Input_-_Violation          ─┼──►   [add_*.py]            ──►  carrier_
SMS_Input_-_Motor_Carrier_      │       [compute_*.py]            aggregates
   Census_Information          ─┤      [scrape_pu_history.py]     .parquet
Carrier_All_With_History       ─┤
ActPendInsur                   ─┤
inshist_allwithhistory         ─┘

FMCSA SMS website (per-DOT)    ─────► [scrape_pu_history.py] ───►  crash_
                                                                   indicator
                                                                   _<vintage>
                                                                   .parquet
```

## Output schema

`data/carrier_aggregates.parquet` — one row per DOT. ~2M rows, pruned to the
app-facing column contract from `lib/fmcsa-parquet.ts`.

Read by `lib/fmcsa-parquet.ts` at audit time. New columns added here must be
projected through `FmcsaCarrier` type + the SQL SELECT in that file before
they're usable by the analyzer.

`build_all.py` sets `FMCSA_PARQUET`, `FMCSA_OUTPUT_DIR`, and related source /
sidecar paths so every refresh step mutates the same canonical `data/` parquet.
The ignored `pipeline/fmcsa-aggregate/*.parquet` files are local scratch outputs
only and should not be treated as publishable artifacts.
The final `prune_app_parquet.py` step drops build-only/intermediate columns after
thresholds and sidecar risk tables have been generated.

## Run order

**One-command rebuild:**
```
uv run build_all.py                # full pipeline including scrape (~2.4h)
uv run build_all.py --no-scrape    # skip scrape, use existing PU history (~4m)
uv run build_all.py --list         # show all steps + runtime estimates
uv run build_all.py --from compute_basics   # resume from a specific step
uv run build_all.py --only add_inshist      # run a single step
```

**The orchestrator runs these in order:**

```
 1.  build_aggregates.py        # core schema + 5 public BASIC measures
 2.  add_revocations.py         # revocation history + flags
 3.  add_inshist.py             # insurance cancellation history
                                #   (distinct policies, rapid-replace)
 4.  add_enforcement.py         # enforcement case counts
 5.  add_pending_lapse.py       # imminent BIPD lapse
 6.  add_fleet_sharing.py       # VIN cross-DOT (concentrated overlap)
 7.  add_plausibility.py        # inflated-PU detection / fleet sanity
 8.  add_chameleon_signals.py   # diffuse VIN sharing + insurance
                                #   replaces/distinct policies
 9.  scrape_pu_history.py       # per-DOT historical PU snapshots
                                #   (~25k crash-sufficiency carriers)
 10. compute_basics.py          # measure + percentile + alert for all 7
                                #   BASICs (UD/HOS/VM/DF/CS from bulk;
                                #   HM from violation file; Crash from
                                #   crash file + scraped Avg PU)
 11. add_high_risk.py           # FAST Act high-risk flag
 12. fetch_serious_violations.py # scrape serious violation sidecar
 13. add_serious_violations.py  # apply serious violations to BASICs
 14. compute_iss.py             # ISS-CSA score (1-100, three tiers)
 15. recompute_thresholds.py    # peer-group P85/P95/P99 cutoffs
 16. add_phantom_fleet.py       # inspected VINs vs reported PU
 17. add_phy_zip.py             # physical ZIP for ZIP-risk lookup
 18. add_geo_mismatch.py        # home-state inspection share
 19. build_insurer_risk.py      # insurer shutdown-lift sidecar
 20. build_zip_risk.py          # ZIP shutdown-lift sidecar
 21. prune_app_parquet.py       # drop build-only columns from checked-in aggregate
```

Each script reads the canonical parquet, mutates a subset of columns, writes
back. The scripts are idempotent — re-running produces identical results.

Typical full-refresh runtime: ~2.4 hours, almost entirely the two ZenRows
scrapes. With `--no-scrape`: **~4 minutes** for all 19 data steps (measured
2026-08-12; the old "~15 minutes" estimate was off by ~4x). The slowest single
step is now `build_risk_signals` at ~1.6m, which parses the 2 GB Company Census.

The expensive part of a refresh is the DOWNLOAD, not the build — see
`refresh_sms_data.py` (~20 min with the default 4 concurrent jobs).

## Scripts (alphabetical)

### `build_all.py`
**Orchestrator.** Single entry point that runs every other script in order.
Stops on first failure. Each step's stdout streams through. Designed to be
the only command needed for a monthly refresh.

- **Usage:**
  - `uv run build_all.py` — full pipeline including scrape
  - `uv run build_all.py --no-scrape` — skip the scrape step
  - `uv run build_all.py --from <step>` — resume after a failure
  - `uv run build_all.py --only <step>` — run a single step
  - `uv run build_all.py --list` — show step list + runtime estimates

### `build_aggregates.py`
**The root script.** Builds `carrier_aggregates.parquet` from scratch by
joining the FMCSA bulk files. Pulls 5 publicly-available BASIC measures + alert
codes, MCS-150 census fields (PU, drivers, mileage, address), SMS inspection /
violation aggregates, crash totals, peer-group classification.

- **Inputs:** all FMCSA bulk CSVs in `/Users/art/Downloads/`
- **Output:** `carrier_aggregates.parquet` (overwrites)
- **Frequency:** every monthly SMS refresh
- **Runtime:** ~3 min

### `add_revocations.py`
Adds revocation-history columns:
- `involuntary_revocations`, `revocations_total`, `most_recent_involuntary_date`
- `prior_revoke_flag` (FMCSA's own chameleon flag), `prior_revoke_dot_number`

- **Input:** `carrier_aggregates.parquet` + `Revocation_All_With_History.csv`
- **Output:** updates parquet in place
- **Runtime:** ~30 sec

### `add_inshist.py`
Adds insurance-cancellation-history columns from the InsHist bulk file.
Counts **distinct policies cancelled** in 24 months (not raw cancellation
events — see `/tmp/fix_insurance_cancellations.py` for the bug we fixed).

- `insurance_cancellations_24mo` (now: distinct cancelled policy_nos)
- `most_recent_cancel_date`, `most_recent_cancel_reason`
- `rapid_replace_flag` (cancel + replace within 30 days, ever)

- **Input:** `inshist_allwithhistory.txt`
- **Output:** updates parquet
- **Runtime:** ~1 min

### `add_enforcement.py`
Adds enforcement-case counts and settlement totals.
- `enforcement_cases_count`, `enforcement_total_settled`, `enforcement_recent_date`

- **Runtime:** ~20 sec

### `add_fleet_sharing.py`
Computes per-DOT largest fleet-sharing sibling — the other active DOT that
shares the most inspected VINs. Powers `chameleon-shared-fleet` rule.

- `largest_sibling_dot`, `largest_sibling_legal_name`,
  `largest_sibling_shared_vins`, `largest_sibling_total_vins`,
  `largest_sibling_overlap_pct`

- **Input:** parquet + `SMS_Input_-_Inspection.csv`
- **Output:** updates parquet
- **Runtime:** ~3 min (VIN cross-join is expensive)

### `add_plausibility.py`
Computes `fleet_size_flag` ("plausible" / "low-activity" / "tiny" / "unknown")
based on PU vs inspection count consistency. Catches Brawley-style inflated
PU patterns.

- **Runtime:** ~30 sec

### `add_chameleon_signals.py`
**NEW (May 2026).** Adds 4 columns that feed chameleon-cluster:
- `diffuse_vin_share_pct` / `diffuse_vin_share_n_siblings` — % of own VINs
  inspected under OTHER active DOTs, spread across how many distinct siblings
- `insurance_replaces_24mo` — count of 'Replaced' policy events
- `insurance_distinct_policies_24mo` — distinct policy numbers touched in 24mo

Inputs: parquet + inspection CSV + InsHist text. Touches two sources but
the columns share the chameleon-detection purpose.

- **Runtime:** ~2 min

### `compute_basics.py`
**NEW (May 2026).** Single pass that computes measure + Safety Event Group +
percentile + alert for **all 7 FMCSA BASICs**:

| BASIC | Measure source | Percentile we compute? |
|---|---|---|
| Unsafe Driving | bulk SMS file (`UNSAFE_DRIV_MEASURE`) | ✓ |
| HOS Compliance | bulk SMS file | ✓ |
| Vehicle Maintenance | bulk SMS file | ✓ |
| Driver Fitness | bulk SMS file | ✓ |
| Controlled Substances | bulk SMS file | ✓ |
| **HM Compliance** | **we compute** (from violation file) | ✓ |
| **Crash Indicator** | **we compute** (from crash file + scraped Avg PU) | ✓ |

For 1-5, FMCSA's bulk gives us the measure but hides the numeric percentile —
we compute the percentile ourselves using FMCSA's own methodology
(Safety Event Group bucketing → within-group ascending rank).

For HM Compliance and Crash Indicator, FMCSA hides both measure and
percentile (`Not Public` on per-DOT pages); we compute both from inputs in
the bulk feeds. FMCSA pre-classifies each violation's BASIC in the bulk
violation file, so HM measure is a clean sum.

Output columns: `<basic>_measure` (when we compute it), `<basic>_seg_group`,
`<basic>_percentile`, `<basic>_alert` for all 7 BASICs, plus
`crash_indicator_avg_pu` / `_uf` from the scrape.

Flags:
- `--skip-hm` if violation file hasn't changed
- `--skip-crash` if scrape isn't complete yet

- **Inputs:** parquet + inspection + violation + crash files + scrape output
- **Output:** updates parquet
- **Runtime:** ~5 min full, ~1 min with `--skip-hm --skip-crash`

### `scrape_pu_history.py`
**NEW (May 2026).** Polite per-DOT scraper for FMCSA SMS website data that
isn't in the bulk feed. Currently extracts the Crash Indicator BASIC page:
historical PU snapshots (current / 6mo ago / 18mo ago), UF, VMT, segment.
Routes through a paid proxy (ZenRows) because FMCSA's WAF blocks direct
high-volume scraping.

- **Universe:** ~25k DOTs with crash-sufficiency (≥2 crashes in 24mo AND
  ≥1 in 12mo) — the carriers FMCSA scores for Crash Indicator
- **Output:** `data/fmcsa_scrape/crash_indicator_<vintage>.parquet`
- **Runtime:** ~90 min at 5 RPS through ZenRows
- **Cost:** ~$10 per full run (ZenRows premium-proxy credits)
- **Resumability:** writes intermediate parquet every 500 records;
  re-running skips already-`ok` DOTs by snapshot vintage tag

### `compute_iss.py`
**NEW (May 2026).** Implements the full FMCSA Inspection Selection System
algorithm (ISS-CSA) per the December 2012 Algorithm Description doc.

Two sub-algorithms:
- **Safety Algorithm** (carriers with sufficient BASIC data): 13-group
  decision tree, within-group percentile ranking, ISS quantiles 75-99 /
  50-74 / 1-49.
- **Insufficient Data Algorithm** (everyone else): OOSO → 100, random 1% →
  99, Case 1 (1-away) → 70-74, Case 2 (zero insp by size) → 63-69,
  Case 3 (some insp) → 50-69.

Output: `iss_score` (1-100), `iss_tier` ('Inspect'/'Optional'/'Pass'),
`iss_group` (which of the 13 groups or 3 cases), `iss_algorithm`
('safety'/'insufficient_data'/'oos'/'random').

- **Dependency:** all prior compute_*.py scripts must have run
- **Runtime:** ~3 min

### `recompute_thresholds.py`
Recomputes peer-group P85/P95/P99 cutoffs for SMS BASIC measures used by
analyzer.ts. Run when the parquet is refreshed.

- **Output:** `thresholds.json` consumed by `lib/thresholds.ts`
- **Runtime:** ~30 sec

## Conventions

- **Polars** for all data manipulation (faster than pandas on 2M-row parquet).
- **Streaming engine** (`.collect(engine="streaming")`) for files >500MB.
- **Schema-stable parquet:** new columns are added via `.join` or
  `.with_columns`; existing columns are dropped + re-added rather than
  renamed in place (DuckDB doesn't tolerate type changes well).
- **Snapshot vintage** in filenames: `crash_indicator_20260514.parquet`
  ties output to the SMS data vintage, not the calendar date the script
  ran. Lets resumable scrapes span multiple days.
- **Compute scripts are idempotent:** running them twice in a row should
  produce identical output. They drop columns first if present.

## TypeScript-side companion

The Next.js app in this repo consumes the parquet via DuckDB:

- `lib/fmcsa.ts`: `FmcsaCarrier` type definition — add new columns here
- `lib/fmcsa-parquet.ts`: SQL SELECT + row-to-Carrier mapping
- `lib/analyzer.ts`: scoring + classification logic per audit request
- `lib/rules/index.ts`: rule registry (single source of truth for rule
  labels, thresholds, fixtures)
- `scripts/check_parquet_schema.mjs`: verifies the checked-in aggregate exactly
  matches the app adapter projection
- `scripts/test_rules.ts`, `scripts/snapshot_audit.ts`: regression tests
  against known-good DOT fixtures

When you add a new column here, you typically also need to:
1. Add it to `ParquetRow` interface in `lib/fmcsa-parquet.ts`
2. Add it to `FmcsaCarrier` type in `lib/fmcsa.ts`
3. Add it to the SQL SELECT in `fetchCarriersFromParquet`
4. Add it to the `rowToCarrier` mapping
5. Wire it into a rule in `lib/rules/index.ts` and `lib/analyzer.ts`
6. Add a test fixture
