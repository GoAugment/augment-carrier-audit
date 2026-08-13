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
OLD_CARRIER = Path(os.environ.get("FMCSA_CARRIER_AUTH_RAW", SOURCES / "Carrier_All_With_History.csv"))
MOTUS_CARRIER = Path(os.environ.get("FMCSA_MOTUS_CARRIER", SOURCES / "Motus_Carrier_All_With_History.csv"))
MOTUS_INSUR = Path(os.environ.get("FMCSA_MOTUS_INSUR", SOURCES / "Motus_Insur_All_With_History.csv"))

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


def merge_carrier_auth() -> None:
    """DISABLED — do not wire this up as-is. Kept for the parts that are right.

    !!! Motus Carrier's BIPD_FILE IS NOT L&I's BIPD_FILE !!!

    Upserting it reports genuinely-insured carriers as uninsured. Schneider
    National (DOT 264184) is the proof: L&I has one docket row, BIPD_FILE
    "01000" ($1M). Motus has FOUR rows for that same docket — one per authority
    type (property carrier, HHG carrier, property broker, HHG broker) — and
    BIPD_FILE is "0" on every one, while MIN_COV_AMOUNT is 1000000 on the
    carrier authority. Wiring this in flipped Schneider to
    riskLevel Critical / "Insurance lapsed", and would have done the same to
    ~1,399 carriers that this merge newly zeroed.

    THE CORRECT SOURCE IS Motus_Insur (c5y8-a4uz), NOT Motus_Carrier. BIPD is
    the BMC-91/91X filings (INS_FORM_CODE), and the old BIPD_FILE was the SUM of
    primary + excess — which reproduces our existing values exactly:
        Werner   (53467): 4,000,000 + 1,000,000 self-insured = 5000 ($5M) ✓
        JB Hunt  (80806): 2,500,000 excess + 1,000,000 primary = 3500 ($3.5M) ✓
    Cargo is BMC-34, broker surety BMC-84/85, bond BMC-82 — do not sum those in.
    Watch for duplicate rows (Werner's 4M appears twice, Hunt's 2.5M four times);
    de-dup before summing.

    What IS correct here and worth keeping:
      - the units conversion (see below) — verified by the old file's max
        "75005" matching Motus "75005000" on the same carrier
      - the upsert-not-union shape, and the DOT-normalised key

    ---- original notes ----

    Upsert live Motus insurance state onto the frozen Carrier-auth snapshot.

    This is an UPSERT, not a union: Carrier-auth is current-state (one row per
    docket), not an event log. That works in our favour — Motus only carries
    entities touched since the cutover (103,821 rows vs 1.86M), and a carrier
    that hasn't changed since 5/14 still has correct May values. So old rows
    stay unless Motus has something newer.

    UNITS ARE DIFFERENT AND SILENT. The L&I file stores $-thousands, zero-padded
    ("00750" = $750k); Motus stores whole dollars ("750000"). Copying Motus
    values across verbatim would inflate every carrier's coverage 1000x and make
    the $0-BIPD gate meaningless, so they're divided by 1,000 back into the old
    convention. build_aggregates parses these as Float64 $-thousands
    (bipd_insurance_on_file: Werner 5000.0 = $5M).

    Only the insurance columns are overwritten. The authority *_CHK / *_STAT
    columns are deliberately left alone: Motus collapsed the common/contract
    distinction so that mapping is lossy, and nothing needs it — the
    authority-active determination comes from Company Census (status_code),
    which never stopped updating.
    """
    old = pl.read_csv(OLD_CARRIER, infer_schema_length=0, ignore_errors=True)
    cols = old.columns
    log(f"old L&I carrier-auth rows: {old.height:,} (frozen at {CUTOVER})")

    def dollars_to_thousands(col: str) -> pl.Expr:
        return (
            (pl.col(col).cast(pl.Float64, strict=False) / 1000.0)
            .round(0).cast(pl.Int64, strict=False).cast(pl.Utf8).str.zfill(5)
        )

    motus = pl.read_csv(MOTUS_CARRIER, infer_schema_length=0, ignore_errors=True).with_columns(
        DOT_NUMBER=pl.col("USDOT_NUMBER").cast(pl.Int64, strict=False),
        m_bipd=dollars_to_thousands("BIPD_FILE"),
        m_mincov=dollars_to_thousands("MIN_COV_AMOUNT"),
    ).filter(pl.col("DOT_NUMBER").is_not_null())
    # One row per (DOT, docket): keep the largest coverage if Motus repeats a pair.
    motus = motus.sort("m_bipd", descending=True).unique(subset=["DOT_NUMBER", "DOCKET_NUMBER"], keep="first")
    log(f"Motus carrier rows: {motus.height:,}")

    joined = old.with_columns(_dot=pl.col("DOT_NUMBER").cast(pl.Int64, strict=False)).join(
        motus.select("DOT_NUMBER", "DOCKET_NUMBER", "m_bipd", "m_mincov",
                     m_cargo=pl.col("CARGO_FILE"), m_cargo_req=pl.col("CARGO_REQ"),
                     m_bond=pl.col("BOND_FILE"), m_bond_req=pl.col("BOND_REQ")),
        left_on=["_dot", "DOCKET_NUMBER"], right_on=["DOT_NUMBER", "DOCKET_NUMBER"], how="left",
    )
    matched = joined.filter(pl.col("m_bipd").is_not_null()).height
    changed = joined.filter(
        pl.col("m_bipd").is_not_null()
        & (pl.col("m_bipd").cast(pl.Float64) != pl.col("BIPD_FILE").cast(pl.Float64, strict=False))
    ).height
    lost = joined.filter(
        pl.col("m_bipd").is_not_null()
        & (pl.col("BIPD_FILE").cast(pl.Float64, strict=False) > 0)
        & (pl.col("m_bipd").cast(pl.Float64) == 0)
    ).height
    log(f"  matched dockets: {matched:,}  BIPD amount changed: {changed:,}  "
        f"dropped to $0 since cutover: {lost:,}")

    upserted = joined.with_columns(
        BIPD_FILE=pl.coalesce("m_bipd", "BIPD_FILE"),
        MIN_COV_AMOUNT=pl.coalesce("m_mincov", "MIN_COV_AMOUNT"),
        CARGO_FILE=pl.coalesce("m_cargo", "CARGO_FILE"),
        CARGO_REQ=pl.coalesce("m_cargo_req", "CARGO_REQ"),
        BOND_FILE=pl.coalesce("m_bond", "BOND_FILE"),
        BOND_REQ=pl.coalesce("m_bond_req", "BOND_REQ"),
    ).select(cols)

    # Entities Motus knows about that the frozen file never had (new authorities
    # since the cutover). Emit them with the columns Motus supplies + the
    # authority checkbox implied by OP_AUTH_TYPE, so they aren't invisible.
    # Key on the Int64-normalised DOT on BOTH sides — the old file's DOT_NUMBER
    # is a raw (sometimes zero-padded) string, so keying on it directly makes
    # every Motus row look new.
    known = set(
        old.select(
            pl.col("DOT_NUMBER").cast(pl.Int64, strict=False).cast(pl.Utf8) + "|" + pl.col("DOCKET_NUMBER")
        ).to_series().to_list()
    )
    new_rows = motus.with_columns(
        _key=pl.col("DOT_NUMBER").cast(pl.Utf8) + "|" + pl.col("DOCKET_NUMBER")
    ).filter(~pl.col("_key").is_in(known))
    if new_rows.height:
        t = pl.col("OP_AUTH_TYPE").fill_null("")
        built = new_rows.with_columns(
            PROPERTY_CHK=pl.when(t.str.contains("(?i)property")).then(pl.lit("Y")).otherwise(pl.lit("N")),
            PASSENGER_CHK=pl.when(t.str.contains("(?i)passenger")).then(pl.lit("Y")).otherwise(pl.lit("N")),
            HHG_CHK=pl.when(t.str.contains("(?i)household")).then(pl.lit("Y")).otherwise(pl.lit("N")),
            ENTERPRISE_CHK=pl.when(t.str.contains("(?i)enterprise")).then(pl.lit("Y")).otherwise(pl.lit("N")),
            _stat=pl.when(pl.col("OP_AUTH_STATUS") == "Active").then(pl.lit("A"))
                   .when(pl.col("OP_AUTH_STATUS").is_in(["Inactive", "Withdrawn"])).then(pl.lit("I"))
                   .otherwise(pl.lit("N")),
        ).with_columns(
            COMMON_STAT=pl.when(t.str.contains("(?i)broker")).then(pl.lit("N")).otherwise(pl.col("_stat")),
            BROKER_STAT=pl.when(t.str.contains("(?i)broker")).then(pl.col("_stat")).otherwise(pl.lit("N")),
            BIPD_FILE=pl.col("m_bipd"), MIN_COV_AMOUNT=pl.col("m_mincov"),
            DOT_NUMBER=pl.col("DOT_NUMBER").cast(pl.Utf8),
        )
        for c in cols:
            if c not in built.columns:
                built = built.with_columns(pl.lit(None, dtype=pl.Utf8).alias(c))
        merged = pl.concat([upserted, built.select(cols)], how="vertical_relaxed")
        log(f"  appended {new_rows.height:,} dockets new since the cutover")
    else:
        merged = upserted

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "Carrier_All_With_History.csv"
    merged.write_csv(out)
    log(f"merged carrier auth: {merged.height:,} rows ({merged.height - old.height:+,}) → {out}")


