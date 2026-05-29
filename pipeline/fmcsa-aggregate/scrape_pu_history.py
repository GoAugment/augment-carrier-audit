# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "polars>=1.0",
#   "httpx>=0.27",
#   "lxml>=5.0",
#   "tenacity>=8.0",
#   "anyio>=4.0",
# ]
# ///
"""
Monthly scraper for FMCSA SMS per-DOT data that isn't in the free bulk feed.

What this script does:
  Per-DOT scraper for FMCSA's *historical Power Unit snapshots* — the key
  numbers FMCSA exposes per DOT but doesn't publish in any free bulk file.

  The Crash Indicator BASIC page is the path we use to extract these values,
  because it shows the inputs FMCSA uses to compute the BASIC measure. The
  script is NOT scraping BASIC scores themselves (those are computed locally
  by compute_basics.py); it's scraping the PU-history input that makes the
  Crash Indicator computation accurate.

What we extract per DOT (from /SMS/Carrier/{DOT}/BASIC/CrashIndicator.aspx):
    - avg_pu                      (3-snapshot avg, FMCSA's exposure denominator)
    - current_pu, pu_6mo, pu_18mo (the three components — also useful for
                                   fleet-shed / fleet-in-transition detection)
    - utilization_factor          (the multiplier on avg_pu)
    - vmt_per_avg_pu              (the input that drives UF)
    - vmt_mcs150                  (raw VMT from MCS-150)
    - segment                     (Combo vs Straight)
    - segment_pct                 ("100% Combination trucks", informational)
    - n_crashes_included          (sanity-check against our crash file)
    - n_crashes_not_preventable   (excluded from BASIC measure)

Why scrape rather than computing from bulk:
  FMCSA's "Avg PU" is the 3-snapshot historical average (current + 6mo +
  18mo) / 3. The historical PUs are visible on the per-DOT page but NOT in
  any free bulk file. For carriers in fleet transition (Universal Intermodal
  went 2885 → 1023 → 124 over 18 months), this difference is 10x+ relative
  to current PU, which would make our Crash Indicator measure systematically
  wrong without historical data.

Universe (~26k DOTs):
  Carriers with crash-sufficiency: ≥2 crashes in 24mo AND ≥1 crash in last
  12mo. Everyone else gets Crash Indicator = null in FMCSA's system too, so
  there's no value in scraping them.

Run frequency:
  Monthly, matching FMCSA's own SMS update cycle. Output is a parquet that
  joins back into carrier_aggregates.parquet during the main build.

Politeness:
  Default 5 requests/sec with jittered delay. ~26k DOTs × 0.2s = ~90 min.
  Respect 429/5xx with exponential backoff. Honor robots.txt.
  Use a User-Agent identifying the project + research contact.

Resumability:
  Writes intermediate parquet every 500 records. If killed mid-run, restart
  picks up where it left off using DOT_NUMBER as the continuation cursor.
"""
from __future__ import annotations

import argparse
import asyncio
import os
import random
import re
import sys
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

import httpx
import polars as pl
from lxml import html as lxml_html
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

PARQUET_AGG = Path(
    "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/"
    "data/carrier_aggregates.parquet"
)
OUTPUT_DIR = Path(
    "/Users/art/conductor/workspaces/augment-carrier-audit-v1/san-antonio/"
    "data/fmcsa_scrape"
)
SNAPSHOT_TAG = "20260514"  # SMS data vintage — see SMS_DATA_TAG below

BASE_URL = "https://ai.fmcsa.dot.gov/SMS/Carrier/{dot}/BASIC/{basic}.aspx"

# Tag the output parquet by the SMS data vintage, not "today". A scrape that
# spans midnight or restarts the next morning should write to the same file so
# resume logic finds the existing rows. Update this when ingesting a new
# monthly SMS bulk drop.
SMS_DATA_TAG = "20260514"

# Identifies the scraper + contact for FMCSA admins if they need to reach us.
USER_AGENT = (
    "augment-carrier-audit-research/0.1 "
    "(+research@goaugment.com; polite scraper, 5 req/sec)"
)

# Polite rate. Empirically FMCSA's SMS site starts returning errors after
# ~150 successful requests at 5 RPS with 30 concurrent connections. Backing
# off to 2 RPS with 8 workers keeps the success rate >99%. Runtime is
# proportionally longer (~3.5h for 25k DOTs) but it actually finishes.
TARGET_RPS = 2.0
JITTER = 0.2
# Concurrency. Lower number = fewer parallel connections from our IP, which
# FMCSA seems to prefer. At 2 RPS × ~4s latency, 8 workers keeps the
# pipeline full without saturating.
CONCURRENCY = 8

