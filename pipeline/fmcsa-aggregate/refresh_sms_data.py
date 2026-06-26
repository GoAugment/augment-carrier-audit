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

Robustness (these files are 1-6M rows / multi-GB and the connection drops):
  * Each file streams to a <name>.part, then atomically renames to the final
    name only after the FULL stream is received — a final file is therefore
    always complete.
  * The expected row count is fetched from Socrata's count endpoint up front.
    A file already on disk whose data-line count == expected is SKIPPED (resume).
    Anything short / truncated is re-downloaded.
  * Each download retries on transport errors (RemoteProtocolError, timeouts,
    incomplete chunked reads) with exponential backoff. The post-download
    line-count is verified against the expected count; a short file fails the
    attempt and retries.

Creds: SOCRATA_API_KEY / SOCRATA_API_SECRET from the app's .env.local (basic auth;
raises rate limits / avoids throttling on large exports).
"""
from __future__ import annotations

import os
import re
import sys
import time
from pathlib import Path

import httpx

ENV = Path("/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/.env.local")
OUT_ROOT = Path("/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/data/sources")
EXPORT = "https://data.transportation.gov/api/views/{id}/rows.csv"
COUNT = "https://data.transportation.gov/resource/{id}.json"
RESOURCE = "https://data.transportation.gov/resource/{id}.csv"

# Datasets whose single-shot bulk export is too large to stream reliably (the
# connection drops mid-stream). These are fetched via paginated SODA chunks
# instead — a drop only costs one cheap chunk. The SODA values are byte-identical
# to the export (same date formats, same :id order); only the header differs
# (quoted/lowercase), so we reuse the export header verbatim to preserve casing.
PAGINATED = {
    "az4n-8mr2",  # Company_Census_File.csv (~4.4M rows / 1.5 GB)
    "6sqe-dvqs",  # inshist_allwithhistory.csv (~7.4M rows / 1.3 GB)
    "aayw-vxb3",  # Crash_File.csv (~5M rows / 1.85 GB)
}
PAGE_SIZE = 250_000

# Socrata dataset id -> output filename (matches what the pipeline expects).
#
# Two cadences (see --daily / --monthly):
#   MONTHLY — FMCSA reruns the SMS snapshot ~monthly; pulling more often just
#             re-downloads identical data.
#   DAILY   — L&I insurance changes daily and drives the most time-sensitive
#             verdicts (imminent BIPD lapse, $0-on-file). Small files, so a
#             daily pull is cheap. The lapse signal is only meaningful on fresh
#             data — a carrier "12 days from lapse" today is "$0" next week.
MONTHLY = {
    "rbkj-cgst": "SMS_Input_-_Inspection.csv",
    "8mt8-2mdr": "SMS_Input_-_Violation.csv",
    "4wxs-vbns": "SMS_Input_-_Crash.csv",
    "kjg3-diqy": "SMS_Input_-_Motor_Carrier_Census_Information.csv",
    "az4n-8mr2": "Company_Census_File.csv",
    # InsHist - All With History (insurance policy lifecycle: cancel / replace /
    # name-change / transfer). The Socrata export has the SAME 17-column layout,
    # in the same order, as FMCSA's native header-less `inshist_allwithhistory.txt`
    # — only difference is a header row (add_inshist.py sniffs + skips it) and a
    # zero-padded DOT (cast handles it). ~7.4M rows / ~1.3 GB, so it pages.
    # Replaces the old manual L&I Data-Dissemination browser download.
    "6sqe-dvqs": "inshist_allwithhistory.csv",
    # Carrier - All With History: operating authority + BIPD/cargo/bond
    # insurance flags + business/mailing address. 43-col export matches
    # build_aggregates.py's reader exactly. ~335 MB. (Old README id n76j-r3iz
    # is dead; this is the live one, updated daily.)
    "6eyk-hxee": "Carrier_All_With_History.csv",
    # Revocation - All With History: authority revocations (voluntary +
    # involuntary). 6-col export matches add_revocations.py. ~120 MB. (Old
    # README id 2eyu-5pc4 is dead.)
    "sa6p-acbp": "Revocation_-_All_With_History.csv",
    # SMS AB PassProperty: FMCSA's pre-computed BASIC measures + alert flags for
    # A/B-eligible Property carriers. Socrata mirror of the SMS Tools download —
    # 21-col export matches build_aggregates.py's reader exactly. ~65 MB.
    "4y6x-dmck": "SMS_AB_PassProperty.csv",
    # Crash File: raw MCMIS state crash reports (59 cols, UPPER_CASE headers —
    # DOT_NUMBER, REPORT_DATE, FATALITIES, INJURIES, TOW_AWAY, HAZMAT_RELEASED).
    # build_aggregates.py reads this as CRASH_PATH for 24-mo crash counts /
    # crashes-per-million. ~5M rows / ~1.85 GB, so it pages. (Was a manual
    # ~/Downloads file before; the README's "do not use" note is wrong.)
    "aayw-vxb3": "Crash_File.csv",
}
DAILY = {
    # ActPendInsur — Active & Pending Insurance, All With History. Exact schema
    # match to the manual L&I file (DOT_NUMBER … effective_date,
    # cancl_effective_date), ~468k rows / ~50 MB. Carries the cancellation dates
    # the imminent-lapse rule needs.
    "qh9u-swkp": "ActPendInsur_All_With_History.csv",
}
DATASETS = {**MONTHLY, **DAILY}
# NOTE: the full insurance *event* history now comes from the Socrata InsHist
# mirror (6sqe-dvqs, in MONTHLY above) — no more manual L&I download. ActPendInsur
# (DAILY) still carries the pending-cancellation dates daily lapse detection needs;
# inshist only feeds the slower-moving chameleon cancel/replace-history signals.

MAX_ATTEMPTS = 6


def load_auth():
    env = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r'\s*([A-Z_]+)\s*=\s*"?([^"\n]+)"?', line)
        if m:
            env[m.group(1)] = m.group(2)
    return (env.get("SOCRATA_API_KEY"), env.get("SOCRATA_API_SECRET"))


def expected_count(c: httpx.Client, did: str) -> int | None:
    """Authoritative row count straight from Socrata's SODA count endpoint."""
    try:
        r = c.get(COUNT.format(id=did), params={"$select": "count(*)"}, timeout=60)
        r.raise_for_status()
        return int(list(r.json()[0].values())[0])
    except Exception as e:  # noqa: BLE001
        print(f"[refresh]   ! count lookup failed ({e}) — skipping completeness check", flush=True)
        return None


