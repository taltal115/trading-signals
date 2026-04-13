from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

import finnhub
import pandas as pd
from dotenv import load_dotenv

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.config import AppConfig, load_config
from signals_bot.logging import get_logger
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
from signals_bot.storage.firestore import read_recent_universe_symbols, write_universe_snapshot
from signals_bot.strategy.breakout import BreakoutMomentumStrategy


US_MICS = {
    "XNAS",  # Nasdaq
    "XNYS",  # NYSE
    "ARCX",  # NYSE Arca
    "BATS",  # Cboe BZX
    "IEXG",  # IEX
}


def _load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"index": 0}
    try:
        return json.loads(path.read_text())
    except Exception:
        return {"index": 0}


def _save_state(path: Path, index: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"index": index}, indent=2))


def _clean_symbol(sym: str) -> str:
    return sym.strip().upper()


def _is_valid_symbol(sym: str) -> bool:
    if not sym:
        return False
    if "." in sym or "/" in sym:
        return False
    return True


def _filter_symbols(raw: list[dict[str, Any]]) -> tuple[list[str], dict[str, dict]]:
    symbols: list[str] = []
    details: dict[str, dict] = {}
    for r in raw:
        sym = _clean_symbol(str(r.get("symbol", "")))
        if not _is_valid_symbol(sym):
            continue
        if str(r.get("currency", "")).upper() != "USD":
            continue
        if str(r.get("type", "")).lower() not in {"common stock", "common"}:
            continue
        mic = str(r.get("mic", "")).upper()
        if mic and mic not in US_MICS:
            continue
        symbols.append(sym)
        details[sym] = {
            "name": str(r.get("description", "") or r.get("name", "") or ""),
            "mic": mic,
        }
    unique_symbols = sorted(set(symbols))
    return unique_symbols, {s: details[s] for s in unique_symbols if s in details}


def _select_batch(symbols: list[str], *, start: int, batch_size: int) -> tuple[list[str], int]:
    if not symbols:
        return [], 0
    n = len(symbols)
    start = start % n
    end = min(start + batch_size, n)
    batch = symbols[start:end]
    next_index = end if end < n else 0
    return batch, next_index


