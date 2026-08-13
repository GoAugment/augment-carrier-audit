# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Splice the live Motus feeds onto the retired L&I files.

WHY THIS EXISTS
---------------
FMCSA replaced Licensing & Insurance with a new system ("Motus") on 2026-05-14
and RETIRED the L&I bulk datasets that day. Their Socrata descriptions say so
outright: "This dataset was last refreshed on 05/14/2026 and will no longer be
updated." `rowsUpdatedAt` still advances daily because FMCSA re-uploads the
frozen file, which is why it went unnoticed for ~3 months — verified by diffing
Carrier-All-With-History across 47 days: 0 authority-status changes in 1,860,604
rows.

Consequence: every authority / insurance / revocation signal was pinned to
2026-05-14. Motus only accumulates from the cutover, so neither source is
sufficient alone — the deep history (1.5M revocation events) lives in the frozen
files, everything since lives in Motus.

This script emits merged files IN THE OLD SCHEMA so no downstream step needs to
know any of this happened. build_all.py points FMCSA_REVOCATION (etc.) at the
merged output instead of the raw source.

VOCABULARY SHIFT (the part that isn't a rename)
-----------------------------------------------
Motus doesn't "revoke" authority the way L&I did — it issues a suspension
notice with a future effective date, and the resulting status change lands in
AuthHist. So one old INVOLUNTARY REVOCATION now shows up as up to two Motus
rows across two datasets:

  old  ORDER2_TYPE_DESC = 'INVOLUNTARY REVOCATION'
  new  RevokeSuspend.ORDER1_TYPE_DESC = 'Operating Authority Involuntary
         Suspension Notice'                              (8,680 rows)
       AuthHist.REASON = 'Revoked' | 'Involuntary Suspension - insurance
         cancellation effective; ...'                    (6,812 rows)

Measured overlap on 2026-08-12: 1,379 DOTs in both, 5,854 only in RevokeSuspend,
935 only in AuthHist — so we need the union, de-duplicated. RevokeSuspend is
treated as authoritative (same shape as the old file); an AuthHist row is
dropped when the same DOT has a RevokeSuspend event within DEDUP_WINDOW_DAYS,
which absorbs the notice -> status-change lag.

PENDING SUSPENSIONS ARE THE NEW IMMINENT-LAPSE SIGNAL
-----------------------------------------------------
Only events already in effect become revocations here, matching old semantics.
The future-dated involuntary notices (1,773 rows / 1,693 DOTs on 2026-08-12)
are written to a separate sidecar. That set is strictly better than the
ActPendInsur-derived lapse signal it replaces: it is FMCSA's own enforcement
action rather than our inference from a cancellation date, and the reason text
states the cause ("insurance cancellation effective; no active insurance
meeting minimum coverage on file").
"""
from __future__ import annotations

import os
from datetime import date
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
SOURCES = Path(os.environ.get("FMCSA_SOURCES_DIR", HERE.parent.parent / "data" / "sources"))
OUT_DIR = Path(os.environ.get("FMCSA_MERGED_DIR", SOURCES / "merged"))

OLD_REVOCATION = Path(os.environ.get("FMCSA_REVOCATION_RAW", SOURCES / "Revocation_-_All_With_History.csv"))
MOTUS_REVSUSP = Path(os.environ.get("FMCSA_MOTUS_REVSUSP", SOURCES / "Motus_RevokeSuspend_All_With_History.csv"))
MOTUS_AUTHHIST = Path(os.environ.get("FMCSA_MOTUS_AUTHHIST", SOURCES / "Motus_AuthHist_All_With_History.csv"))

# As-of date: events effective after this are "pending", not yet revocations.
SNAPSHOT = os.environ.get("FMCSA_SNAPSHOT_DATE", "20260812")
# L&I -> Motus cutover. AuthHist carries pre-cutover history too (back to 1981),
# which would double-count against the old file, so post-cutover rows only.
CUTOVER = "20260514"
DEDUP_WINDOW_DAYS = 45

# OP_AUTH_TYPE (long Motus text) -> TYPE_LICENSE (old short code).
def _type_license(col: str) -> pl.Expr:
    c = pl.col(col).fill_null("")
    return (
        pl.when(c.str.contains("(?i)broker")).then(pl.lit("BROKER"))
        .when(c.str.contains("(?i)contract")).then(pl.lit("CONTRACT"))
        .otherwise(pl.lit("COMMON"))
    )


def _mdY(col: str) -> pl.Expr:
    """Motus YYYYMMDD string -> the old files' MM/DD/YYYY."""
    return (
        pl.col(col).cast(pl.Utf8).str.strptime(pl.Date, format="%Y%m%d", strict=False)
        .dt.strftime("%m/%d/%Y")
    )


def log(m: str) -> None:
    print(f"[merge_motus] {m}", flush=True)


def merge_revocations() -> None:
    old = pl.read_csv(OLD_REVOCATION, infer_schema_length=0, ignore_errors=True)
    log(f"old L&I revocation rows: {old.height:,} (frozen at {CUTOVER})")

    rs = pl.read_csv(MOTUS_REVSUSP, infer_schema_length=0, ignore_errors=True).with_columns(
        DOT_NUMBER=pl.col("USDOT_NUMBER").cast(pl.Int64, strict=False),
        eff_raw=pl.col("ORDER1_EFFECTIVE_DATE").cast(pl.Utf8),
        kind=pl.when(pl.col("ORDER1_TYPE_DESC").str.contains("(?i)involuntary"))
              .then(pl.lit("INVOLUNTARY REVOCATION"))
              .when(pl.col("ORDER1_TYPE_DESC").str.contains("(?i)voluntary"))
              .then(pl.lit("VOLUNTARY REVOCATION"))
              .otherwise(pl.lit(None, dtype=pl.Utf8)),
    ).filter(pl.col("DOT_NUMBER").is_not_null() & pl.col("kind").is_not_null())

    # Pending = future-dated and INVOLUNTARY. A voluntary suspension is the
    # carrier choosing to stop operating; it isn't the risk signal.
    pending = rs.filter((pl.col("eff_raw") > SNAPSHOT) & (pl.col("kind") == "INVOLUNTARY REVOCATION"))
    rs_done = rs.filter(pl.col("eff_raw") <= SNAPSHOT)
    log(f"Motus RevokeSuspend: {rs.height:,} events → {rs_done.height:,} in effect, "
        f"{pending.height:,} pending (future-dated)")

    ah = pl.read_csv(MOTUS_AUTHHIST, infer_schema_length=0, ignore_errors=True).with_columns(
        DOT_NUMBER=pl.col("USDOT_NUMBER").cast(pl.Int64, strict=False),
        eff_raw=pl.col("STATUS_CHANGE_DATE").cast(pl.Utf8),
    ).filter(
        pl.col("DOT_NUMBER").is_not_null()
        & (pl.col("eff_raw") > CUTOVER)          # pre-cutover history is the old file's job
        & (pl.col("eff_raw") <= SNAPSHOT)
        & (
            (pl.col("REASON").str.strip_chars() == "Revoked")
            | pl.col("REASON").str.contains("Involuntary Suspension")
        )
    ).with_columns(kind=pl.lit("INVOLUNTARY REVOCATION"))
    log(f"Motus AuthHist revoked/involuntary-suspension rows post-cutover: {ah.height:,}")

    # Drop AuthHist rows that are the same real-world action as a RevokeSuspend
    # event (notice -> status change lands days later).
    rs_keys = rs_done.select(
        "DOT_NUMBER", rs_eff=pl.col("eff_raw").str.strptime(pl.Date, format="%Y%m%d", strict=False)
    )
    ah_dedup = (
        ah.with_columns(ah_eff=pl.col("eff_raw").str.strptime(pl.Date, format="%Y%m%d", strict=False))
        .join(rs_keys, on="DOT_NUMBER", how="left")
        .with_columns(gap=(pl.col("ah_eff") - pl.col("rs_eff")).dt.total_days().abs())
        .group_by(["DOT_NUMBER", "eff_raw"])
        .agg(min_gap=pl.col("gap").min(), REASON=pl.col("REASON").first(),
             OP_AUTH_TYPE=pl.col("OP_AUTH_TYPE").first(), DOCKET_NUMBER=pl.col("DOCKET_NUMBER").first())
        .filter(pl.col("min_gap").is_null() | (pl.col("min_gap") > DEDUP_WINDOW_DAYS))
    )
    log(f"  after de-dup against RevokeSuspend (±{DEDUP_WINDOW_DAYS}d): {ah_dedup.height:,} kept")

    def shape(df: pl.DataFrame, serve_col: str | None) -> pl.DataFrame:
        return df.select(
            DOCKET_NUMBER=pl.col("DOCKET_NUMBER").cast(pl.Utf8),
            DOT_NUMBER=pl.col("DOT_NUMBER").cast(pl.Utf8),
            TYPE_LICENSE=_type_license("OP_AUTH_TYPE"),
            ORDER1_SERVE_DATE=(_mdY(serve_col) if serve_col else _mdY("eff_raw")),
            ORDER2_TYPE_DESC=pl.col("kind") if "kind" in df.columns else pl.lit("INVOLUNTARY REVOCATION"),
            order2_effective_Date=_mdY("eff_raw"),
        )

    # De-duplicate ONLY within the Motus additions. A global unique() would
    # collapse legitimate old rows: L&I emits one row per authority type, so a
    # carrier losing COMMON + CONTRACT + BROKER on the same day is three rows
    # that share (DOT, type_desc, date). Deduping on that key silently dropped
    # 154,156 real events the first time round.
    motus_new = pl.concat([
        shape(rs_done, "ORDER1_SERVE_DATE"),
        shape(ah_dedup.with_columns(kind=pl.lit("INVOLUNTARY REVOCATION")), None),
    ], how="vertical_relaxed").unique(
        subset=["DOT_NUMBER", "TYPE_LICENSE", "ORDER2_TYPE_DESC", "order2_effective_Date"],
        keep="first",
    )
    merged = pl.concat([
        old.select("DOCKET_NUMBER", "DOT_NUMBER", "TYPE_LICENSE",
                   "ORDER1_SERVE_DATE", "ORDER2_TYPE_DESC", "order2_effective_Date"),
        motus_new,
    ], how="vertical_relaxed")
    if merged.height < old.height:
        raise SystemExit(f"merge lost rows: {merged.height:,} < old {old.height:,}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "Revocation_-_All_With_History.csv"
    merged.write_csv(out)
    added = merged.height - old.height
    log(f"merged revocations: {merged.height:,} rows ({added:+,} vs frozen L&I) → {out}")

    pend_out = OUT_DIR / "motus_pending_suspension.csv"
    pending.select(
        DOT_NUMBER=pl.col("DOT_NUMBER").cast(pl.Utf8),
        DOCKET_NUMBER=pl.col("DOCKET_NUMBER").cast(pl.Utf8),
        TYPE_LICENSE=_type_license("OP_AUTH_TYPE"),
        suspension_type=pl.col("ORDER1_TYPE_DESC"),
        serve_date=_mdY("ORDER1_SERVE_DATE"),
        effective_date=_mdY("eff_raw"),
    ).write_csv(pend_out)
    log(f"pending involuntary suspensions: {pending.height:,} rows / "
        f"{pending['DOT_NUMBER'].n_unique():,} DOTs → {pend_out}")


def main() -> None:
    log(f"snapshot={SNAPSHOT}  cutover={CUTOVER}  sources={SOURCES}")
    merge_revocations()


if __name__ == "__main__":
    main()
