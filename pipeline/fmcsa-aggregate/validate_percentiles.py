# /// script
# requires-python = ">=3.11"
# dependencies = ["polars>=1.0", "httpx>=0.27"]
# ///
"""Validate our COMPUTED BASIC percentiles against FMCSA's PUBLISHED percentiles.

FMCSA publishes the percentile for the 5 public BASICs on each carrier's SMS
BASIC page as `measure="X" data-percentile="Y"`. We recompute the percentile
ourselves in compute_basics.py (rank measure within Safety Event Group). This
script fetches the published values for a sample of carriers and compares.

Public BASIC pages (proxy-free): /SMS/Carrier/{DOT}/BASIC/{name}.aspx
Crash Indicator is NOT public, so it can't be validated this way.
"""
from __future__ import annotations

import re
import time
import polars as pl
import httpx

PARQUET = "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/carrier_aggregates.parquet"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"

# FAST Act public BASICs → (URL name, our percentile column)
BASICS = {
    "UnsafeDriving": "unsafe_driving_percentile",
    "HOSCompliance": "hos_percentile",
    "VehicleMaint": "vehicle_maintenance_percentile",
}

# Sample spanning the range: megafleets, mid, and FAST-Act-high-risk carriers.
DOTS = [53467, 80806, 264184, 511412, 4321756, 4220658, 4411545,
        4238066, 3532165, 4324192, 3946630, 934008, 2483711, 3417507, 1162977]

MEAS_RE = re.compile(r'measure="([\d.]+)"\s+data-percentile="(\d+)"')


def fetch_published(client: httpx.Client, dot: int, basic: str):
    url = f"https://ai.fmcsa.dot.gov/SMS/Carrier/{dot}/BASIC/{basic}.aspx"
    try:
        r = client.get(url, timeout=30)
        if r.status_code != 200:
            return None, None, f"http{r.status_code}"
        m = MEAS_RE.search(r.text)
        if not m:
            return None, None, "no-match"
        return float(m.group(1)), int(m.group(2)), "ok"
    except Exception as e:
        return None, None, f"err:{type(e).__name__}"


def main() -> None:
    df = pl.read_parquet(PARQUET).filter(pl.col("DOT_NUMBER").is_in(DOTS))
    ours = {r["DOT_NUMBER"]: r for r in df.iter_rows(named=True)}

    print(f"{'DOT':>8} {'BASIC':<14} {'pub_meas':>9} {'pub_pct':>8} {'our_pct':>8} {'Δ':>6}")
    print("-" * 60)
    deltas = []
    with httpx.Client(headers={"User-Agent": UA}, follow_redirects=True) as client:
        for dot in DOTS:
            for basic, col in BASICS.items():
                pm, pp, status = fetch_published(client, dot, basic)
                our = ours.get(dot, {}).get(col)
                if status != "ok":
                    print(f"{dot:>8} {basic:<14} {'':>9} {'':>8} {'':>8}  {status}")
                else:
                    our_s = f"{our:.0f}" if our is not None else "null"
                    d = (pp - our) if our is not None else None
                    if d is not None:
                        deltas.append(abs(d))
                    print(f"{dot:>8} {basic:<14} {pm:>9.2f} {pp:>8d} {our_s:>8} "
                          f"{('%+d' % d) if d is not None else '  —':>6}")
                time.sleep(1.3)
    if deltas:
        import statistics
        print("-" * 60)
        print(f"n={len(deltas)}  mean|Δ|={statistics.mean(deltas):.1f}  "
              f"median|Δ|={statistics.median(deltas):.1f}  max|Δ|={max(deltas)}")
        within2 = sum(1 for d in deltas if d <= 2)
        within5 = sum(1 for d in deltas if d <= 5)
        print(f"within 2 pts: {within2}/{len(deltas)} ({100*within2/len(deltas):.0f}%)  "
              f"within 5 pts: {within5}/{len(deltas)} ({100*within5/len(deltas):.0f}%)")


if __name__ == "__main__":
    main()
