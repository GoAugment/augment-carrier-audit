# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Build the lane-liability lookup: each state's INJURY SHARE of truck crashes
occurring in that state, vs the national base. Output -> lib/data/lane-liability.json
(keyed by 2-letter crash-location state) for the email checker's insurance-floor
advisory (lib/email/check.ts).

Why: a lane running through a state where a larger share of truck crashes produce
injuries carries more bodily-injury exposure per incident, so the recommended BIPD
floor goes up ($1.5M on a high-tier lane vs $1M on an elevated one). The highest-
injury state on the lane drives the recommendation.

This file previously shipped with NO generator in the repo: it was built by hand on
2026-06-01 from the May crash extract and then silently carried forward across every
refresh, so it kept describing a crash window that had long since moved. The rule
below was recovered from that artifact and reproduces it exactly (all 11 states,
identical percentages, national 36.0) when pointed at the May file.

CAVEAT — this measures reporting convention as much as road risk. NY sits at ~72%
injury share, roughly double every other state, because NY reports an injury on
nearly every reportable truck crash. That is a state-level artifact, not evidence
that NY lanes are twice as dangerous. It is left in because it reflects real claim
exposure (a reported injury is a claim either way), but it is the reason this table
only ever nudges an insurance FLOOR and never contributes to a carrier's risk score
or verdict. A lane is not risky because of the states it passes through.

Tiers: high (>=45% injury share), elevated (>=38%), among states with >=1000 crashes
in the window; everyone else is omitted (treated as low-injury -> no advisory).
"""
import json
import os
import sys
from pathlib import Path

import polars as pl

REPO = Path(__file__).resolve().parent.parent.parent

# The SMS crash extract (a trailing ~24-month window), NOT the full-history
# Crash_File.csv — the advisory is about the current risk picture.
CRASH = Path(
    os.environ.get("FMCSA_CRASH_FILE", REPO / "data" / "sources" / "SMS_Input_-_Crash.csv")
)
OUT = Path(
    os.environ.get("FMCSA_LANE_LIABILITY_OUT", REPO / "lib" / "data" / "lane-liability.json")
)

HIGH_PCT = 45.0
ELEVATED_PCT = 38.0
MIN_CRASHES = 1000

# Stamped into _meta so a stale artifact is visible on inspection rather than
# having to be inferred. No default: build_all.py exports it.
SNAPSHOT = os.environ.get("FMCSA_SNAPSHOT_DATE")
if not SNAPSHOT:
    sys.exit(
        "build_lane_liability: FMCSA_SNAPSHOT_DATE is unset — "
        "run via build_all.py or set it (YYYYMMDD)."
    )

if not CRASH.exists():
    sys.exit(f"build_lane_liability: crash file not found: {CRASH}")


def main() -> None:
    # infer_schema_length=0 -> read everything as str; Injuries is cast explicitly.
    # A blank/garbage Injuries field must count as "no injury", never as null-drop,
    # or the denominator and numerator disagree.
    df = pl.read_csv(CRASH, infer_schema_length=0).with_columns(
        pl.col("Injuries").cast(pl.Int32, strict=False).fill_null(0),
        pl.col("Report_State").str.to_uppercase().str.strip_chars(),
    )

    total = df.height
    if total == 0:
        sys.exit(f"build_lane_liability: crash file is empty: {CRASH}")

    national = round((df["Injuries"] > 0).mean() * 100, 1)

    by_state = (
        df.group_by("Report_State")
        .agg(n=pl.len(), inj=(pl.col("Injuries") > 0).sum())
        .with_columns(pct=(pl.col("inj") / pl.col("n") * 100).round(1))
        .filter(
            (pl.col("n") >= MIN_CRASHES)
            & (pl.col("pct") >= ELEVATED_PCT)
            & pl.col("Report_State").str.len_chars().eq(2)
        )
        # Sort by state so the emitted JSON is byte-stable across runs; an
        # unstable key order would show up as spurious diff noise every refresh.
        .sort("Report_State")
    )

    out: dict[str, object] = {}
    for row in by_state.iter_rows(named=True):
        out[row["Report_State"]] = {
            "injury_pct": row["pct"],
            "tier": "high" if row["pct"] >= HIGH_PCT else "elevated",
        }

    out["_meta"] = {
        "source": CRASH.name,
        "national_injury_pct": national,
        "note": (
            "Injury share of truck crashes by crash-location state. "
            f"tier: high>={HIGH_PCT:g}%, elevated>={ELEVATED_PCT:g}%. "
            f"Only states with >={MIN_CRASHES} crashes + above-elevated kept."
        ),
        "generated": SNAPSHOT,
        "total_crashes": total,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=2) + "\n")

    highs = [s for s, v in out.items() if s != "_meta" and v["tier"] == "high"]
    print(
        f"[build_lane_liability] {total:,} crashes, national injury share {national}% -> "
        f"{len(out) - 1} states kept ({len(highs)} high: {', '.join(highs) or 'none'}) -> {OUT}"
    )


if __name__ == "__main__":
    main()