def data_lines(path: Path) -> int:
    """Count data rows (lines minus the header). These datasets have no embedded
    newlines, so line count == row count (verified against Socrata exact counts)."""
    n = 0
    with open(path, "rb") as f:
        for _ in f:
            n += 1
    return max(0, n - 1)


def export_header(c: httpx.Client, did: str) -> str:
    """Grab just the first line of the bulk export — its original Title_Case
    (incl. quirks like `HM_Ind`). Only needs the first few KB, so it's reliable
    even when the full stream drops. Falls back to an existing file's header."""
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            with c.stream("GET", EXPORT.format(id=did), params={"accessType": "DOWNLOAD"}) as r:
                r.raise_for_status()
                buf = b""
                for chunk in r.iter_bytes(chunk_size=1 << 14):
                    buf += chunk
                    if b"\n" in buf:
                        return buf.split(b"\n", 1)[0].decode("utf-8-sig").rstrip("\r")
                return buf.decode("utf-8-sig").rstrip("\r")
        except (httpx.HTTPError, httpx.StreamError) as e:
            print(f"[refresh]   … header attempt {attempt} failed ({type(e).__name__}); retry", flush=True)
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"could not fetch export header for {did}")


def download_paginated(c: httpx.Client, did: str, dest: Path, expected: int | None) -> bool:
    """Fetch a large dataset in PAGE_SIZE chunks via the SODA resource endpoint,
    ordered by :id for stable paging. Writes the export header verbatim, then the
    data rows from each chunk (skipping each chunk's own header). Per-chunk retry."""
    part = dest.with_suffix(dest.suffix + ".part")
    try:
        header = export_header(c, did)
    except RuntimeError:
        if dest.exists():
            header = dest.read_text().split("\n", 1)[0]
            print(f"[refresh]   (reusing existing header for {dest.name})", flush=True)
        else:
            return False
    t0 = time.monotonic()
    offset, total = 0, 0
    with open(part, "w", encoding="utf-8") as f:
        f.write(header + "\n")
        while True:
            chunk_ok = False
            for attempt in range(1, MAX_ATTEMPTS + 1):
                try:
                    resp = c.get(
                        RESOURCE.format(id=did),
                        params={"$order": ":id", "$limit": PAGE_SIZE, "$offset": offset},
                        timeout=httpx.Timeout(60.0, read=300.0),
                    )
                    resp.raise_for_status()
                    text = resp.text
                    lines = text.split("\n")
                    # drop the chunk's quoted/lowercase header line + trailing blank
                    body = [ln for ln in lines[1:] if ln != ""]
                    if body:
                        f.write("\n".join(body) + "\n")
                    n = len(body)
                    total += n
                    chunk_ok = True
                    print(f"[refresh]   … offset {offset:,} (+{n:,} rows, {total:,} total)", flush=True)
                    break
                except (httpx.HTTPError, httpx.StreamError) as e:
                    wait = min(60, 2 ** attempt)
                    print(f"[refresh]   … chunk @ {offset:,} attempt {attempt} failed ({type(e).__name__}); retry in {wait}s", flush=True)
                    time.sleep(wait)
            if not chunk_ok:
                print(f"[refresh]   ✗ GAVE UP on chunk @ {offset:,}", flush=True)
                return False
            if n < PAGE_SIZE:
                break
            offset += PAGE_SIZE
    got = data_lines(part)
    if expected is not None and got < expected:
        print(f"[refresh]   ✗ short after paging: {got:,} < expected {expected:,}", flush=True)
        return False
    part.replace(dest)
    print(f"[refresh]   ✓ {got:,} rows in {(time.monotonic()-t0)/60:.1f}m (paged) → {dest.name}", flush=True)
    return True


