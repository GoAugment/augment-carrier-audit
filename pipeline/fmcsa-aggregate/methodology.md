# FMCSA Carrier Safety Screening — Methodology

**Snapshot date:** 2026-08-12
**Window:** Trailing 24 months (2024-05-14 → 2026-08-12)
**Universe:** 2,085,534 carriers in the FMCSA MCMIS census

## Data source

We use the four official **FMCSA SMS Input bulk files** published monthly by the U.S. DOT Open Data Portal:

| File | Purpose | Size |
|---|---|---:|
| `SMS_Input_-_Motor_Carrier_Census_Information_YYYYMMDD.csv` | Carrier identity, power units, hazmat flag | 752 MB |
| `SMS_AB_PassProperty_YYYYMMDD.csv` | 24-mo pre-aggregated inspection counts + BASIC alerts | 64 MB |
| `Crash_File.csv` | All reportable crashes (we filter to last 24 mo) | 1.85 GB |
| `Vehicle_Inspection_File.csv` | All inspections (we derive hazmat OOS rates) | 2.87 GB |

These are the same source files FMCSA uses internally to compute SMS BASIC scores. The bulk files refresh monthly. **We do not call any per-DOT live API.**

### Why bulk over API
1. Same underlying database — both bulk and QCMobile/SAFER API draw from MCMIS.
2. Zero API key required, no rate limits.
3. 2M carriers in one local 38 MB parquet file, fast enough to serve from a Vercel function with no cold-start API dependency.

### Verification
Six known DOTs were cross-checked against prior live-API pulls:

| Carrier | DOT | Bulk | Live API |
|---|---:|---|---|
| DK MAX TRUCKING | 3621624 | 33 crashes / 60 PU = 0.55/truck | 0.55/truck ✓ |
| ASAP TRANS | 2075148 | 19 / 38 = 0.50/truck | 0.50/truck ✓ |
| KAM TRUCKING | 3333366 | 100% vehicle OOS | 100% ✓ |
| XYQ EXPRESS | 2049859 | 35.7% driver OOS (5/14) | 36% (5/14) ✓ |
| LETEM | 3201000 | 29.4% driver OOS | 29% ✓ |
| PARAMOUNT | 3943677 | 28.6% driver OOS | 33.3%* |

*PARAMOUNT delta is explained by snapshot timing — live API includes inspections more recent than our monthly bulk cutoff.

## Thresholds

Four signals, each with a fixed cutoff that maps to the **national 85th percentile** with a sufficiency filter applied:

| Signal | Cutoff | Defensible framing |
|---|---:|---|
| **Driver OOS rate** | **≥ 10%** | National P85 among carriers with ≥20 driver inspections in 24 months (actual P85: 9.96%, n=37,335). Roughly 2× the national average of 5.17%. |
| **Vehicle OOS rate** | **≥ 40%** | National P85 among carriers with ≥10 vehicle inspections in 24 months (actual P85: 40.00%, n=49,048). Roughly 2× the national average of 21.24%. |
| **Hazmat OOS rate** | **≥ 5%** | Approximate P85 among hazmat-placarded carriers with ≥5 hazmat inspections (actual P85: 7.1%, n=4,977). Roughly 2× the national average of 2.33%. |
| **Crash-per-truck rate** | **≥ 0.20** | National P85 among carriers with ≥5 power units that had at least one crash (actual P85: 0.20, n=59,475). |

### Why fixed-value cutoffs (not floating P85)
- **Stability** — the threshold doesn't drift month-to-month with the data refresh.
- **Operational simplicity** — operators memorize four numbers (10 / 40 / 5 / 0.20).
- **Defensibility** — "10% is roughly 2× the national average and aligned with the data-derived P85" is a clearer story in deposition than "we use whatever the current P85 happens to be."

### Sufficiency filters
A carrier with 1 inspection and 1 OOS appears at 100% OOS rate — directionally bad but not statistically meaningful. We require minimum inspection counts before applying the percentile-based threshold. Carriers below the sufficiency threshold are reported with raw counts only, not flagged on rates.

## Signals NOT included (yet)

- **Operating authority status** — currently we trust that carriers appearing in `SMS_AB_PassProperty` are active. A monthly snapshot can lag a revocation by up to ~30 days. If a v2 user needs real-time authority, a single QCMobile API call per uploaded DOT can be layered in.
- **BASIC percentile scores** — we have the BASIC *measures* and *alert flags* (`UNSAFE_DRIV_AC`, etc.), but the percentile rankings live in a separate FMCSA file. Optional add for v2.
- **Insurance status** — comes from a separate L&I file (FMCSA Licensing & Insurance).

## Output

`carrier_aggregates.parquet` — 38 MB, 2,085,534 rows × 30 columns. One row per DOT. Indexed by `DOT_NUMBER`.

Key columns: `LEGAL_NAME`, `DBA_NAME`, `PHY_STATE`, `HM_FLAG`, `power_units`, `drivers`, `inspections_24mo`, `driver_oos_rate`, `vehicle_oos_rate`, `hazmat_oos_rate`, `crashes_24mo`, `fatal_crashes_24mo`, `injury_crashes_24mo`, `crashes_per_truck`, BASIC alert flags.

## Refresh cadence

Re-run `build_aggregates.py` monthly when DOT publishes the new SMS Input files (typically by the 15th of each month). Output parquet is what the Vercel app consumes; no code changes needed for refreshes.

## Sources

- FMCSA SMS Input bulk files (https://data.transportation.gov/, monthly)
- FMCSA SMS Methodology v3.0.4 (BASIC definitions, sufficiency thresholds)
- Internal spot-checks against FMCSA QCMobile live API for verification
