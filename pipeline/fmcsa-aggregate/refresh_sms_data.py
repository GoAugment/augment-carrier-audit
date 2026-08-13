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

import concurrent.futures as cf
import os
import re
import sys
import time
from pathlib import Path

import httpx

REPO = Path(__file__).resolve().parents[2]
ENV = Path(os.environ.get("FMCSA_ENV_FILE", REPO / ".env.local"))
OUT_ROOT = Path(os.environ.get("FMCSA_SOURCES_DIR", REPO / "data" / "sources"))
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
# MOTUS — the live replacement for the retired L&I feeds.
#
# FMCSA cut over from Licensing & Insurance to "Motus" on 2026-05-14 and RETIRED
# the four L&I datasets above that day. Their Socrata descriptions say it
# outright: "This dataset was last refreshed on 05/14/2026 and will no longer be
# updated." Socrata's rowsUpdatedAt keeps advancing because FMCSA re-uploads the
# frozen file daily, which is why it went unnoticed — verified 2026-08-12 by
# diffing Carrier-All-With-History across 47 days: 0 authority-status changes in
# 1,860,604 rows.
#
# Motus only accumulates from the cutover, so these are SMALL (~100k rows each,
# a few MB) and every signal must UNION old (<=2026-05-14) + Motus (>2026-05-14).
# merge_motus.py does that and re-emits the old schemas so downstream steps are
# untouched. Because they're tiny, these can be pulled daily for pennies.
MOTUS = {
    "wb4f-neki": "Motus_RevokeSuspend_All_With_History.csv",
    "c5y8-a4uz": "Motus_Insur_All_With_History.csv",
    "inys-ebih": "Motus_Carrier_All_With_History.csv",
    "yu5v-wbh6": "Motus_AuthHist_All_With_History.csv",
}
DAILY = {
    # ActPendInsur — RETIRED 2026-05-14, frozen. Kept because it still carries
    # every pending cancellation up to the cutover; Motus_Insur supplies
    # everything after. See MOTUS above.
    "qh9u-swkp": "ActPendInsur_All_With_History.csv",
    **MOTUS,
}
DATASETS = {**MONTHLY, **DAILY}
# NOTE: the full insurance *event* history now comes from the Socrata InsHist
# mirror (6sqe-dvqs, in MONTHLY above) — no more manual L&I download. ActPendInsur
# (DAILY) still carries the pending-cancellation dates daily lapse detection needs;
# inshist only feeds the slower-moving chameleon cancel/replace-history signals.

MAX_ATTEMPTS = 6

# Socrata throttles each connection to roughly 1.5 MB/s regardless of file size,
# so the 2026-08 sequential run spent 81 min of its 85 min total just streaming
# (Company Census 19.5m, Crash 15.6m, Inspection 11.9m, Violation 11.6m, MC
# Census 11.6m, inshist 6.8m, rest ~4m). Downloading concurrently puts the floor
# at the single slowest file (~20m). 4 workers is deliberately modest: the win is
# already bounded by that slowest file, and piling on more parallel streams of a
# multi-GB export is how you get throttled into the retry path.
DEFAULT_JOBS = 4


def log(tag: str, msg: str) -> None:
    """Per-file prefix — downloads interleave once they run concurrently."""
    print(f"[refresh] {tag}: {msg}", flush=True)


def load_auth():
    env = {}
    for line in ENV.read_text().splitlines():
        m = re.match(r'\s*([A-Z_]+)\s*=\s*"?([^"\n]+)"?', line)
        if m:
            env[m.group(1)] = m.group(2)
    return (env.get("SOCRATA_API_KEY"), env.get("SOCRATA_API_SECRET"))


def expected_count(c: httpx.Client, did: str, tag: str = "?") -> int | None:
    """Authoritative row count straight from Socrata's SODA count endpoint."""
    try:
        r = c.get(COUNT.format(id=did), params={"$select": "count(*)"}, timeout=60)
        r.raise_for_status()
        return int(list(r.json()[0].values())[0])
    except Exception as e:  # noqa: BLE001
        log(tag, f"! count lookup failed ({e}) — skipping completeness check")
        return None


