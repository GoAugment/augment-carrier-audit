# FMCSA reference documentation

Authoritative FMCSA source documents that govern the calculations in this
pipeline. Drop new reference PDFs here and add a row to the table.

| File | What it governs | Used by |
|------|-----------------|---------|
| `SMS_Methodology_v3.20.pdf` | Safety Measurement System: BASIC measures, Safety Event Groups, percentile ranking, intervention thresholds, Combo/Straight segmentation. | `compute_basics.py` |
| `ISS-CSA_Algorithm_Dec2012.pdf` | Inspection Selection System (ISS-CSA): 13-group Safety Algorithm + Insufficient Data Algorithm, ISS 1–100 scoring, Serious Violation handling. | `compute_iss.py` |
| `FAST_Act_High-Risk_Carrier_Criteria.pdf` | FAST Act §5305 High-Risk identification: 2+ of {Unsafe Driving, Crash Indicator, HOS, Vehicle Maintenance} ≥90th percentile, investigation-targeting criteria. | `add_high_risk.py` |

## Not stored here (intentionally)

- **Safety Fitness Determination NPRM (81 FR 3562, RIN 2126-AB11, Jan 2016)** —
  withdrawn March 23, 2017 (82 FR 14848); never took effect. We do **not**
  implement it. Reference only: https://www.fmcsa.dot.gov/sites/fmcsa.dot.gov/files/docs/SFD_NPRM_01-14-16.pdf

## Notes

- The SMS Methodology version should match the data vintage we ingest. The
  bulk SMS files are tagged `20260514`; confirm the methodology PDF here is the
  edition in force for that run before trusting boundary tables.
