# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""
Chameleon carrier detection — find multiple DOTs registered at the same address.

Method:
  1. Scan census file for all carriers.
  2. Normalize address (street + city + state + zip).
  3. Find addresses with >= 2 DOTs.
  4. For each T1-booked carrier sharing an address with another DOT, surface:
       - Other DOTs at that address
       - Each one's ADD_DATE (registration date), name, fleet size
       - Joined with parquet's crash/OOS data for safety context

A genuine chameleon pattern is: a recently-registered DOT (ADD_DATE < 2 years)
sharing an address with an older DOT that has a bad safety record OR is closed.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import polars as pl

HERE = Path(__file__).parent
T1_DIR = HERE.parent / "t1-fmcsa-2026-05-14"
CENSUS = Path("/Users/art/Downloads/SMS_Input_-_Motor_Carrier_Census_Information_20260514.csv")
PARQUET = HERE / "carrier_aggregates.parquet"
CARRIERS_JSON = T1_DIR / "carriers.json"

OUT_CSV = T1_DIR / "chameleon_clusters.csv"
OUT_MD = T1_DIR / "chameleon_clusters.md"


def normalize_expr() -> pl.Expr:
    """Build a normalized address key column."""
    # Polars regex replace to strip suite/unit/etc.
    street = (
        pl.col("PHY_STREET")
        .fill_null("")
        .str.to_uppercase()
        .str.strip_chars()
        .str.replace_all(r"\s+(STE|SUITE|UNIT|APT|#)\s*[A-Z0-9-]+", "", literal=False)
        .str.replace_all(r"\s+", " ", literal=False)
    )
    city = pl.col("PHY_CITY").fill_null("").str.to_uppercase().str.strip_chars()
    state = pl.col("PHY_STATE").fill_null("").str.to_uppercase().str.strip_chars()
    zipc = pl.col("PHY_ZIP").fill_null("").str.head(5)
    return pl.concat_str([street, city, state, zipc], separator="|")


