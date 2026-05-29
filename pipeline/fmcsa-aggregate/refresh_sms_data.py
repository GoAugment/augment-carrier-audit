# /// script
# requires-python = ">=3.11"
# dependencies = ["httpx>=0.27"]
# ///
"""Download fresh FMCSA SMS bulk files from the Socrata API (data.transportation.gov).

Uses the bulk CSV export endpoint (…/api/views/{id}/rows.csv?accessType=DOWNLOAD),
which streams the FULL dataset with the original Title_Case headers — schema-
compatible with the manual SMS_Input_* downloads the pipeline already reads.

Writes to data/sources/refresh_<YYYYMMDD>/ with fixed filenames. Does NOT touch
the current parquet or the existing Downloads files — this only fetches raw data
so a candidate parquet can be built and validated before any promotion.

Creds: SOCRATA_API_KEY / SOCRATA_API_SECRET from the app's .env.local (basic auth;
raises rate limits / avoids throttling on large exports).
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path

import httpx

ENV = Path("/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/.env.local")
OUT_ROOT = Path("/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/sources")
BASE = "https://data.transportation.gov/api/views/{id}/rows.csv"

# Socrata dataset id -> output filename (matches what the pipeline expects).
DATASETS = {
    "rbkj-cgst": "SMS_Input_-_Inspection.csv",
    "8mt8-2mdr": "SMS_Input_-_Violation.csv",
    "4wxs-vbns": "SMS_Input_-_Crash.csv",
    "kjg3-diqy": "SMS_Input_-_Motor_Carrier_Census_Information.csv",
    "az4n-8mr2": "Company_Census_File.csv",
}
# NOTE: insurance history (inshist_allwithhistory.txt) is a separate L&I feed,
# not in these SMS datasets — refresh it separately if/when needed.


def load_auth():
    env = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r'\s*([A-Z_]+)\s*=\s*"?([^"\n]+)"?', line)
        if m:
            env[m.group(1)] = m.group(2)
    return (env.get("SOCRATA_API_KEY"), env.get("SOCRATA_API_SECRET"))


def main() -> None:
    auth = load_auth()
    tag = time.strftime("%Y%m%d")
    out_dir = OUT_ROOT / f"refresh_{tag}"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[refresh] downloading {len(DATASETS)} datasets → {out_dir}", flush=True)

    with httpx.Client(follow_redirects=True, timeout=None, auth=auth) as c:
        for did, fname in DATASETS.items():
            dest = out_dir / fname
            t0 = time.monotonic()
            n = 0
            print(f"[refresh] {fname} ({did}) …", flush=True)
            with c.stream("GET", BASE.format(id=did), params={"accessType": "DOWNLOAD"}) as r:
                if r.status_code != 200:
                    print(f"[refresh]   ✗ HTTP {r.status_code} — skipping", flush=True)
                    continue
                with open(dest, "wb") as f:
                    for chunk in r.iter_bytes(chunk_size=1 << 20):
                        f.write(chunk)
                        n += len(chunk)
            mb = n / 1e6
            print(f"[refresh]   ✓ {mb:,.0f} MB in {(time.monotonic()-t0)/60:.1f}m → {dest.name}", flush=True)

    # tiny manifest so the build step + validation know what to read
    (out_dir / "MANIFEST.txt").write_text(
        f"refreshed_at={time.strftime('%Y-%m-%dT%H:%M:%S')}\n"
        + "\n".join(f"{did}\t{fname}" for did, fname in DATASETS.items()) + "\n"
    )
    print(f"[refresh] DONE → {out_dir}", flush=True)


if __name__ == "__main__":
    main()