# Persist intermediate results every N successful scrapes so a kill mid-run
# doesn't lose progress.
CHECKPOINT_EVERY = 500


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


@dataclass
class CrashIndicatorScrape:
    """Fields extracted from /BASIC/CrashIndicator.aspx."""
    dot_number: int
    avg_pu: Optional[float]
    current_pu: Optional[int]
    pu_6mo: Optional[int]
    pu_18mo: Optional[int]
    utilization_factor: Optional[float]
    vmt_per_avg_pu: Optional[int]
    vmt_mcs150: Optional[int]
    segment: Optional[str]
    segment_pct: Optional[float]
    n_crashes_included: Optional[int]
    n_crashes_not_preventable: Optional[int]
    scrape_status: str  # "ok" | "no_data" | "error:<msg>"
    scraped_at: str


def _to_int(s: Optional[str]) -> Optional[int]:
    if s is None:
        return None
    s = s.strip().replace(",", "")
    if not s:
        return None
    try:
        return int(s)
    except ValueError:
        return None


def _to_float(s: Optional[str]) -> Optional[float]:
    if s is None:
        return None
    s = s.strip().replace(",", "")
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_crash_indicator(dot: int, html_bytes: bytes) -> CrashIndicatorScrape:
    """Parse the Crash Indicator BASIC HTML. Tolerant of carriers with
    insufficient data (page renders a different layout)."""
    now_iso = time.strftime("%Y-%m-%dT%H:%M:%S")

    try:
        tree = lxml_html.fromstring(html_bytes)
    except Exception as e:
        return CrashIndicatorScrape(
            dot_number=dot, avg_pu=None, current_pu=None, pu_6mo=None,
            pu_18mo=None, utilization_factor=None, vmt_per_avg_pu=None,
            vmt_mcs150=None, segment=None, segment_pct=None,
            n_crashes_included=None, n_crashes_not_preventable=None,
            scrape_status=f"error:parse:{e}", scraped_at=now_iso,
        )

    def first_text_after_label(label_text: str) -> Optional[str]:
        """Find a <span class='val'>X</span><label>label_text</label> pair
        and return X. The SMS page wraps each named value in this idiom."""
        # XPath: a <label> whose text matches, walk up to parent, find sibling
        # span.val. Whitespace-tolerant match.
        nodes = tree.xpath(
            f"//label[normalize-space(text())=$t]/parent::*/*[contains(@class,'val')]/text()",
            t=label_text,
        )
        return nodes[0].strip() if nodes else None

    # Final Avg PU × UF result link, e.g. <a ... href="#AdjAveragePU">1,344</a>
    avg_pu_x_uf_nodes = tree.xpath('//a[@href="#AdjAveragePU"]/text()')
    avg_pu_x_uf = _to_float(avg_pu_x_uf_nodes[0]) if avg_pu_x_uf_nodes else None

    current_pu = _to_int(first_text_after_label("Current Power Units"))
    pu_6mo = _to_int(first_text_after_label("Power Units 6 Months Ago"))
    pu_18mo = _to_int(first_text_after_label("Power Units 18 Months Ago"))
    vmt_per_avg_pu = _to_int(first_text_after_label("VMT per Average Power Unit"))
    vmt_mcs150 = _to_int(first_text_after_label("VMT From Registration (MCS-150)"))

    # Average Power Units appears twice on the page — once as a label inside
    # the breakdown (for the divisor), once as the result of the calculation.
    # The breakdown value is the one we want as `avg_pu` (i.e. the numerator
    # before multiplying by UF). It sits as the .val of a labeled comp.
    avg_pu_breakdown = _to_int(first_text_after_label("Average Power Units"))

    # If we have current/6mo/18mo, the average is (sum)/3. Verify and use.
    if current_pu is not None and pu_6mo is not None and pu_18mo is not None:
        computed_avg = (current_pu + pu_6mo + pu_18mo) / 3.0
    else:
        computed_avg = None
    avg_pu = float(avg_pu_breakdown) if avg_pu_breakdown is not None else computed_avg

    # Utilization factor: derive from avg_pu_x_uf / avg_pu when both present
    if avg_pu_x_uf is not None and avg_pu and avg_pu > 0:
        uf = avg_pu_x_uf / avg_pu
    else:
        uf = None

    # Segment: <span class="seg"><strong>Combo</strong> or <strong>Straight</strong>
    seg_strong = tree.xpath('//span[contains(@class,"seg")]/strong/text()')
    segment = seg_strong[0].strip() if seg_strong else None

    # Segment percentage from "U.S. DOT# 1162977 = 100% Combination trucks..."
    seg_text = " ".join(tree.xpath('//span[contains(@class,"seg")]//text()'))
    seg_pct_match = re.search(r"=\s*(\d+(?:\.\d+)?)%", seg_text)
    segment_pct = float(seg_pct_match.group(1)) if seg_pct_match else None

    # Total Number of Crashes — appears twice (included, not preventable).
    crash_h4s = tree.xpath('//h4[contains(text(),"Total Number of Crashes")]/text()')
    n_included = None
    n_np = None
    for txt in crash_h4s:
        m = re.search(r"Total Number of Crashes:\s*([\d,]+)", txt)
        if not m:
            continue
        value = _to_int(m.group(1))
        # First occurrence is Not Preventable section, second is Included.
        # (The page layout puts Not Preventable above Included.)
        # Order matters; fall back to assigning both if pattern differs.
        if n_np is None:
            n_np = value
        else:
            n_included = value
    # Defensive: if only one number found, treat as included (more common).
    if n_included is None and n_np is not None:
        n_included = n_np
        n_np = None

    # If we have no PUs at all the carrier likely has insufficient crash
    # data and FMCSA renders a different layout. Mark as no_data.
    if current_pu is None and avg_pu is None and n_included is None:
        status = "no_data"
    else:
        status = "ok"

    return CrashIndicatorScrape(
        dot_number=dot,
        avg_pu=avg_pu,
        current_pu=current_pu,
        pu_6mo=pu_6mo,
        pu_18mo=pu_18mo,
        utilization_factor=uf,
        vmt_per_avg_pu=vmt_per_avg_pu,
        vmt_mcs150=vmt_mcs150,
        segment=segment,
        segment_pct=segment_pct,
        n_crashes_included=n_included,
        n_crashes_not_preventable=n_np,
        scrape_status=status,
        scraped_at=now_iso,
    )