def main() -> int:
    p = argparse.ArgumentParser(
        description="Build dynamic universe from Finnhub symbols + strategy filters."
    )
    p.add_argument("--config", default="config.yaml", help="Path to config.yaml.")
    p.add_argument("--state", default="data/universe_state.json", help="State file path.")
    p.add_argument(
        "--output",
        default=None,
        help="Optional path to write a backup CSV; omit to skip CSV (Firestore is always updated).",
    )
    p.add_argument(
        "--firestore-collection",
        default=None,
        help="Override universe.firestore.collection from config (default: universe).",
    )
    p.add_argument("--max-calls", type=int, default=400, help="Max symbol checks per run.")
    p.add_argument("--limit", type=int, default=0, help="Max symbols to write (0 = unlimited).")
    p.add_argument(
        "--merge-days",
        type=int,
        default=0,
        help="Merge today's candidates with the last N Firestore universe snapshots (0 = off, overwrite only).",
    )
    p.add_argument(
        "--symbols-csv",
        help="Optional CSV with a 'symbol' column to override Finnhub universe "
        "(e.g. defense or oil watchlist).",
    )
    p.add_argument(
        "-v",
        "--verbose",
        action="store_true",
        help="Verbose logging: per-symbol provider/signal steps (DEBUG).",
    )
    args = p.parse_args()

    load_dotenv(override=False)
    config_path = Path(args.config).expanduser().resolve()
    cfg: AppConfig = load_config(config_path)
    level = "DEBUG" if args.verbose else cfg.logging.level
    log = get_logger(level)
    log.info("universe-discovery start config=%s verbose=%s", config_path, args.verbose)

    symbols: list[str]
    symbol_base_details: dict[str, dict] = {}
    if args.symbols_csv:
        symbols_path = Path(args.symbols_csv).expanduser().resolve()
        if not symbols_path.exists():
            raise SystemExit(f"ERROR: symbols CSV not found: {symbols_path}")
        try:
            df = pd.read_csv(symbols_path)
        except Exception as exc:
            raise SystemExit(f"ERROR: failed to read symbols CSV {symbols_path}: {exc}") from exc
        if "symbol" not in df.columns:
            raise SystemExit(f"ERROR: symbols CSV {symbols_path} missing 'symbol' column")
        raw_symbols = [
            {
                "symbol": str(sym),
                "currency": "USD",
                "type": "common stock",
                "mic": "",
            }
            for sym in df["symbol"].astype(str).tolist()
        ]
        symbols, symbol_base_details = _filter_symbols(raw_symbols)
        log.info(
            "Universe source=symbols_csv path=%s rows=%d filtered_unique=%d",
            symbols_path,
            len(df),
            len(symbols),
        )
    else:
        api_key = os.getenv("FINNHUB_API_KEY")
        if not api_key:
            raise SystemExit("ERROR: missing FINNHUB_API_KEY in environment/.env")
        log.info("Fetching Finnhub stock_symbols(US) …")
        client = finnhub.Client(api_key=api_key)
        raw_symbols = client.stock_symbols("US")
        log.debug("Finnhub raw_symbols count=%d", len(raw_symbols) if raw_symbols else 0)
        symbols, symbol_base_details = _filter_symbols(raw_symbols)
        log.info("Universe source=finnhub_us filtered_unique=%d", len(symbols))

        first_letters = sorted(set(s[0] for s in symbols if s))
        log.info("Universe coverage: letters=%s total_symbols=%d", "".join(first_letters), len(symbols))

    if not symbols:
        raise SystemExit("ERROR: no symbols available after filtering")

    state_path = Path(args.state).expanduser()
    state = _load_state(state_path)
    start_index = int(state.get("index", 0))
    batch, next_index = _select_batch(symbols, start=start_index, batch_size=args.max_calls)
    log.info(
        "Batch state_path=%s start_index=%d max_calls=%d batch_len=%d next_index=%d universe_total=%d",
        state_path,
        start_index,
        args.max_calls,
        len(batch),
        next_index,
        len(symbols),
    )
    if args.verbose and batch:
        log.debug("Batch symbols: %s", ", ".join(batch[:50]) + (" …" if len(batch) > 50 else ""))

    providers = {
        "yahoo": YahooProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
        ),
        "stooq": StooqProvider(
            timeout_sec=cfg.data.request_timeout_sec,
            ssl_verify=cfg.data.ssl_verify,
            ca_bundle_path=cfg.resolve_path(cfg.data.ca_bundle_path).as_posix() if cfg.data.ca_bundle_path else None,
        ),
    }
    provider_order = [p for p in cfg.data.provider_order if p in providers]
    if not provider_order:
        provider_order = ["yahoo", "stooq"]
    log.info(
        "Strategy scan lookback_days=%d provider_order=%s asof_date=%s",
        cfg.data.lookback_days,
        provider_order,
        cfg.asof_date().isoformat(),
    )

    strategy = BreakoutMomentumStrategy(cfg.strategy)
    candidates: list[dict[str, Any]] = []

    for symbol in batch:
        log.debug("evaluate %s", symbol)
        hist = None
        provider_used = None
        last_err: str | None = None
        for prov_name in provider_order:
            prov = providers.get(prov_name)
            if not prov:
                continue
            try:
                hist = prov.get_history(symbol, lookback_days=cfg.data.lookback_days)
                provider_used = prov_name
                break
            except Exception as exc:  # noqa: BLE001
                last_err = str(exc)
                log.debug("%s provider=%s error=%s", symbol, prov_name, last_err)
                continue
        if hist is None or hist.empty:
            log.debug(
                "%s skip no_history last_err=%s",
                symbol,
                last_err or "-",
            )
            continue

        signal = strategy.generate_signal(
            ticker=symbol,
            hist=hist,
            asof_date=cfg.asof_date(),
            data_provider=provider_used or "unknown",
            open_buy=None,
        )
        if signal is None:
            log.debug("%s skip strategy returned no signal (provider=%s)", symbol, provider_used)
            continue

        log.debug(
            "%s candidate action=%s conf=%d score=%.3f provider=%s",
            symbol,
            signal.action,
            int(signal.confidence),
            float(signal.score),
            provider_used,
        )
        candidates.append(
            {
                "symbol": symbol,
                "confidence": signal.confidence,
                "score": signal.score,
                "name": symbol_base_details.get(symbol, {}).get("name", ""),
            }
        )

    ranked = sorted(candidates, key=lambda x: (-x["confidence"], -x["score"], x["symbol"]))
    if args.limit > 0:
        top = ranked[: args.limit]
    else:
        top = ranked
    log.info("Candidates in batch: %d (limit=%s)", len(top), args.limit or "unlimited")

    symbol_details: dict[str, dict] = {}
    for cand in top:
        sym = cand["symbol"]
        symbol_details[sym] = {
            "name": cand.get("name", ""),
            "confidence": cand.get("confidence", 0),
            "score": cand.get("score", 0),
        }

    api_key = os.getenv("FINNHUB_API_KEY")
    if api_key and top:
        log.info("Fetching company profiles for %d candidates...", len(top))
        profile_client = finnhub.Client(api_key=api_key)
        import time
        for i, cand in enumerate(top):
            sym = cand["symbol"]
            try:
                profile = profile_client.company_profile2(symbol=sym)
                if profile:
                    symbol_details[sym]["sector"] = profile.get("finnhubIndustry", "")
                    symbol_details[sym]["name"] = profile.get("name", "") or symbol_details[sym].get("name", "")
                    symbol_details[sym]["country"] = profile.get("country", "")
                    symbol_details[sym]["market_cap"] = profile.get("marketCapitalization", 0)
                if i > 0 and i % 30 == 0:
                    time.sleep(1)
            except Exception as exc:
                log.debug("Failed to fetch profile for %s: %s", sym, exc)

    asof_date = cfg.asof_date().isoformat()
    collection = args.firestore_collection or cfg.universe.firestore.collection
    new_symbols: set[str] = {str(row["symbol"]) for row in top}

    if args.merge_days > 0:
        try:
            prior = read_recent_universe_symbols(
                collection=collection,
                limit=args.merge_days,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not read prior universe snapshots for merge: %s", exc)
            prior = []
        prior_set = set(prior)
        merged = new_symbols | prior_set
        log.info(
            "Merge: today_new=%d prior_symbols=%d merged_total=%d (merge_days=%d)",
            len(new_symbols),
            len(prior_set),
            len(merged),
            args.merge_days,
        )
        symbol_list = sorted(merged)
    else:
        symbol_list = sorted(new_symbols)

    try:
        write_universe_snapshot(
            asof_date=asof_date,
            symbols=symbol_list,
            collection=collection,
            source="finnhub_discovery",
            symbol_details=symbol_details,
        )
    except RuntimeError as exc:
        raise SystemExit(f"ERROR: Firestore universe write failed (check credentials): {exc}") from exc

    if not symbol_list:
        log.warning(
            "No candidates in this batch (start_index=%d); wrote empty Firestore %s/%s",
            start_index,
            collection,
            asof_date,
        )
    else:
        log.info("Firestore write collection=%s asof_date=%s count=%d", collection, asof_date, len(symbol_list))
        if args.verbose:
            preview = symbol_list[:40]
            log.debug("Top symbols: %s%s", preview, " …" if len(symbol_list) > 40 else "")

    if args.output:
        out_path = Path(args.output).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        df = pd.DataFrame({"symbol": symbol_list}, columns=["symbol"])
        df.to_csv(out_path, index=False)
        log.info("CSV backup path=%s rows=%d", out_path, len(df))

    _save_state(state_path, next_index)
    log.info("Saved state next_index=%d", next_index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