def download_one(c: httpx.Client, did: str, dest: Path, expected: int | None) -> bool:
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, MAX_ATTEMPTS + 1):
        t0 = time.monotonic()
        n = 0
        try:
            with c.stream("GET", EXPORT.format(id=did), params={"accessType": "DOWNLOAD"}) as r:
                if r.status_code != 200:
                    print(f"[refresh]   ✗ HTTP {r.status_code} (attempt {attempt})", flush=True)
                    raise httpx.HTTPError(f"status {r.status_code}")
                with open(part, "wb") as f:
                    for chunk in r.iter_bytes(chunk_size=1 << 20):
                        f.write(chunk)
                        n += len(chunk)
            # Verify completeness by row count before promoting the .part file.
            got = data_lines(part)
            if expected is not None and got < expected:
                raise httpx.RemoteProtocolError(
                    f"short file: {got:,} rows < expected {expected:,}"
                )
            part.replace(dest)
            mb = n / 1e6
            tag = "" if expected is None else f" ({got:,} rows ✓)"
            print(f"[refresh]   ✓ {mb:,.0f} MB in {(time.monotonic()-t0)/60:.1f}m{tag} → {dest.name}", flush=True)
            return True
        except (httpx.HTTPError, httpx.StreamError, OSError) as e:
            wait = min(60, 2 ** attempt)
            print(
                f"[refresh]   … attempt {attempt}/{MAX_ATTEMPTS} failed after "
                f"{n/1e6:,.0f} MB ({type(e).__name__}: {e}); retrying in {wait}s",
                flush=True,
            )
            time.sleep(wait)
    print(f"[refresh]   ✗ GAVE UP on {dest.name} after {MAX_ATTEMPTS} attempts", flush=True)
    return False


def main() -> None:
    args = sys.argv[1:]
    # Cadence selection: --daily (insurance only), --monthly (SMS only), or
    # default (all). Any remaining args are treated as filename filters.
    if "--daily" in args:
        selected = DAILY
        args = [a for a in args if a != "--daily"]
    elif "--monthly" in args:
        selected = MONTHLY
        args = [a for a in args if a != "--monthly"]
    else:
        selected = DATASETS
    only = set(args)  # optional: restrict to specific filenames

    auth = load_auth()
    tag = time.strftime("%Y%m%d")
    out_dir = OUT_ROOT / f"refresh_{tag}"
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"[refresh] target {out_dir} ({len(selected)} dataset(s); only={sorted(only) or 'ALL'})", flush=True)

    ok = True
    # Long timeout for the read; the retry loop handles drops.
    with httpx.Client(follow_redirects=True, timeout=httpx.Timeout(60.0, read=600.0), auth=auth) as c:
        for did, fname in selected.items():
            if only and fname not in only:
                continue
            dest = out_dir / fname
            exp = expected_count(c, did)
            if dest.exists():
                have = data_lines(dest)
                if exp is not None and have >= exp:
                    print(f"[refresh] {fname}: already complete ({have:,} rows) — skip", flush=True)
                    continue
                print(f"[refresh] {fname}: on disk {have:,} < expected {exp:,} — re-download", flush=True)
            print(f"[refresh] {fname} ({did}) expected {exp:,} rows …", flush=True)
            fetch = download_paginated if did in PAGINATED else download_one
            ok = fetch(c, did, dest, exp) and ok

    (out_dir / "MANIFEST.txt").write_text(
        f"refreshed_at={time.strftime('%Y-%m-%dT%H:%M:%S')}\n"
        + "\n".join(f"{did}\t{fname}" for did, fname in DATASETS.items()) + "\n"
    )
    print(f"[refresh] {'DONE' if ok else 'INCOMPLETE'} → {out_dir}", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