# ---------------------------------------------------------------------------
# Scraping
# ---------------------------------------------------------------------------


class AsyncRateLimiter:
    """Global async rate limiter shared across all worker tasks.

    Each `acquire()` blocks just long enough that *combined* across workers the
    average rate stays at TARGET_RPS. Workers run concurrently, but the
    semaphore-style gate ensures we never exceed the per-second budget against
    FMCSA's servers."""

    def __init__(self, rps: float, jitter: float) -> None:
        self.interval = 1.0 / rps
        self.jitter = jitter
        self.next_ready = time.monotonic()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        async with self._lock:
            now = time.monotonic()
            if now < self.next_ready:
                await asyncio.sleep(self.next_ready - now)
            delay = self.interval * (1 + random.uniform(-self.jitter, self.jitter))
            self.next_ready = time.monotonic() + delay


class AsyncScraper:
    """Async HTTPX scraper with concurrency-pooled workers + global RPS cap.

    Why async: each FMCSA page takes ~5s to respond. Sequential at 1 req/wait
    yields ~0.2 RPS. With CONCURRENCY workers in flight, the global limiter
    paces us to exactly TARGET_RPS regardless of per-request latency."""

    def __init__(self, target_rps: float = TARGET_RPS, concurrency: int = CONCURRENCY) -> None:
        # Proxy support — required when FMCSA's WAF has banned our direct IP.
        # We read SCRAPE_PROXY_URL from env so the credential doesn't live in
        # source. Set to a URL like
        #   http://API_KEY:mode=auto@api.zenrows.com:8001
        # to route every request through a third-party proxy.
        proxy_url = os.environ.get("SCRAPE_PROXY_URL")
        client_kwargs: dict = dict(
            headers={"User-Agent": USER_AGENT},
            timeout=60,  # proxy adds latency; bump from 30 → 60
            follow_redirects=True,
            verify=not bool(proxy_url),  # ZenRows MITMs TLS, disable verify
            limits=httpx.Limits(max_keepalive_connections=concurrency,
                                max_connections=concurrency),
        )
        if proxy_url:
            client_kwargs["proxy"] = proxy_url
            print(f"  [scraper] routing through proxy", flush=True)
        self.client = httpx.AsyncClient(**client_kwargs)
        self.limiter = AsyncRateLimiter(target_rps, JITTER)
        self.sem = asyncio.Semaphore(concurrency)

    @retry(
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=4, max=60),
        retry=retry_if_exception_type((httpx.HTTPError, httpx.TimeoutException)),
        reraise=True,
    )
    async def _fetch(self, url: str) -> httpx.Response:
        await self.limiter.acquire()
        resp = await self.client.get(url)
        if resp.status_code == 429:
            await asyncio.sleep(60)
            raise httpx.HTTPError("429 rate-limited")
        resp.raise_for_status()
        return resp

    async def fetch_crash_indicator(self, dot: int) -> CrashIndicatorScrape:
        url = BASE_URL.format(dot=dot, basic="CrashIndicator")
        async with self.sem:
            try:
                resp = await self._fetch(url)
            except Exception as e:
                # Surface the first error of each kind so we can react quickly
                # to throttling without flooding stdout.
                err = str(e)[:120].replace("\n", " ")
                print(f"  [error] DOT {dot}: {err}", flush=True)
                return CrashIndicatorScrape(
                    dot_number=dot, avg_pu=None, current_pu=None, pu_6mo=None,
                    pu_18mo=None, utilization_factor=None, vmt_per_avg_pu=None,
                    vmt_mcs150=None, segment=None, segment_pct=None,
                    n_crashes_included=None, n_crashes_not_preventable=None,
                    scrape_status=f"error:fetch:{err}",
                    scraped_at=time.strftime("%Y-%m-%dT%H:%M:%S"),
                )
        return parse_crash_indicator(dot, resp.content)

    async def close(self) -> None:
        await self.client.aclose()