def merge_insurance() -> None:
    """Rebuild BIPD-on-file from Motus_Insur and upsert it onto the frozen file.

    BIPD lives in the BMC-91/91X filings, and L&I's BIPD_FILE was the SUM of
    them (primary + excess) — but only the filings still IN EFFECT. The feed
    carries superseded policies alongside live ones, so summing everything
    double-counts a layer (see the de-dup below).

    Validated against the frozen L&I file as ground truth, split by whether the
    carrier had any post-cutover insurance transaction:

        carriers with NO post-cutover activity   99.4% exact  (n=51,738)
        carriers WITH post-cutover activity      62.0% exact  (n=17,780)

    The first number is the correctness check — those carriers' insurance did
    not change, so the reconstruction must reproduce L&I, and it does. The
    second is the point of the exercise: 45% of active carriers have insurance
    that moved since 2026-05-14 and we were still reporting the May figure.
    Reference points: Werner 4M + 1M self-insured = $5M; JB Hunt 2.5M + 1M =
    $3.5M — both match the values already in the parquet.

    Do NOT use Motus_Carrier.BIPD_FILE for this (see merge_carrier_auth).
    Cargo is BMC-34, broker surety BMC-84/85, bond BMC-82 — excluded here.
    """
    old = pl.read_csv(OLD_CARRIER, infer_schema_length=0, ignore_errors=True)
    cols = old.columns
    ins = pl.read_csv(MOTUS_INSUR, infer_schema_length=0, ignore_errors=True).with_columns(
        dot=pl.col("USDOT_NUMBER").cast(pl.Int64, strict=False),
        cov=pl.col("MAX_COV_AMOUNT").cast(pl.Float64, strict=False),
    ).filter(pl.col("dot").is_not_null())

    # One filing per COVERAGE LAYER, most recent transaction wins. The feed
    # carries superseded policies: Werner's primary $1M sits there twice, as a
    # 1998 Palisades filing AND the Self-Insured filing that replaced it, so
    # summing every distinct policy double-counts the layer and reports $6M
    # against a true $5M. Collapsing on (dot, amount) and keeping the latest
    # trans_date drops the superseded row and reproduces L&I exactly.
    bipd = (
        ins.filter(pl.col("INS_FORM_CODE").str.starts_with("BMC-91"))
        .sort("TRANS_DATE", descending=True)
        .unique(subset=["dot", "cov"], keep="first")
        .group_by("dot")
        .agg(bipd_k=(pl.col("cov").sum() / 1000.0))
    )
    # A carrier that transacted after the cutover but has no BMC-91 filing left
    # has lost its BIPD. Restricted to post-cutover activity so we never zero a
    # carrier just because Motus happens not to list an unchanged old policy.
    gone = (
        ins.group_by("dot")
        .agg(
            post=(pl.col("TRANS_DATE") > CUTOVER).any(),
            has_bipd=pl.col("INS_FORM_CODE").str.starts_with("BMC-91").any(),
        )
        .filter(pl.col("post") & ~pl.col("has_bipd"))
        .select("dot", zeroed=pl.lit(0.0))
    )
    log(f"Motus insurance: {bipd.height:,} DOTs with a BIPD filing, "
        f"{gone.height:,} whose BIPD is gone since the cutover")

    merged = (
        old.with_columns(_dot=pl.col("DOT_NUMBER").cast(pl.Int64, strict=False))
        .join(bipd, left_on="_dot", right_on="dot", how="left")
        .join(gone, left_on="_dot", right_on="dot", how="left")
        .with_columns(
            _new=pl.coalesce("bipd_k", "zeroed"),
            _old=pl.col("BIPD_FILE").cast(pl.Float64, strict=False),
        )
    )
    changed = merged.filter(
        pl.col("_new").is_not_null() & (pl.col("_new") != pl.col("_old"))
    ).height
    lost = merged.filter(
        pl.col("_new").is_not_null() & (pl.col("_old") > 0) & (pl.col("_new") == 0)
    ).height
    log(f"  BIPD rows updated: {changed:,}  of which dropped to $0: {lost:,}")

    out_df = merged.with_columns(
        BIPD_FILE=pl.when(pl.col("_new").is_not_null())
        .then(pl.col("_new").round(0).cast(pl.Int64, strict=False).cast(pl.Utf8).str.zfill(5))
        .otherwise(pl.col("BIPD_FILE"))
    ).select(cols)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    out = OUT_DIR / "Carrier_All_With_History.csv"
    out_df.write_csv(out)
    if out_df.height != old.height:
        raise SystemExit(f"row count changed: {out_df.height:,} != {old.height:,}")
    log(f"merged carrier auth (BIPD from Motus_Insur): {out_df.height:,} rows → {out}")


def main() -> None:
    log(f"snapshot={SNAPSHOT}  cutover={CUTOVER}  sources={SOURCES}")
    merge_revocations()
    merge_insurance()
    # merge_carrier_auth() is DISABLED — see its docstring. It is kept because
    # the unit conversion and upsert skeleton are correct and will be needed,
    # but the field it upserts is the wrong one.


if __name__ == "__main__":
    main()
