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
from signals_bot.providers.stooq import StooqProvider
from signals_bot.providers.yahoo import YahooProvider
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


def _filter_symbols(raw: list[dict[str, Any]]) -> list[str]:
    symbols: list[str] = []
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
    return sorted(set(symbols))


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
    p.add_argument("--output", default="data/universe_lists/universe.csv", help="Output CSV path.")
    p.add_argument("--max-calls", type=int, default=400, help="Max symbol checks per run.")
    p.add_argument("--limit", type=int, default=200, help="Max symbols to write.")
    p.add_argument(
        "--symbols-csv",
        help="Optional CSV with a 'symbol' column to override Finnhub universe "
        "(e.g. defense or oil watchlist).",
    )
    args = p.parse_args()

    load_dotenv(override=False)
    config_path = Path(args.config).expanduser().resolve()
    cfg: AppConfig = load_config(config_path)

    symbols: list[str]
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
        symbols = _filter_symbols(raw_symbols)
    else:
        api_key = os.getenv("FINNHUB_API_KEY")
        if not api_key:
            raise SystemExit("ERROR: missing FINNHUB_API_KEY in environment/.env")
        client = finnhub.Client(api_key=api_key)
        raw_symbols = client.stock_symbols("US")
        symbols = _filter_symbols(raw_symbols)

    if not symbols:
        raise SystemExit("ERROR: no symbols available after filtering")

    state_path = Path(args.state).expanduser()
    state = _load_state(state_path)
    start_index = int(state.get("index", 0))
    batch, next_index = _select_batch(symbols, start=start_index, batch_size=args.max_calls)

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

    strategy = BreakoutMomentumStrategy(cfg.strategy)
    candidates: list[dict[str, Any]] = []

    for symbol in batch:
        hist = None
        provider_used = None
        for prov_name in provider_order:
            prov = providers.get(prov_name)
            if not prov:
                continue
            try:
                hist = prov.get_history(symbol, lookback_days=cfg.data.lookback_days)
                provider_used = prov_name
                break
            except Exception:
                continue
        if hist is None or hist.empty:
            continue

        signal = strategy.generate_signal(
            ticker=symbol,
            hist=hist,
            asof_date=cfg.asof_date(),
            data_provider=provider_used or "unknown",
            open_buy=None,
        )
        if signal is None:
            continue

        candidates.append(
            {
                "symbol": symbol,
                "confidence": signal.confidence,
                "score": signal.score,
            }
        )

    ranked = sorted(candidates, key=lambda x: (-x["confidence"], -x["score"], x["symbol"]))
    top = ranked[: max(1, args.limit)] if ranked else []

    out_path = Path(args.output).expanduser()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    if not top:
        print(
            f"No candidates found for this batch (start_index={start_index}); "
            f"writing empty universe to {out_path}"
        )
        df = pd.DataFrame({"symbol": []})
    else:
        df = pd.DataFrame(top)[["symbol"]]

    df.to_csv(out_path, index=False)

    _save_state(state_path, next_index)
    print(f"Wrote {len(top)} symbols to {out_path} (next_index={next_index})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
