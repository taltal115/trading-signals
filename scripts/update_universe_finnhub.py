from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone
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
from signals_bot.storage.firestore import (
    read_latest_universe_snapshot,
    read_latest_universe_snapshot_doc,
    read_recent_universe_symbols,
    read_universe_symbol_details,
    write_universe_snapshot,
)
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


def _evaluate_symbol(
    *,
    symbol: str,
    providers: dict[str, Any],
    provider_order: list[str],
    lookback_days: int,
    strategy: BreakoutMomentumStrategy,
    asof_date,
    log,
) -> tuple[Any, str | None, str | None]:
    """Run providers + strategy for one symbol.

    Returns ``(signal_or_None, provider_used_or_None, error_reason_or_None)``. Error reason is
    ``"no_history"`` / ``"strategy_none"`` / a provider exception text — used only for logs and
    inactive_reason classification by the caller.
    """
    hist = None
    provider_used: str | None = None
    last_err: str | None = None
    for prov_name in provider_order:
        prov = providers.get(prov_name)
        if not prov:
            continue
        try:
            hist = prov.get_history(symbol, lookback_days=lookback_days)
            provider_used = prov_name
            break
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
            log.debug("%s provider=%s error=%s", symbol, prov_name, last_err)
            continue
    if hist is None or hist.empty:
        return None, None, last_err or "no_history"
    signal = strategy.generate_signal(
        ticker=symbol,
        hist=hist,
        asof_date=asof_date,
        data_provider=provider_used or "unknown",
        open_buy=None,
    )
    if signal is None:
        return None, provider_used, "strategy_none"
    return signal, provider_used, None


