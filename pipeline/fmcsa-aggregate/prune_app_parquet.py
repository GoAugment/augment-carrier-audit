# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0"]
# ///
"""Prune the canonical aggregate parquet to the app-facing column contract.

The pipeline needs extra intermediate columns while building thresholds and
sidecar risk tables, but the checked-in app parquet should only contain columns
selected by lib/fmcsa-parquet.ts. This keeps the published artifact smaller and
prevents drift between "generated" and "actually used" data.
"""
from __future__ import annotations

import os
import re
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[2]
PARQUET = Path(os.environ.get("FMCSA_PARQUET", ROOT / "data" / "carrier_aggregates.parquet"))
ADAPTER = Path(os.environ.get("FMCSA_PARQUET_ADAPTER", ROOT / "lib" / "fmcsa-parquet.ts"))


def app_columns() -> list[str]:
    source = ADAPTER.read_text()

    # The carrier projection lives in the `CARRIER_SELECT_COLUMNS` template
    # literal (interpolated into the fetch query as `SELECT ${...} FROM
    # read_parquet`). Parse that const directly — regexing the SELECT site
    # only captures the unexpanded `${CARRIER_SELECT_COLUMNS}` (or, worse, a
    # neighbouring query), which silently drops columns including the
    # DOT_NUMBER primary key.
    const = re.search(
        r"CARRIER_SELECT_COLUMNS\s*=\s*`([\s\S]*?)`", source
    )
    if const:
        body = const.group(1)
    else:
        # Fallback: largest literal SELECT ... FROM read_parquet projection.
        matches = re.findall(r"SELECT\s+([\s\S]*?)\s+FROM read_parquet", source)
        if not matches:
            raise RuntimeError(f"No CARRIER_SELECT_COLUMNS or SELECT block in {ADAPTER}")
        body = max(matches, key=len)

    body = re.sub(r"--.*$", "", body, flags=re.MULTILINE)
    cols = []
    for part in body.split(","):
        col = part.strip()
        if re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", col) and col not in cols:
            cols.append(col)
    if not cols:
        raise RuntimeError(f"No projected columns parsed from {ADAPTER}")
    # The DOT_NUMBER key is mandatory — the app filters/joins on it. Guard against
    # ever pruning it out (a missing key silently breaks every parquet lookup).
    if "DOT_NUMBER" not in cols:
        raise RuntimeError(
            f"Parsed app columns from {ADAPTER} but DOT_NUMBER is absent — refusing "
            f"to prune away the primary key. Parsed {len(cols)} cols starting "
            f"{cols[:3]}."
        )
    return cols


def main() -> None:
    cols = app_columns()
    schema = pl.scan_parquet(PARQUET).collect_schema()
    missing = [c for c in cols if c not in schema]
    if missing:
        raise RuntimeError(f"{PARQUET} is missing app columns: {', '.join(missing)}")

    before_cols = len(schema)
    before_size = PARQUET.stat().st_size
    tmp = PARQUET.with_suffix(".pruned.tmp.parquet")
    df = pl.read_parquet(PARQUET, columns=cols)
    df.write_parquet(tmp, compression="zstd")
    tmp.replace(PARQUET)

    after_size = PARQUET.stat().st_size
    print(
        "[prune_app_parquet] "
        f"rows={df.height:,} columns={before_cols}->{len(cols)} "
        f"size={before_size / 1e6:.1f}MB->{after_size / 1e6:.1f}MB "
        f"-> {PARQUET}"
    )


if __name__ == "__main__":
    main()