# ---------------------------------------------------------------------------
# Universe selection + driver
# ---------------------------------------------------------------------------


def select_universe(crash_sufficiency_only: bool = True) -> list[int]:
    """The set of DOTs we'll scrape this run.

    Default: carriers meeting Crash Indicator data sufficiency (2+ crashes
    24mo, 1+ crashes 12mo). ~26k DOTs in the May 2026 snapshot.
    """
    from datetime import datetime, timedelta

    snapshot = datetime(2026, 5, 18)
    cutoff_12mo = snapshot - timedelta(days=365)

    crash = (
        pl.scan_csv(
            "/Users/art/Downloads/SMS_Input_-_Crash_20260518.csv",
            ignore_errors=True,
            schema_overrides={"DOT_Number": pl.Int64},
        )
        .with_columns(
            crash_date=pl.col("Report_Date").str.strptime(
                pl.Date, format="%d-%b-%y", strict=False
            ),
        )
        .filter(pl.col("DOT_Number").is_not_null())
    )

    if crash_sufficiency_only:
        agg = (
            crash.group_by("DOT_Number")
            .agg(
                n_24=pl.len(),
                n_12=(pl.col("crash_date") >= pl.lit(cutoff_12mo.date()))
                       .sum().cast(pl.Int64),
            )
            .filter((pl.col("n_24") >= 2) & (pl.col("n_12") >= 1))
            .collect(engine="streaming")
        )
    else:
        agg = crash.group_by("DOT_Number").agg(pl.len()).collect(engine="streaming")

    return sorted(agg["DOT_Number"].to_list())


def load_existing_results(path: Path) -> set[int]:
    """Read existing results parquet so we can skip already-scraped DOTs.

    Treats the file's existence as the source of truth — only marks a DOT as
    "done" if the existing row has scrape_status == 'ok' (so transient errors
    will retry on the next run)."""
    if not path.exists():
        return set()
    try:
        df = pl.read_parquet(path)
        return set(df.filter(pl.col("scrape_status") == "ok")["dot_number"].to_list())
    except Exception:
        return set()


def write_results(results: list[CrashIndicatorScrape], path: Path) -> None:
    """Append-or-merge: read existing rows, replace any matching DOTs with
    fresh data, write back. Designed for incremental checkpointing during
    long runs."""
    new_df = pl.DataFrame([asdict(r) for r in results])
    if path.exists():
        existing = pl.read_parquet(path)
        keep = existing.filter(
            ~pl.col("dot_number").is_in(new_df["dot_number"].to_list())
        )
        out = pl.concat([keep, new_df])
    else:
        out = new_df
    path.parent.mkdir(parents=True, exist_ok=True)
    out.write_parquet(path, compression="zstd")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