def _parse_iso_utc(raw: Any) -> datetime | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        s = raw.strip()
        s = s.replace("Z", "+00:00") if s.endswith("Z") else s
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            return dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _is_stale(prev_entry: dict, *, now_utc: datetime, stale_runs: int, stale_days: int) -> bool:
    if not prev_entry:
        return False
    streak = int(prev_entry.get("inactive_runs_streak") or 0)
    if stale_runs > 0 and streak >= stale_runs:
        return True
    last_active_at = _parse_iso_utc(prev_entry.get("last_active_at"))
    if last_active_at is not None and stale_days > 0:
        if (now_utc - last_active_at).days >= stale_days:
            return True
    return False


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
        help="Carry-over pool size: union the last N snapshots' symbols and re-validate them "
        "this run (0 = today's batch only).",
    )
    p.add_argument(
        "--top-k",
        type=int,
        default=100,
        help="Cap the number of symbols flagged 'active' (sorted by confidence,score). "
        "0 disables the cap.",
    )
    p.add_argument(
        "--min-confidence",
        type=int,
        default=85,
        help="Minimum signal confidence (0-100) for a symbol to be eligible for 'active'. "
        "Below this → marked inactive_low_conf.",
    )
    p.add_argument(
        "--stale-runs",
        type=int,
        default=5,
        help="Mark a previously seen symbol inactive_stale once its inactive streak (consecutive "
        "runs not active) hits this many. 0 disables.",
    )
    p.add_argument(
        "--stale-days",
        type=int,
        default=14,
        help="Mark a symbol inactive_stale once its last_active_at is older than this many days. "
        "0 disables.",
    )
    p.add_argument(
        "--revalidate-cap",
        type=int,
        default=1000,
        help="Maximum prior-only carry-over symbols to re-evaluate against the strategy this run "
        "(API budget guard). 0 = no cap.",
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
            api_key=cfg.data.stooq_api_key,
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

    asof_date = cfg.asof_date().isoformat()
    collection = args.firestore_collection or cfg.universe.firestore.collection
    now_utc = datetime.now(timezone.utc)

    today_results: dict[str, dict[str, Any]] = {}
    today_failed: set[str] = set()

    for symbol in batch:
        log.debug("evaluate %s", symbol)
        signal, provider_used, err = _evaluate_symbol(
            symbol=symbol,
            providers=providers,
            provider_order=provider_order,
            lookback_days=cfg.data.lookback_days,
            strategy=strategy,
            asof_date=cfg.asof_date(),
            log=log,
        )
        if signal is None:
            log.debug("%s skip reason=%s", symbol, err or "-")
            today_failed.add(symbol)
            continue
        log.debug(
            "%s candidate action=%s conf=%d score=%.3f provider=%s",
            symbol,
            signal.action,
            int(signal.confidence),
            float(signal.score),
            provider_used,
        )
        today_results[symbol] = {
            "confidence": int(signal.confidence),
            "score": float(signal.score),
            "name": symbol_base_details.get(symbol, {}).get("name", ""),
        }

    if args.limit > 0 and len(today_results) > args.limit:
        ranked_today = sorted(
            today_results.items(),
            key=lambda kv: (-int(kv[1]["confidence"]), -float(kv[1]["score"]), kv[0]),
        )
        kept = dict(ranked_today[: args.limit])
        log.info("Truncating today's batch results: kept=%d dropped=%d (--limit)",
                 len(kept), len(today_results) - len(kept))
        today_results = kept

    log.info("Today's batch passes: %d (failures=%d)", len(today_results), len(today_failed))

    prior_set: set[str] = set()
    if args.merge_days > 0:
        try:
            prior_set = set(
                read_recent_universe_symbols(collection=collection, limit=args.merge_days)
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not read prior universe snapshots: %s", exc)
            prior_set = set()

    prev_doc = None
    prev_doc_id: str | None = None
    try:
        prev_snap = read_latest_universe_snapshot(collection=collection)
        if prev_snap:
            prev_doc_id, prev_doc = prev_snap
    except Exception as exc:  # noqa: BLE001
        log.warning("Could not read latest universe snapshot for streaks: %s", exc)
    prev_details: dict[str, dict[str, Any]] = {}
    if prev_doc_id:
        try:
            prev_details = read_universe_symbol_details(
                doc_id=prev_doc_id,
                collection=collection,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("Could not read prior symbol details: %s", exc)
            prev_details = {}
    if not prev_details and isinstance(prev_doc, dict):
        raw_prev = prev_doc.get("symbol_details")
        if isinstance(raw_prev, dict):
            for k, v in raw_prev.items():
                if isinstance(v, dict):
                    prev_details[str(k).strip().upper()] = v

    prior_only = sorted(prior_set - set(today_results.keys()) - today_failed)
    if args.revalidate_cap and args.revalidate_cap > 0:
        to_revalidate = prior_only[: args.revalidate_cap]
    else:
        to_revalidate = prior_only
    unevaluated_prior = set(prior_only) - set(to_revalidate)

    revalidate_results: dict[str, dict[str, Any]] = {}
    revalidate_failures: set[str] = set()
    if to_revalidate:
        log.info("Re-validating %d carry-over symbols (cap=%d, prior_only=%d)",
                 len(to_revalidate), args.revalidate_cap, len(prior_only))
    for symbol in to_revalidate:
        signal, _provider, err = _evaluate_symbol(
            symbol=symbol,
            providers=providers,
            provider_order=provider_order,
            lookback_days=cfg.data.lookback_days,
            strategy=strategy,
            asof_date=cfg.asof_date(),
            log=log,
        )
        if signal is None:
            log.debug("%s revalidate fail reason=%s", symbol, err or "-")
            revalidate_failures.add(symbol)
            continue
        revalidate_results[symbol] = {
            "confidence": int(signal.confidence),
            "score": float(signal.score),
            "name": prev_details.get(symbol, {}).get("name", "")
            or symbol_base_details.get(symbol, {}).get("name", ""),
        }

    passing: dict[str, dict[str, Any]] = {**today_results, **revalidate_results}

    low_conf: set[str] = set()
    if args.min_confidence > 0:
        for sym in list(passing.keys()):
            if int(passing[sym]["confidence"]) < args.min_confidence:
                low_conf.add(sym)
                del passing[sym]

    stale: set[str] = set()
    for sym in list(passing.keys()):
        prev_entry = prev_details.get(sym, {})
        if _is_stale(prev_entry, now_utc=now_utc,
                     stale_runs=args.stale_runs, stale_days=args.stale_days):
            stale.add(sym)
            del passing[sym]

    ranked = sorted(
        passing.items(),
        key=lambda kv: (-int(kv[1]["confidence"]), -float(kv[1]["score"]), kv[0]),
    )
    if args.top_k and args.top_k > 0:
        active_kv = ranked[: args.top_k]
        capped_kv = ranked[args.top_k :]
    else:
        active_kv = ranked
        capped_kv = []
    active_syms = {kv[0] for kv in active_kv}
    capped_syms = {kv[0] for kv in capped_kv}

    all_symbols: set[str] = set()
    all_symbols.update(today_results.keys())
    all_symbols.update(revalidate_results.keys())
    all_symbols.update(today_failed)
    all_symbols.update(revalidate_failures)
    all_symbols.update(low_conf)
    all_symbols.update(stale)
    all_symbols.update(capped_syms)
    all_symbols.update(unevaluated_prior)

    symbol_details: dict[str, dict[str, Any]] = {}
    now_iso = now_utc.isoformat()

    for sym in all_symbols:
        if sym in unevaluated_prior:
            continue
        prev = prev_details.get(sym, {})
        new_entry: dict[str, Any] = dict(prev) if isinstance(prev, dict) else {}

        latest_score = passing.get(sym) or revalidate_results.get(sym) or today_results.get(sym)
        if latest_score:
            if latest_score.get("name"):
                new_entry["name"] = latest_score["name"]
            new_entry["last_score"] = float(latest_score["score"])
            new_entry["last_confidence"] = int(latest_score["confidence"])
            new_entry["last_evaluated_run_at"] = now_iso
        elif sym in today_failed or sym in revalidate_failures:
            new_entry["last_evaluated_run_at"] = now_iso

        base_name = symbol_base_details.get(sym, {}).get("name", "")
        if base_name and not new_entry.get("name"):
            new_entry["name"] = base_name

        if sym in active_syms:
            status = "active"
        elif sym in capped_syms:
            status = "inactive_capped"
        elif sym in stale:
            status = "inactive_stale"
        elif sym in low_conf:
            status = "inactive_low_conf"
        elif sym in revalidate_failures or sym in today_failed:
            status = "inactive_failed"
        else:
            prev_status = str(prev.get("status") or "").strip()
            status = prev_status if prev_status.startswith("inactive") else "inactive_stale"

        new_entry["status"] = status
        new_entry["active"] = status == "active"
        new_entry["inactive_reason"] = "" if status == "active" else status

        if status == "active":
            new_entry["last_active_at"] = now_iso
            new_entry["last_active_asof_date"] = asof_date
            new_entry["inactive_runs_streak"] = 0
            new_entry.pop("inactive_since_run_at", None)
        else:
            prev_streak = int(prev.get("inactive_runs_streak") or 0)
            new_entry["inactive_runs_streak"] = prev_streak + 1
            since = prev.get("inactive_since_run_at")
            new_entry["inactive_since_run_at"] = since if since else now_iso

        symbol_details[sym] = new_entry

    api_key = os.getenv("FINNHUB_API_KEY")
    if api_key and active_syms:
        log.info("Fetching company profiles for %d active symbols...", len(active_syms))
        profile_client = finnhub.Client(api_key=api_key)
        import time
        for i, sym in enumerate(sorted(active_syms)):
            try:
                profile = profile_client.company_profile2(symbol=sym)
                if profile:
                    cur = symbol_details.setdefault(sym, {})
                    cur["sector"] = profile.get("finnhubIndustry", "") or cur.get("sector", "")
                    cur["name"] = profile.get("name", "") or cur.get("name", "")
                    cur["country"] = profile.get("country", "") or cur.get("country", "")
                    mc = profile.get("marketCapitalization")
                    if mc is not None:
                        cur["market_cap"] = mc
                if i > 0 and i % 30 == 0:
                    time.sleep(1)
            except Exception as exc:  # noqa: BLE001
                log.debug("Failed to fetch profile for %s: %s", sym, exc)

    all_list = sorted(
        all_symbols,
        key=lambda sym: (
            -int(symbol_details.get(sym, {}).get("last_confidence") or symbol_details.get(sym, {}).get("confidence") or -1),
            -float(symbol_details.get(sym, {}).get("last_score") or symbol_details.get(sym, {}).get("score") or -1.0),
            sym,
        ),
    )
    active_list = sorted(active_syms)
    inactive_list = sorted(all_symbols - active_syms)

    try:
        write_universe_snapshot(
            asof_date=asof_date,
            symbols=all_list,
            collection=collection,
            source="finnhub_discovery",
            symbol_details=symbol_details,
            active_symbols=active_list,
            inactive_symbols=inactive_list,
        )
    except RuntimeError as exc:
        raise SystemExit(f"ERROR: Firestore universe write failed (check credentials): {exc}") from exc

    log.info(
        "Universe summary asof_date=%s active=%d inactive=%d total=%d "
        "(today_pass=%d revalidate_pass=%d today_fail=%d revalidate_fail=%d "
        "low_conf=%d stale=%d capped=%d unevaluated_prior=%d)",
        asof_date,
        len(active_list),
        len(inactive_list),
        len(all_list),
        len(today_results),
        len(revalidate_results),
        len(today_failed),
        len(revalidate_failures),
        len(low_conf),
        len(stale),
        len(capped_syms),
        len(unevaluated_prior),
    )

    if not all_list:
        log.warning(
            "No symbols in this run (start_index=%d); wrote empty Firestore %s/%s",
            start_index,
            collection,
            asof_date,
        )
    else:
        log.info(
            "Firestore write collection=%s asof_date=%s active=%d total=%d",
            collection,
            asof_date,
            len(active_list),
            len(all_list),
        )
        if args.verbose:
            preview = active_list[:40]
            log.debug("Active head: %s%s", preview, " …" if len(active_list) > 40 else "")

    if args.output:
        out_path = Path(args.output).expanduser()
        out_path.parent.mkdir(parents=True, exist_ok=True)
        df = pd.DataFrame({"symbol": active_list}, columns=["symbol"])
        df.to_csv(out_path, index=False)
        log.info("CSV backup (active only) path=%s rows=%d", out_path, len(df))

    _save_state(state_path, next_index)
    log.info("Saved state next_index=%d", next_index)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