def main() -> None:
    t1 = json.loads(CARRIERS_JSON.read_text())
    t1_dots = {int(c["dotNumber"]) for c in t1}
    print(f"T1 booked carriers: {len(t1_dots)}")

    print(f"Scanning census {CENSUS.name}...")
    census = (
        pl.scan_csv(
            CENSUS,
            schema_overrides={"DOT_NUMBER": pl.Int64, "NBR_POWER_UNIT": pl.Int64},
            ignore_errors=True,
        )
        .with_columns(addr_key=normalize_expr())
        .filter(pl.col("addr_key").str.len_chars() > 5)  # drop blank-address rows
        .select(
            "DOT_NUMBER", "LEGAL_NAME", "DBA_NAME",
            "PHY_STREET", "PHY_CITY", "PHY_STATE", "PHY_ZIP",
            "TELEPHONE", "EMAIL_ADDRESS", "ADD_DATE", "MCS150_DATE",
            "NBR_POWER_UNIT", "addr_key",
        )
        .collect(engine="streaming")
    )
    print(f"Census rows loaded: {census.height:,}")

    # Find clusters: addresses with >= 2 DOTs
    cluster_sizes = (
        census.group_by("addr_key").agg(pl.col("DOT_NUMBER").n_unique().alias("n_dots"))
        .filter(pl.col("n_dots") >= 2)
    )
    print(f"Multi-DOT address clusters: {cluster_sizes.height:,}")

    # Restrict to clusters containing a T1 carrier
    t1_addresses = (
        census.filter(pl.col("DOT_NUMBER").is_in(list(t1_dots)))
        .select("DOT_NUMBER", "addr_key")
        .rename({"DOT_NUMBER": "t1_dot"})
    )
    t1_clusters = t1_addresses.join(cluster_sizes, on="addr_key", how="inner")
    print(f"T1 carriers sharing an address with another DOT: {t1_clusters.height}")

    # Now hydrate the full cluster details
    cluster_keys = t1_clusters.get_column("addr_key").unique().to_list()
    members = census.filter(pl.col("addr_key").is_in(cluster_keys))

    # Join in safety data from parquet
    pq = pl.read_parquet(PARQUET).select(
        "DOT_NUMBER", "crashes_24mo", "fatal_crashes_24mo",
        "driver_oos_rate", "vehicle_oos_rate", "inspections_24mo", "power_units",
    )
    members = members.join(pq, on="DOT_NUMBER", how="left")

    # Build summary
    rows: list[dict] = []
    for key in cluster_keys:
        cluster = members.filter(pl.col("addr_key") == key).sort("ADD_DATE")
        if cluster.height < 2:
            continue
        t1_dots_here = [d for d in cluster["DOT_NUMBER"].to_list() if d in t1_dots]
        other_dots = [d for d in cluster["DOT_NUMBER"].to_list() if d not in t1_dots]
        # one row per T1 carrier in this cluster
        for t1_dot in t1_dots_here:
            t1_row = cluster.filter(pl.col("DOT_NUMBER") == t1_dot).to_dicts()[0]
            others_data = cluster.filter(pl.col("DOT_NUMBER") != t1_dot).to_dicts()
            # Summarize others
            others_summary = "; ".join(
                f"DOT {o['DOT_NUMBER']} ({o['LEGAL_NAME']}, added {o['ADD_DATE']}, "
                f"{o.get('crashes_24mo') or 0} crashes, "
                f"PU={o.get('NBR_POWER_UNIT')})"
                for o in others_data[:5]
            )
            if len(others_data) > 5:
                others_summary += f"; +{len(others_data)-5} more"
            rows.append({
                "t1_dot": t1_dot,
                "t1_name": t1_row["LEGAL_NAME"],
                "t1_add_date": t1_row["ADD_DATE"],
                "t1_pu": t1_row.get("NBR_POWER_UNIT"),
                "t1_crashes_24mo": t1_row.get("crashes_24mo") or 0,
                "address": f"{t1_row['PHY_STREET']}, {t1_row['PHY_CITY']}, {t1_row['PHY_STATE']} {t1_row['PHY_ZIP']}",
                "cluster_size": cluster.height,
                "other_dots": others_summary,
            })

    if not rows:
        print("No T1 carriers share an address with another DOT in census.")
        return

    rows.sort(key=lambda r: (-r["cluster_size"], r["t1_dot"]))

    # CSV
    import csv
    fieldnames = ["t1_dot", "t1_name", "t1_add_date", "t1_pu", "t1_crashes_24mo",
                  "address", "cluster_size", "other_dots"]
    with open(OUT_CSV, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        for r in rows:
            w.writerow(r)
    print(f"Wrote {OUT_CSV}")

    # MD
    md = ["# T1 Chameleon / Multi-DOT Address Check — 2026-05-14", "",
          f"**T1 carriers booked today:** {len(t1_dots)}",
          f"**Carriers sharing an address with another DOT:** {len(rows)} ({len(rows)/len(t1_dots)*100:.1f}%)",
          "",
          "## Clusters (sorted by cluster size)",
          "",
          "| Cluster size | T1 DOT | T1 carrier | T1 added | T1 crashes | Address | Other DOTs at same address |",
          "|---:|---:|---|---|---:|---|---|"]
    for r in rows:
        md.append(
            f"| {r['cluster_size']} | {r['t1_dot']} | {r['t1_name']} | "
            f"{r['t1_add_date']} | {r['t1_crashes_24mo']} | {r['address']} | {r['other_dots']} |"
        )
    md.append("")
    md.append("**Note:** Multi-DOT-at-same-address is not proof of fraud — large logistics buildings, virtual offices, and registered-agent addresses are common. But ≥3 DOTs sharing an address, especially with one of them recently added (ADD_DATE < 12 months), is a red flag worth investigating.")
    OUT_MD.write_text("\n".join(md))
    print(f"Wrote {OUT_MD}")


if __name__ == "__main__":
    main()