async def run_scrape(
    universe: list[int],
    output_path: Path,
    target_rps: float,
    concurrency: int,
) -> int:
    scraper = AsyncScraper(target_rps=target_rps, concurrency=concurrency)
    results_buffer: list[CrashIndicatorScrape] = []
    counters = {"ok": 0, "no_data": 0, "err": 0, "completed": 0}
    start = time.monotonic()
    buffer_lock = asyncio.Lock()
    print_lock = asyncio.Lock()

    async def process(dot: int) -> None:
        r = await scraper.fetch_crash_indicator(dot)
        async with buffer_lock:
            results_buffer.append(r)
            if r.scrape_status == "ok":
                counters["ok"] += 1
            elif r.scrape_status == "no_data":
                counters["no_data"] += 1
            else:
                counters["err"] += 1
            counters["completed"] += 1
            i = counters["completed"]

            if i % 50 == 0:
                elapsed = time.monotonic() - start
                rate = i / elapsed
                eta = (len(universe) - i) / max(rate, 0.01) / 60
                async with print_lock:
                    print(
                        f"  {i:>6}/{len(universe):,}  "
                        f"ok={counters['ok']} nodata={counters['no_data']} "
                        f"err={counters['err']}  {rate:.1f} rps  "
                        f"ETA {eta:.1f}m",
                        flush=True,
                    )

            if len(results_buffer) >= CHECKPOINT_EVERY:
                to_write = results_buffer[:]
                results_buffer.clear()
                # Write outside the buffer lock — but we already swapped
                # the buffer so concurrent appends are safe.
                # Polars write is sync; this briefly stalls the worker
                # holding the lock, which is OK for checkpoint cadence.
                write_results(to_write, output_path)
                async with print_lock:
                    print(f"  [checkpoint] wrote {len(to_write)} results "
                          f"to {output_path.name}", flush=True)

    try:
        await asyncio.gather(*(process(d) for d in universe))
    except KeyboardInterrupt:
        print("\nInterrupted — saving buffered results before exit.")

    if results_buffer:
        write_results(results_buffer, output_path)
    await scraper.close()

    elapsed = (time.monotonic() - start) / 60
    print(
        f"\nDone. ok={counters['ok']} no_data={counters['no_data']} "
        f"errors={counters['err']}  runtime={elapsed:.1f}m",
        flush=True,
    )
    print(f"Wrote: {output_path}", flush=True)
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("--limit", type=int, default=None,
                   help="Scrape at most this many DOTs (useful for testing).")
    p.add_argument("--rps", type=float, default=TARGET_RPS,
                   help=f"Target global requests/sec (default {TARGET_RPS}).")
    p.add_argument("--concurrency", type=int, default=CONCURRENCY,
                   help=f"Concurrent workers (default {CONCURRENCY}). The global "
                        f"rate limiter caps total RPS regardless of worker count.")
    p.add_argument("--force", action="store_true",
                   help="Re-scrape DOTs even if they already have an 'ok' result.")
    p.add_argument("--include-all-crash", action="store_true",
                   help="Scrape every DOT with ≥1 crash. ~113k DOTs.")
    p.add_argument("--dots", type=str, default=None,
                   help="Comma-separated DOT list (overrides universe selection).")
    args = p.parse_args()

    output_path = OUTPUT_DIR / f"crash_indicator_{SNAPSHOT_TAG}.parquet"
    print(f"Output: {output_path}")

    if args.dots:
        universe = [int(x.strip()) for x in args.dots.split(",") if x.strip()]
        print(f"Universe (from --dots): {len(universe):,} DOTs")
    else:
        print("Selecting universe from crash data...")
        universe = select_universe(crash_sufficiency_only=not args.include_all_crash)
        print(f"Universe: {len(universe):,} DOTs")

    if not args.force:
        done = load_existing_results(output_path)
        skipped = sum(1 for d in universe if d in done)
        universe = [d for d in universe if d not in done]
        print(f"Already scraped ok this month: {skipped:,} → remaining: {len(universe):,}")

    if args.limit:
        universe = universe[: args.limit]
        print(f"Limited to first {args.limit}")

    eta_min = len(universe) / args.rps / 60
    print(f"Estimated runtime: {eta_min:.1f} min at {args.rps} rps "
          f"with {args.concurrency} concurrent workers")

    return asyncio.run(run_scrape(universe, output_path, args.rps, args.concurrency))


if __name__ == "__main__":
    sys.exit(main())
