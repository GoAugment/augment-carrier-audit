# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""FMCSA involuntary suspensions for lack of insurance — the live replacement
for the dead imminent-lapse signal.

WHY
---
FMCSA retired the L&I feeds on 2026-05-14 (see merge_motus.py), which killed the
ActPendInsur-derived `bipd_imminent_lapse` rule: it reads pending-cancellation
dates from a file frozen in May, so it now fires for ~500 carriers instead of
~13,700 and none of them are current.

Motus replaces it with something strictly better. Rather than us inferring
"about to lose authority" from an insurance cancellation date, FMCSA publishes
its own enforcement action: an Operating Authority Involuntary Suspension
Notice, served ~30 days before it bites, and an AuthHist status change whose
reason states the cause outright ("Involuntary Suspension - insurance
cancellation effective; no active insurance meeting minimum coverage on file").

Two states, both emitted here:

  pending    a future-dated involuntary suspension notice. The carrier still
             holds authority today but loses it on a known date.
  effective  the suspension has already taken effect and there is no cure. This
             is the missing BIPD-loss detector: 2,141 carriers are suspended for
             no-insurance, and without this the app reads their stale pre-
             suspension coverage and reports it as meeting the requirement.

CURE CHECK IS NOT OPTIONAL. Suspensions do get reversed — AuthHist carries
REINSTATED / Granted / "Discontinued Revocation" events. Measured 2026-08:
only ~1.5% of pending notices are cured, but flagging a carrier that fixed its
insurance is precisely the false Critical this pipeline must not produce, so any
curing action dated at/after the suspension clears the signal.

OUTPUT (three columns on carrier_aggregates.parquet)
  insurance_suspension_status  'pending' | 'effective'   (null = no suspension)
  insurance_suspension_date    YYYY-MM-DD, when authority is/was suspended
  insurance_suspension_days    days from snapshot; negative = already in effect
"""
from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path

import polars as pl

HERE = Path(__file__).resolve().parent
SOURCES = Path(os.environ.get("FMCSA_SOURCES_DIR", HERE.parent.parent / "data" / "sources"))
MERGED = Path(os.environ.get("FMCSA_MERGED_DIR", SOURCES / "merged"))
PENDING = Path(os.environ.get("FMCSA_PENDING_SUSPENSION", MERGED / "motus_pending_suspension.csv"))
AUTHHIST = Path(os.environ.get("FMCSA_MOTUS_AUTHHIST", SOURCES / "Motus_AuthHist_All_With_History.csv"))
# Present-state authority feed. AuthHist is an event log and cannot tell us an
# authority was never restored; this can.
MOTUS_CARRIER = Path(os.environ.get("FMCSA_MOTUS_CARRIER", SOURCES / "Motus_Carrier_All_With_History.csv"))
PARQUET = Path(os.environ.get("FMCSA_PARQUET", HERE / "carrier_aggregates.parquet"))
SNAPSHOT = os.environ.get("FMCSA_SNAPSHOT_DATE", "20260812")

# Reasons that mean "this authority is suspended because the insurance is gone".
# BOTH tokens are required. Matching "Involuntary Suspension" alone also catches
# BOC-3 (process-agent) suspensions, which have nothing to do with insurance —
# that emitted 131 carriers as "no insurance" on an unrelated filing defect.
INSURANCE_SUSPENSION = "Involuntary Suspension"
INSURANCE_TOKEN = "insurance"
# Reasons that mean the carrier fixed it.
# Exact strings from AuthHist.REASON. "Discontinued Revocation" is a cure too —
# FMCSA withdrawing the action — and the docstring above always claimed it was
# handled, but it was missing from this tuple.
CURE = ("REINSTATED", "Reinstated", "GRANTED", "Granted",
        "Discontinued Revocation", "DISCONTINUED REVOCATION")


def log(m: str) -> None:
    print(f"[add_insurance_suspension] {m}", flush=True)


def main() -> None:
    snap = datetime.strptime(SNAPSHOT, "%Y%m%d").date()
    log(f"snapshot {snap}")

    ah = pl.read_csv(AUTHHIST, infer_schema_length=0, ignore_errors=True).with_columns(
        DOT_NUMBER=pl.col("USDOT_NUMBER").cast(pl.Int64, strict=False),
        when=pl.col("STATUS_CHANGE_DATE").cast(pl.Utf8).str.strptime(pl.Date, format="%Y%m%d", strict=False),
        reason=pl.col("REASON").fill_null("").str.strip_chars(),
    ).filter(pl.col("DOT_NUMBER").is_not_null() & pl.col("when").is_not_null())

    # --- effective: suspended for insurance, on or before the snapshot --------
    # Scoped to (DOT, docket, authority type). A carrier holds several
    # authorities and they are suspended independently: DOT 3212267 had its
    # PROPERTY authority suspended for no insurance on 2026-08-01 while its
    # BROKER authority stayed Active. Keying any of this on DOT alone let the
    # broker authority cancel the property suspension, so a carrier that cannot
    # legally haul rendered Medium/"Active"/"since reinstated" — a false Clean,
    # the dangerous direction.
    scope = ["DOT_NUMBER", "DOCKET_NUMBER", "OP_AUTH_TYPE"]
    effective = (
        ah.filter(
            pl.col("reason").str.contains(INSURANCE_SUSPENSION)
            & pl.col("reason").str.to_lowercase().str.contains(INSURANCE_TOKEN)
            & (pl.col("when") <= pl.lit(snap))
        )
        .group_by(scope)
        .agg(susp_date=pl.col("when").max())
    )

    # --- pending: future-dated involuntary notice -----------------------------
    pending = pl.read_csv(PENDING, infer_schema_length=0, ignore_errors=True).with_columns(
        DOT_NUMBER=pl.col("DOT_NUMBER").cast(pl.Int64, strict=False),
        susp_date=pl.col("effective_date").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
        served=pl.col("serve_date").str.strptime(pl.Date, format="%m/%d/%Y", strict=False),
    ).filter(pl.col("DOT_NUMBER").is_not_null() & pl.col("susp_date").is_not_null())
    pending = pending.group_by("DOT_NUMBER").agg(
        susp_date=pl.col("susp_date").min(),   # soonest = most urgent
        served=pl.col("served").min(),
    )
    log(f"raw: {effective.height:,} effective, {pending.height:,} pending")

    # --- cure: any action that restores the authority ------------------------
    # Keyed on the resulting STATUS, not just the reason text. Enumerating cure
    # reasons missed "Administrative Correction" restorations (128 carriers),
    # and a carrier can be put back to Active under a reason we never listed.
    # Any post-suspension AuthHist row landing on Active is a cure.
    cures = (
        ah.filter(
            pl.col("reason").is_in(CURE)
            | (pl.col("OP_AUTH_STATUS").fill_null("") == "Active")
        )
        .group_by(scope)          # same scope: a broker-authority grant does
        .agg(cured_on=pl.col("when").max())   # not cure a property suspension
    )

    # A DOT that currently holds an Active authority in Motus_Carrier is not
    # suspended, whatever AuthHist's history says — 928 emitted suspensions had
    # the docket marked Active in the current snapshot. Motus_Carrier is the
    # present-state feed; AuthHist is the event log, and the event log alone
    # cannot tell us the authority was never restored.
    active_now = (
        pl.read_csv(MOTUS_CARRIER, infer_schema_length=0, ignore_errors=True)
        .with_columns(DOT_NUMBER=pl.col("USDOT_NUMBER").cast(pl.Int64, strict=False))
        .filter(pl.col("OP_AUTH_STATUS") == "Active")
        .select(scope).unique()   # scoped: only THIS authority being active clears it
    )

    def drop_cured(df: pl.DataFrame, ref: str) -> pl.DataFrame:
        # Join on whatever scope columns BOTH sides carry — the pending sidecar
        # has no OP_AUTH_TYPE — and re-aggregate `cures` to exactly those keys
        # first. Without that the join fans out (cures is one row per authority
        # type, so a docket with several types multiplies the pending rows) and
        # a filter step silently made its input LARGER: 1,723 -> 1,748.
        keys = [k for k in scope if k in df.columns and k in cures.columns]
        c = cures.group_by(keys).agg(cured_on=pl.col("cured_on").max())
        before = df.height
        joined = df.join(c, on=keys, how="left")
        assert joined.height == before, (
            f"cure join fanned out: {before:,} -> {joined.height:,} on {keys}"
        )
        return joined.filter(
            pl.col("cured_on").is_null() | (pl.col("cured_on") < pl.col(ref))
        ).drop("cured_on")

    eff_n, pend_n = effective.height, pending.height
    effective = drop_cured(effective, "susp_date").join(active_now, on=scope, how="anti")
    pending = drop_cured(pending, "served")
    log(f"after cure check: {effective.height:,} effective (-{eff_n - effective.height:,}), "
        f"{pending.height:,} pending (-{pend_n - pending.height:,})")

    # Roll the scoped rows up to one per DOT only now that cures have been
    # applied per authority. Earliest suspension wins (most conservative).
    effective = effective.group_by("DOT_NUMBER").agg(susp_date=pl.col("susp_date").min())

    # effective wins over pending — the authority is already gone
    pending = pending.join(effective.select("DOT_NUMBER"), on="DOT_NUMBER", how="anti")

    combined = pl.concat([
        effective.select("DOT_NUMBER", "susp_date", status=pl.lit("effective")),
        pending.select("DOT_NUMBER", "susp_date", status=pl.lit("pending")),
    ], how="vertical_relaxed").with_columns(
        insurance_suspension_status=pl.col("status"),
        insurance_suspension_date=pl.col("susp_date").dt.strftime("%Y-%m-%d"),
        insurance_suspension_days=(pl.col("susp_date") - pl.lit(snap)).dt.total_days().cast(pl.Int64),
    ).select("DOT_NUMBER", "insurance_suspension_status",
             "insurance_suspension_date", "insurance_suspension_days")

    pq = pl.read_parquet(PARQUET)
    for c in ("insurance_suspension_status", "insurance_suspension_date", "insurance_suspension_days"):
        if c in pq.columns:
            pq = pq.drop(c)
    out = pq.join(combined, on="DOT_NUMBER", how="left")
    out.write_parquet(PARQUET)

    active = out.filter(
        pl.col("insurance_suspension_status").is_not_null() & (pl.col("status_code") == "A")
    )
    log(f"flagged {combined.height:,} carriers "
        f"({combined.filter(pl.col('insurance_suspension_status') == 'effective').height:,} effective, "
        f"{combined.filter(pl.col('insurance_suspension_status') == 'pending').height:,} pending); "
        f"{active.height:,} of them still census-active")
    log(f"wrote {PARQUET}")


if __name__ == "__main__":
    main()