def data_lines(path: Path) -> int:
    """Count data rows (lines minus the header). These datasets have no embedded
    newlines, so line count == row count (verified against Socrata exact counts)."""
    n = 0
    with open(path, "rb") as f:
        for _ in f:
            n += 1
    return max(0, n - 1)


def export_header(c: httpx.Client, did: str, tag: str = "?") -> str:
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
            log(tag, f"… header attempt {attempt} failed ({type(e).__name__}); retry")
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"could not fetch export header for {did}")


def download_paginated(c: httpx.Client, did: str, dest: Path, expected: int | None) -> bool:
    tag = dest.name
    """Fetch a large dataset in PAGE_SIZE chunks via the SODA resource endpoint,
    ordered by :id for stable paging. Writes the export header verbatim, then the
    data rows from each chunk (skipping each chunk's own header). Per-chunk retry."""
    part = dest.with_suffix(dest.suffix + ".part")
    try:
        header = export_header(c, did, tag)
    except RuntimeError:
        if dest.exists():
            header = dest.read_text().split("\n", 1)[0]
            log(tag, "(reusing existing header)")
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
                    log(tag, f"… offset {offset:,} (+{n:,} rows, {total:,} total)")
                    break
                except (httpx.HTTPError, httpx.StreamError) as e:
                    wait = min(60, 2 ** attempt)
                    log(tag, f"… chunk @ {offset:,} attempt {attempt} failed ({type(e).__name__}); retry in {wait}s")
                    time.sleep(wait)
            if not chunk_ok:
                log(tag, f"✗ GAVE UP on chunk @ {offset:,}")
                return False
            if n < PAGE_SIZE:
                break
            offset += PAGE_SIZE
    got = data_lines(part)
    if expected is not None and got < expected:
        log(tag, f"✗ short after paging: {got:,} < expected {expected:,}")
        return False
    part.replace(dest)
    log(tag, f"✓ {got:,} rows in {(time.monotonic()-t0)/60:.1f}m (paged)")
    return True


def download_one(c: httpx.Client, did: str, dest: Path, expected: int | None) -> bool:
    tag = dest.name
    part = dest.with_suffix(dest.suffix + ".part")
    for attempt in range(1, MAX_ATTEMPTS + 1):
        t0 = time.monotonic()
        n = 0
        try:
            with c.stream("GET", EXPORT.format(id=did), params={"accessType": "DOWNLOAD"}) as r:
                if r.status_code != 200:
                    log(tag, f"✗ HTTP {r.status_code} (attempt {attempt})")
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
            # Guard against promoting a non-CSV body. When the count lookup
            # fails, `expected` is None and the row-count check above is skipped
            # entirely — so without this an HTML error/challenge page served
            # with HTTP 200 became the final .csv and the run exited 0.
            with open(part, "rb") as _fh:
                head = _fh.read(2048).lstrip()
            if head[:1] == b"<" or b"<html" in head[:512].lower():
                raise httpx.RemoteProtocolError("server returned HTML, not CSV")
            if expected is None and b"," not in head.split(b"\n", 1)[0]:
                raise httpx.RemoteProtocolError("first line is not a CSV header")
            part.replace(dest)
            mb = n / 1e6
            rows_tag = "" if expected is None else f" ({got:,} rows ✓)"
            log(tag, f"✓ {mb:,.0f} MB in {(time.monotonic()-t0)/60:.1f}m{rows_tag}")
            return True
        except (httpx.HTTPError, httpx.StreamError, OSError) as e:
            wait = min(60, 2 ** attempt)
            log(tag, f"… attempt {attempt}/{MAX_ATTEMPTS} failed after {n/1e6:,.0f} MB ({type(e).__name__}: {e}); retrying in {wait}s")
            time.sleep(wait)
    log(tag, f"✗ GAVE UP after {MAX_ATTEMPTS} attempts")
    return False


def _client(auth) -> httpx.Client:
    """One client per worker. Long read timeout; the retry loops handle drops."""
    return httpx.Client(follow_redirects=True, timeout=httpx.Timeout(60.0, read=600.0), auth=auth)


