#!/usr/bin/env python3
"""Finviz scrape POC (research only — not for production universe).

Fetches Finviz homepage signal cards or screener HTML via requests + BeautifulSoup,
with Playwright fallback on HTTP 403/503. Quotes are delayed (Finviz footer: ~1 min).
Personal research use only; do not redistribute scraped data.

Examples:
  .venv/bin/python scripts/finviz_screener_poc.py
  .venv/bin/python scripts/finviz_screener_poc.py --signal-filter "New High"
  .venv/bin/python scripts/finviz_screener_poc.py --mode screener --preset top-gainers --max-pages 2
  .venv/bin/python scripts/finviz_screener_poc.py --mode screener \\
    --url "https://finviz.com/screener.ashx?v=111&f=geo_usa,sh_price_o2" \\
    --format csv --out docs/research/finviz_poc_sample.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import logging
import re
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import requests
from bs4 import BeautifulSoup

ROOT_DIR = Path(__file__).resolve().parents[1]
FINVIZ_BASE = "https://finviz.com"
FINVIZ_HOMEPAGE_URL = f"{FINVIZ_BASE}/"
# Modern path; .ashx still redirects here.
SCREENER_PATH = "/screener"

# Signal screens → Overview table (v=111). Snapshot views (210/320/340) lack screener_table.
PRESETS: dict[str, str] = {
    "top-gainers": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_topgainers",
    "top-losers": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_toplosers",
    "unusual-volume": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_unusualvolume",
    "new-high": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_newhigh",
    "new-low": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_newlow",
    "overbought": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_overbought",
    "oversold": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_oversold",
    "most-active": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_mostactive",
    "most-volatile": f"{FINVIZ_BASE}{SCREENER_PATH}?v=111&s=ta_mostvolatile",
}

DEFAULT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/126.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": f"{FINVIZ_BASE}/",
    "Connection": "keep-alive",
}

log = logging.getLogger("finviz_screener_poc")


@dataclass
class ScreenerRow:
    ticker: str
    cells: dict[str, str]
    page: int
    source_url: str
    scraped_at_utc: str


@dataclass
class HomepageSignalRow:
    ticker: str
    last: str
    change: str
    volume: str
    signal: str
    panel: str
    source_url: str
    scraped_at_utc: str


def _normalize_header(text: str) -> str:
    s = (text or "").strip().lower()
    s = s.replace("%", "pct").replace("/", "_").replace(".", "")
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    if s in ("no", "number"):
        return "no"
    if s == "p_e":
        return "p_e"
    if s == "change":
        return "change_pct"
    return s or "col"


def _ticker_from_cell(cell: Any) -> str | None:
    for a in cell.find_all("a", href=True):
        href = str(a.get("href") or "")
        m = re.search(r"[?&]t=([A-Za-z0-9./^-]+)", href)
        if m:
            return m.group(1).strip().upper()
        text = a.get_text(strip=True)
        # Overview cells often look like "A ATAI" (letter + ticker); prefer last token.
        if text:
            tok = text.split()[-1]
            if re.fullmatch(r"[A-Za-z0-9./^-]{1,12}", tok):
                return tok.upper()
    text = cell.get_text(strip=True)
    if text:
        tok = text.split()[-1]
        if re.fullmatch(r"[A-Za-z0-9./^-]{1,12}", tok):
            return tok.upper()
    return None


def parse_screener_table(html: str, *, page: int, source_url: str) -> list[ScreenerRow]:
    """Parse Finviz screener HTML into ScreenerRow list."""
    soup = BeautifulSoup(html, "html.parser")
    table = soup.select_one("table.screener_table")
    if table is None:
        # Snapshot/charts views (v=210/320/340) often omit the Overview table.
        candidates = []
        for t in soup.find_all("table"):
            headers = [th.get_text(strip=True) for th in t.find_all("th")]
            if any(h.lower() == "ticker" for h in headers) and len(t.find_all("tr")) >= 3:
                candidates.append((len(t.find_all("tr")), t))
        if not candidates:
            raise ValueError(
                "No screener Overview table found. Use v=111 (Overview) in the URL, "
                "or a --preset (presets force Overview)."
            )
        candidates.sort(key=lambda x: x[0], reverse=True)
        table = candidates[0][1]

    header_cells = table.find("thead")
    if header_cells:
        raw_headers = [th.get_text(strip=True) for th in header_cells.find_all(["th", "td"])]
    else:
        first_tr = table.find("tr")
        if first_tr is None:
            raise ValueError("Screener table has no rows")
        raw_headers = [th.get_text(strip=True) for th in first_tr.find_all(["th", "td"])]

    headers = [_normalize_header(h) for h in raw_headers]
    # Deduplicate header keys.
    seen: dict[str, int] = {}
    uniq_headers: list[str] = []
    for h in headers:
        n = seen.get(h, 0)
        seen[h] = n + 1
        uniq_headers.append(h if n == 0 else f"{h}_{n + 1}")
    headers = uniq_headers

    body = table.find("tbody") or table
    rows_out: list[ScreenerRow] = []
    scraped_at = datetime.now(timezone.utc).isoformat()
    for tr in body.find_all("tr"):
        cells = tr.find_all("td")
        if not cells:
            continue
        # Skip header-like rows.
        texts = [c.get_text(strip=True) for c in cells]
        if texts and texts[0].lower() in ("no.", "no", "#"):
            continue
        if any(t.lower() == "ticker" for t in texts):
            continue

        ticker: str | None = None
        cells_map: dict[str, str] = {}
        for i, cell in enumerate(cells):
            key = headers[i] if i < len(headers) else f"col_{i}"
            val = cell.get_text(" ", strip=True)
            cells_map[key] = val
            if key == "ticker" or (ticker is None and key.startswith("ticker")):
                ticker = _ticker_from_cell(cell) or (val.split()[0].upper() if val else None)

        if not ticker:
            # Fallback: scan all cells for quote links.
            for cell in cells:
                ticker = _ticker_from_cell(cell)
                if ticker:
                    break
        if not ticker:
            continue

        cells_map["ticker"] = ticker
        rows_out.append(
            ScreenerRow(
                ticker=ticker,
                cells=cells_map,
                page=page,
                source_url=source_url,
                scraped_at_utc=scraped_at,
            )
        )
    return rows_out


def _parse_homepage_signal_row(
    tr: Any,
    *,
    panel: str,
    source_url: str,
    scraped_at: str,
) -> HomepageSignalRow | None:
    tds = tr.find_all("td")
    if len(tds) < 6:
        return None
    ticker = (tds[0].get("data-boxover-ticker") or "").strip().upper()
    if not ticker:
        ticker = _ticker_from_cell(tds[0]) or ""
    if not ticker:
        return None
    signal_td = tds[5]
    link = signal_td.find("a")
    signal = (link.get_text(strip=True) if link else signal_td.get_text(strip=True)) or ""
    return HomepageSignalRow(
        ticker=ticker,
        last=tds[1].get_text(strip=True),
        change=tds[2].get_text(strip=True),
        volume=tds[3].get_text(strip=True),
        signal=signal,
        panel=panel,
        source_url=source_url,
        scraped_at_utc=scraped_at,
    )


def parse_homepage_signal_cards(html: str, *, source_url: str) -> list[HomepageSignalRow]:
    """Parse Finviz homepage `.hp_home-signal-card-cell` signal tables."""
    soup = BeautifulSoup(html, "html.parser")
    cell = soup.select_one(".hp_home-signal-card-cell")
    if cell is None:
        raise ValueError(
            "No .hp_home-signal-card-cell found on homepage. "
            "Finviz may have changed layout or blocked the request."
        )

    scraped_at = datetime.now(timezone.utc).isoformat()
    rows_out: list[HomepageSignalRow] = []
    tables = cell.select("table.hp_signal-table")
    if not tables:
        raise ValueError("No table.hp_signal-table inside .hp_home-signal-card-cell")

    for table in tables:
        tbody = table.find("tbody")
        if tbody is None:
            continue
        panel = tbody.get("id") or "signals"
        for tr in tbody.find_all("tr", class_=lambda c: c and "hp_signal-row" in c):
            row = _parse_homepage_signal_row(
                tr, panel=panel, source_url=source_url, scraped_at=scraped_at
            )
            if row:
                rows_out.append(row)
    if not rows_out:
        raise ValueError("Homepage signal card tables had no hp_signal-row rows")
    return rows_out


def homepage_rows_to_records(rows: list[HomepageSignalRow]) -> list[dict[str, Any]]:
    return [
        {
            "ticker": r.ticker,
            "last": r.last,
            "change": r.change,
            "volume": r.volume,
            "signal": r.signal,
            "panel": r.panel,
            "source_url": r.source_url,
            "scraped_at_utc": r.scraped_at_utc,
        }
        for r in rows
    ]


def print_signals_table(records: list[dict[str, Any]]) -> None:
    """Print Ticker | Last | Change | Volume | Signal aligned table to stdout."""
    headers = ("Ticker", "Last", "Change", "Volume", "Signal")
    keys = ("ticker", "last", "change", "volume", "signal")
    rows = [tuple(str(rec.get(k, "")) for k in keys) for rec in records]
    widths = [len(h) for h in headers]
    for row in rows:
        for i, val in enumerate(row):
            widths[i] = max(widths[i], len(val))

    def fmt_row(cells: tuple[str, ...]) -> str:
        return "  ".join(val.ljust(widths[i]) for i, val in enumerate(cells))

    print(fmt_row(headers))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print(fmt_row(row))


class FinvizHttpClient:
    """HTTP client with optional Playwright fallback on 403/503."""

    def __init__(
        self,
        *,
        timeout_sec: float = 30.0,
        ca_bundle: str | None = None,
        insecure: bool = False,
        playwright_fallback: bool = True,
    ) -> None:
        self.timeout_sec = timeout_sec
        self.playwright_fallback = playwright_fallback
        self.session = requests.Session()
        self.session.headers.update(DEFAULT_HEADERS)
        if insecure:
            self.session.verify = False
            import urllib3

            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
            log.warning("SSL verify disabled (--insecure)")
        elif ca_bundle:
            self.session.verify = ca_bundle
            log.info("Using CA bundle: %s", ca_bundle)

    def get_html(self, url: str) -> str:
        try:
            return self._get_requests(url)
        except requests.HTTPError as e:
            status = e.response.status_code if e.response is not None else 0
            if status in (403, 503) and self.playwright_fallback:
                log.warning("HTTP %s from requests; trying Playwright fallback", status)
                return self._get_playwright(url)
            raise
        except requests.RequestException as e:
            if self.playwright_fallback:
                log.warning("requests failed (%s); trying Playwright fallback", e)
                return self._get_playwright(url)
            raise

    def _get_requests(self, url: str) -> str:
        last_err: Exception | None = None
        for attempt in range(2):
            try:
                resp = self.session.get(url, timeout=self.timeout_sec)
                if resp.status_code >= 500 and attempt == 0:
                    log.warning("HTTP %s; retrying once", resp.status_code)
                    time.sleep(1.0)
                    continue
                if resp.status_code in (403, 503):
                    resp.raise_for_status()
                resp.raise_for_status()
                return resp.text
            except requests.HTTPError:
                raise
            except requests.RequestException as e:
                last_err = e
                if attempt == 0:
                    time.sleep(1.0)
                    continue
                raise
        raise RuntimeError(f"GET failed: {last_err}")

    def _get_playwright(self, url: str) -> str:
        try:
            from playwright.sync_api import sync_playwright
        except ImportError as e:
            raise RuntimeError(
                "Playwright not installed. Run: pip install playwright && playwright install chromium"
            ) from e

        log.info("Fetching via Playwright Chromium: %s", url)
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page(user_agent=DEFAULT_HEADERS["User-Agent"])
                page.set_extra_http_headers(
                    {
                        "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
                        "Referer": DEFAULT_HEADERS["Referer"],
                    }
                )
                resp = page.goto(url, wait_until="domcontentloaded", timeout=int(self.timeout_sec * 1000))
                if resp is not None and resp.status >= 400:
                    raise RuntimeError(f"Playwright HTTP {resp.status} for {url}")
                page.wait_for_timeout(800)
                return page.content()
            finally:
                browser.close()


def build_screener_url(
    *,
    url: str | None = None,
    preset: str | None = None,
    view: str = "111",
    filters: str = "",
    signal: str = "",
    r: int = 1,
) -> str:
    if url:
        base = url.strip()
    elif preset:
        key = preset.strip().lower().replace("_", "-")
        if key not in PRESETS:
            raise ValueError(f"Unknown preset {preset!r}; choose from: {', '.join(sorted(PRESETS))}")
        base = PRESETS[key]
    else:
        qs: dict[str, str] = {"v": view or "111"}
        f = filters.strip()
        if f:
            qs["f"] = f
        s = signal.strip()
        if s:
            qs["s"] = s
        base = f"{FINVIZ_BASE}{SCREENER_PATH}?{urlencode(qs)}"

    parsed = urlparse(base)
    if not parsed.scheme:
        parsed = urlparse(FINVIZ_BASE + ("/" if not base.startswith("/") else "") + base)
    q = parse_qs(parsed.query, keep_blank_values=True)
    # Flatten to single values; set pagination offset.
    flat: dict[str, str] = {k: (v[-1] if v else "") for k, v in q.items()}
    flat["r"] = str(max(1, int(r)))
    # Prefer Overview table when caller used a snapshot/charts view code.
    view = flat.get("v", "111")
    if view in ("210", "320", "340"):
        log.info("Coercing view %s → 111 (Overview) so screener_table is present", view)
        flat["v"] = "111"
    path = parsed.path or SCREENER_PATH
    if path.endswith(".ashx"):
        path = SCREENER_PATH
    new_query = urlencode(flat)
    return urlunparse(
        (
            parsed.scheme or "https",
            parsed.netloc or "finviz.com",
            path,
            "",
            new_query,
            "",
        )
    )


def scrape_pages(
    client: FinvizHttpClient,
    *,
    base_url: str,
    max_pages: int,
    rows_per_page: int,
    delay_sec: float,
    limit: int | None,
) -> list[ScreenerRow]:
    all_rows: list[ScreenerRow] = []
    seen_tickers: set[str] = set()

    for page_idx in range(1, max_pages + 1):
        r = (page_idx - 1) * rows_per_page + 1
        page_url = build_screener_url(url=base_url, r=r)
        log.info("Fetching page %d (r=%d): %s", page_idx, r, page_url)
        html = client.get_html(page_url)
        page_rows = parse_screener_table(html, page=page_idx, source_url=page_url)
        if not page_rows:
            log.info("Empty page %d — stopping", page_idx)
            break

        new_count = 0
        for row in page_rows:
            if row.ticker in seen_tickers:
                continue
            seen_tickers.add(row.ticker)
            all_rows.append(row)
            new_count += 1
            if limit is not None and len(all_rows) >= limit:
                log.info("Reached --limit %d", limit)
                return all_rows

        log.info("Page %d: %d rows (%d new); total=%d", page_idx, len(page_rows), new_count, len(all_rows))

        if new_count == 0:
            log.info("Duplicate-only page — stopping")
            break
        if len(page_rows) < rows_per_page:
            log.info("Short page (%d < %d) — last page", len(page_rows), rows_per_page)
            break
        if page_idx < max_pages and delay_sec > 0:
            time.sleep(delay_sec)

    return all_rows


def rows_to_records(rows: list[ScreenerRow]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for row in rows:
        rec: dict[str, Any] = {
            "ticker": row.ticker,
            "page": row.page,
            "source_url": row.source_url,
            "scraped_at_utc": row.scraped_at_utc,
        }
        for k, v in row.cells.items():
            if k == "ticker":
                continue
            rec[k] = v
        records.append(rec)
    return records


def write_csv(records: list[dict[str, Any]], out: Path | None) -> None:
    if not records:
        text = ""
        if out:
            out.parent.mkdir(parents=True, exist_ok=True)
            out.write_text(text, encoding="utf-8")
        return
    # Stable column order: meta first, then union of cell keys.
    meta = ["ticker", "page", "source_url", "scraped_at_utc"]
    extra: list[str] = []
    seen = set(meta)
    for rec in records:
        for k in rec:
            if k not in seen:
                seen.add(k)
                extra.append(k)
    fieldnames = meta + extra
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        f = out.open("w", encoding="utf-8", newline="")
        close = True
    else:
        f = sys.stdout
        close = False
    try:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for rec in records:
            writer.writerow(rec)
    finally:
        if close:
            f.close()


def write_json(records: list[dict[str, Any]], out: Path | None) -> None:
    payload = json.dumps(records, indent=2, ensure_ascii=False)
    if out:
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)


def scrape_homepage_signals(client: FinvizHttpClient) -> list[HomepageSignalRow]:
    html = client.get_html(FINVIZ_HOMEPAGE_URL)
    return parse_homepage_signal_cards(html, source_url=FINVIZ_HOMEPAGE_URL)


def _build_arg_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        description="POC: scrape Finviz homepage signal cards or screener (research only)."
    )
    p.add_argument(
        "--mode",
        choices=("homepage", "screener", "auto"),
        default="auto",
        help="auto = screener when --preset/--url/--filters/--signal else homepage (default).",
    )
    src = p.add_mutually_exclusive_group()
    src.add_argument("--url", default="", help="Full Finviz screener URL from the browser.")
    src.add_argument(
        "--preset",
        default="",
        choices=sorted(PRESETS.keys()),
        help="Named signal screen preset.",
    )
    p.add_argument("--view", default="111", help="Screener view code when not using --url/--preset (default 111).")
    p.add_argument("--filters", default="", help="Comma-separated f= filter tokens (e.g. geo_usa,sh_price_o2).")
    p.add_argument("--signal", default="", help="Optional s= signal code when building a URL manually.")
    p.add_argument("--max-pages", type=int, default=3, help="Max pages to fetch (default 3).")
    p.add_argument("--rows-per-page", type=int, default=20, help="Rows per page / r= step (default 20 free).")
    p.add_argument("--delay-sec", type=float, default=1.0, help="Delay between pages (default 1.0).")
    p.add_argument("--limit", type=int, default=0, help="Stop after N unique tickers (0 = no limit).")
    p.add_argument(
        "--format",
        choices=("table", "csv", "json"),
        default="table",
        help="Output format (default table for homepage).",
    )
    p.add_argument(
        "--signal-filter",
        default="",
        help="Homepage mode: keep rows whose Signal label contains this text (case-insensitive).",
    )
    p.add_argument("--out", default="", help="Output file path (default: stdout).")
    p.add_argument("--ca-bundle", default="", help="Path to CA bundle for SSL interception.")
    p.add_argument("--insecure", action="store_true", help="Disable SSL verification (last resort).")
    p.add_argument(
        "--no-playwright-fallback",
        action="store_true",
        help="Disable Playwright fallback on 403/503.",
    )
    p.add_argument("--timeout-sec", type=float, default=30.0, help="HTTP timeout seconds.")
    p.add_argument("-v", "--verbose", action="store_true", help="DEBUG logging.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_arg_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(levelname)s %(message)s",
    )

    client = FinvizHttpClient(
        timeout_sec=float(args.timeout_sec),
        ca_bundle=(args.ca_bundle or "").strip() or None,
        insecure=bool(args.insecure),
        playwright_fallback=not bool(args.no_playwright_fallback),
    )

    out_path = Path(args.out).expanduser() if (args.out or "").strip() else None
    signal_filter = (args.signal_filter or "").strip().lower()

    url = (args.url or "").strip()
    preset = (args.preset or "").strip()
    mode = str(args.mode)
    if mode == "auto":
        if url or preset or (args.filters or "").strip() or (args.signal or "").strip():
            mode = "screener"
        else:
            mode = "homepage"

    if mode == "homepage":
        try:
            rows = scrape_homepage_signals(client)
        except Exception as e:  # noqa: BLE001
            log.error("Homepage scrape failed: %s", e)
            return 1
        records = homepage_rows_to_records(rows)
        if signal_filter:
            records = [r for r in records if signal_filter in r.get("signal", "").lower()]
        if args.format == "table":
            if out_path:
                log.warning("--format table writes to stdout only; use --out with csv/json")
            print_signals_table(records)
        elif args.format == "json":
            write_json(records, out_path)
        else:
            write_csv(records, out_path)
        dest = str(out_path) if out_path else "stdout"
        log.info("Done. rows=%d mode=homepage format=%s out=%s", len(records), args.format, dest)
        return 0

    if not url and not preset and not (args.filters or "").strip() and not (args.signal or "").strip():
        preset = "top-gainers"
        log.info("Screener mode: no --url/--preset/--filters; defaulting to preset=%s", preset)

    try:
        base_url = build_screener_url(
            url=url or None,
            preset=preset or None,
            view=str(args.view),
            filters=str(args.filters or ""),
            signal=str(args.signal or ""),
            r=1,
        )
    except ValueError as e:
        log.error("%s", e)
        return 2

    limit = int(args.limit) if int(args.limit) > 0 else None
    try:
        rows = scrape_pages(
            client,
            base_url=base_url,
            max_pages=max(1, int(args.max_pages)),
            rows_per_page=max(1, int(args.rows_per_page)),
            delay_sec=max(0.0, float(args.delay_sec)),
            limit=limit,
        )
    except Exception as e:  # noqa: BLE001
        log.error("Scrape failed: %s", e)
        return 1

    records = rows_to_records(rows)
    fmt = args.format if args.format != "table" else "csv"
    if args.format == "json":
        write_json(records, out_path)
    else:
        write_csv(records, out_path)

    dest = str(out_path) if out_path else "stdout"
    log.info("Done. rows=%d mode=screener format=%s out=%s", len(records), fmt, dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
