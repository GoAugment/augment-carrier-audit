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
| `Carrier_All_With_History.csv` | ~335 MB | [data.transportation.gov — Carrier - All With History](https://data.transportation.gov/Trucking-and-Motorcoaches/Carrier-All-With-History/n76j-r3iz) | Operating authority, BIPD / cargo / bond insurance, business + mailing address |
| `ActPendInsur_All_With_History.csv` | ~50 MB | [data.transportation.gov — ActPendInsur](https://data.transportation.gov/Trucking-and-Motorcoaches/ActPendInsur-All-With-History/ypue-kdue) | Current/pending insurance policies (insurer name, policy number, effective/cancel dates, amounts) |
| `Revocation_-_All_With_History_*.csv` | ~120 MB | [data.transportation.gov — Revocation](https://data.transportation.gov/Trucking-and-Motorcoaches/Revocation-All-With-History/2eyu-5pc4) | Authority revocations (voluntary + involuntary) |
| `inshist_allwithhistory.txt` | ~1.28 GB | [data.transportation.gov — InsHist](https://data.transportation.gov/Trucking-and-Motorcoaches/InsHist-All-With-History/szfe-tikd) | Historical insurance policy lifecycle (cancellation reasons: Cancelled / Replaced / Name Change / Transferred — chameleon detection) |
| `closed_enforcement_cases_*.xlsx` | ~25 KB | [data.transportation.gov — Closed Enforcement Cases](https://data.transportation.gov/Trucking-and-Motorcoaches/Closed-Enforcement-Cases/cur9-tfg7) | FMCSA civil-penalty cases against carriers/brokers |
| `SMS_AB_PassProperty_*.csv` | ~65 MB | [SMS Tools — All Interstate + Intrastate Hazmat Property](https://ai.fmcsa.dot.gov/SMS/Tools/Downloads.aspx) | FMCSA's pre-computed BASIC measures + alert flags (Unsafe Driving, HOS, Driver Fitness, Controlled Substances, Vehicle Maintenance) |
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

## Refresh procedure (monthly)

FMCSA publishes new snapshots around the 13th-18th of each month. To refresh:

1. From [data.transportation.gov](https://data.transportation.gov/browse?category=Trucking+and+Motorcoaches&limitTo=datasets&utf8=%E2%9C%93), download each file in the "Files we use" table above (Datasets view, not External Datasets).
2. From [SMS Tools Downloads](https://ai.fmcsa.dot.gov/SMS/Tools/Downloads.aspx), download `SMS_AB_PassProperty`.
3. Drop them into this folder (`data/sources/`). The build script's globs will pick up the latest by mtime — no rename needed.
4. Run the Polars pipeline (canonical builder, lives in the sibling workspace):
   `uv run /Users/art/conductor/workspaces/augment-services/abuja/.context/fmcsa-aggregate/build_aggregates.py`
5. Copy the resulting `carrier_aggregates.parquet` + `carrier_identity.parquet` into `data/`.
6. Validate against the 12-DOT SAFER baseline (numbers in `data/national_thresholds.json` should match).

> A second DuckDB-based builder (`scripts/build_parquet.mjs`) was prototyped early on but is no longer maintained — the Polars pipeline is the source of truth for column schema and chameleon-cluster derivations.

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
