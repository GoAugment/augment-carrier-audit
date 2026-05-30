# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Build an empirical ZIP-reputation lookup: each physical-address ZIP's
carrier "shutdown" rate (involuntary revocation on record / not-allowed-to-
operate / FMCSA prior-revoke flag) vs the national base.

Why: FreightWaves/FreightCenter flag new-authority "surge" ZIPs (Fresno,
Bakersfield, Manteca, Laredo) as chameleon/ghost-fleet hotspots. Ranking by
SHUTDOWN RATE (an outcome) rather than raw new-authority count (growth) is the
stronger fraud signal — and it independently reproduces those same hotspots at
2–3x the national base. Same lift approach as insurer-risk.

IMPORTANT — soft corroborator only. These are also legitimate high-volume
freight hubs (Laredo = #1 US–Mexico crossing, CA Central Valley = ag freight,
NJ = ports). A carrier is not high-risk *because of* its ZIP; the ZIP only
sharpens another signal. Never flag on ZIP alone (fairness).

Output → lib/data/zip-risk.json keyed by 5-digit ZIP. Regenerate on each refresh.
Tiers: high (lift>=2.5), elevated (lift>=1.5), among ZIPs with >=500 carriers;
everyone else omitted (treated normal).
"""
import json
from pathlib import Path
import polars as pl

AGG = Path("data/carrier_aggregates.parquet")
IDN = Path("data/carrier_identity.parquet")
OUT = Path("lib/data/zip-risk.json")
MIN_CARRIERS = 500


def main() -> None:
    agg = pl.read_parquet(AGG).select(
        "DOT_NUMBER", "allowed_to_operate", "most_recent_involuntary_date", "prior_revoke_flag"
    )
    idn = pl.read_parquet(IDN).select("DOT_NUMBER", "phy_zip")
    df = idn.join(agg, on="DOT_NUMBER", how="inner").with_columns(
        pl.col("phy_zip").cast(pl.Utf8).str.extract(r"(\d{5})").alias("zip5")
    ).filter(pl.col("zip5").is_not_null())

    # "Shut down" = FMCSA pulled the authority: involuntary revocation on record,
    # currently not allowed to operate, or carrying the chameleon prior-revoke flag.
    shut = (
        pl.col("most_recent_involuntary_date").is_not_null()
        | (pl.col("allowed_to_operate").cast(pl.Utf8).str.to_uppercase() == "N")
        | pl.col("prior_revoke_flag").fill_null(False)
    )
    df = df.with_columns(shut.alias("shut"))
    base = df.select(pl.col("shut").mean()).item()
    print(f"[build_zip_risk] carriers with ZIP: {df.height:,}  base shutdown rate: {base*100:.2f}%")

    g = (
        df.group_by("zip5")
        .agg(pl.len().alias("n"), pl.col("shut").sum().alias("s"))
        .filter(pl.col("n") >= MIN_CARRIERS)
        .with_columns((pl.col("s") / pl.col("n")).alias("rate"))
        .with_columns((pl.col("rate") / base).alias("lift"))
    )

    out: dict[str, dict] = {}
    for r in g.iter_rows(named=True):
        lift = r["lift"]
        tier = "high" if lift >= 2.5 else "elevated" if lift >= 1.5 else None
        if tier:
            out[r["zip5"]] = {
                "tier": tier,
                "lift": round(lift, 1),
                "rate": round(r["rate"], 4),
                "n": int(r["n"]),
            }
    OUT.write_text(json.dumps({"base_rate": round(base, 4), "zips": out}, indent=0))
    print(f"[build_zip_risk] wrote {len(out):,} flagged ZIPs → {OUT}")
    top = g.sort("lift", descending=True).head(10)
    for r in top.iter_rows(named=True):
        print(f"  {r['zip5']}  n={r['n']:>6,}  shut={r['rate']*100:4.1f}%  lift={r['lift']:.2f}x")


if __name__ == "__main__":
    main()