def fetch_dataset(did: str, fname: str, out_dir: Path, auth, expected: int | None) -> bool:
    """Resume-check then download one dataset. Runs on a worker thread."""
    dest = out_dir / fname
    if dest.exists():
        have = data_lines(dest)
        if expected is not None and have >= expected:
            log(fname, f"already complete ({have:,} rows) — skip")
            return True
        log(fname, f"on disk {have:,} < expected {expected:,} — re-download"
            if expected is not None
            # expected is None when the count lookup failed; the old f-string
            # raised TypeError here, the worker was marked failed, and the file
            # was never re-downloaded.
            else f"on disk {have:,}, expected count unknown — re-download")
    log(fname, f"({did}) expected {expected:,} rows …" if expected is not None
        else f"({did}) starting (row count unknown) …")
    fetch = download_paginated if did in PAGINATED else download_one
    with _client(auth) as c:
        return fetch(c, did, dest, expected)


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
    jobs = DEFAULT_JOBS
    for a in list(args):
        if a.startswith("--jobs="):
            jobs = max(1, int(a.split("=", 1)[1]))
            args.remove(a)
        elif a == "--jobs":  # space form; without this it fell through to
            i = args.index(a)  # `only` and silently downloaded NOTHING, exit 0
            if i + 1 < len(args) and args[i + 1].isdigit():
                jobs = max(1, int(args[i + 1]))
                del args[i:i + 2]
            else:
                sys.exit("[refresh] --jobs needs a number, e.g. --jobs 4")
    # Anything left must be a known filename; a typo used to mean "download
    # nothing" and still exit 0.
    known = set(DATASETS.values())
    for a in args:
        if a.startswith("-") or a not in known:
            sys.exit(f"[refresh] unrecognised argument {a!r} (expected a dataset filename)")
    only = set(args)  # optional: restrict to specific filenames

    auth = load_auth()
    stamp = time.strftime("%Y%m%d")
    out_dir = OUT_ROOT / f"refresh_{stamp}"
    out_dir.mkdir(parents=True, exist_ok=True)
    todo = [(did, f) for did, f in selected.items() if not only or f in only]
    print(f"[refresh] target {out_dir} ({len(todo)} dataset(s); only={sorted(only) or 'ALL'}; jobs={jobs})", flush=True)

    t0 = time.monotonic()
    # Row counts up front, on one shared client: they're ~10 cheap requests and
    # they let us dispatch biggest-first, which is what keeps the tail short.
    # (Rows are only a proxy for bytes — inshist has the most rows but is far
    # from the slowest — but with the makespan floored by the largest file
    # anyway, a rough ordering is enough.)
    with _client(auth) as c:
        counts = {did: expected_count(c, did, fname) for did, fname in todo}
    todo.sort(key=lambda t: counts.get(t[0]) or 0, reverse=True)

    ok = True
    with cf.ThreadPoolExecutor(max_workers=jobs) as ex:
        futures = {
            ex.submit(fetch_dataset, did, fname, out_dir, auth, counts.get(did)): fname
            for did, fname in todo
        }
        for fut in cf.as_completed(futures):
            fname = futures[fut]
            try:
                ok = fut.result() and ok
            except Exception as e:  # noqa: BLE001 — one bad file shouldn't kill the run
                log(fname, f"✗ FAILED with {type(e).__name__}: {e}")
                ok = False
    print(f"[refresh] all downloads finished in {(time.monotonic()-t0)/60:.1f}m", flush=True)

    # Record what this run actually produced, not the full catalogue — the old
    # version listed every dataset even when one file was selected or a download
    # failed, so the manifest asserted a completeness that wasn't there.
    (out_dir / "MANIFEST.txt").write_text(
        f"refreshed_at={time.strftime('%Y-%m-%dT%H:%M:%S')}\n"
        f"status={'complete' if ok else 'INCOMPLETE'}\n"
        + "\n".join(
            f"{did}\t{fname}\t{'ok' if (out_dir / fname).exists() else 'MISSING'}"
            for did, fname in todo
        ) + "\n"
    )
    print(f"[refresh] {'DONE' if ok else 'INCOMPLETE'} → {out_dir}", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
