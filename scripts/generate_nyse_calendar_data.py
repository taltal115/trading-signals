#!/usr/bin/env python3
"""Emit NYSE session date lists for TypeScript / legacy vanilla (from exchange_calendars).

Run after upgrading exchange_calendars or extending the year range:

  PYTHONPATH=./src python scripts/generate_nyse_calendar_data.py
"""

from __future__ import annotations

from pathlib import Path

import exchange_calendars as xcals
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    year_min = 2015
    year_max = 2035
    cal = xcals.get_calendar("XNYS")
    start = pd.Timestamp(f"{year_min}-01-01")
    end = pd.Timestamp(f"{year_max}-12-31")
    if start < cal.first_session:
        start = cal.first_session
    if end > cal.last_session:
        end = cal.last_session
    sessions = cal.sessions_in_range(start, end)
    iso_list = [pd.Timestamp(ts).strftime("%Y-%m-%d") for ts in sessions]
    ver = xcals.__version__
    range_note = f"{start.date()} — {end.date()}"

    elems = "".join([f'\n    "{d}",' for d in iso_list])
    ts_body = f"""\
/**
 * AUTO-GENERATED — do not edit.
 * Source: scripts/generate_nyse_calendar_data.py
 * Range (clamped to XNYS): {range_note}.
 */
export const NYSE_SESSION_ISO_DATES_READONLY: readonly string[] = [{elems}
];

export const NYSE_SESSION_SET: ReadonlySet<string> = new Set(
  NYSE_SESSION_ISO_DATES_READONLY as readonly string[]
);

export function isNyseSessionIsoDate(isoYmd: string): boolean {{
  return NYSE_SESSION_SET.has(isoYmd.slice(0, 10));
}}
"""
    ts_path = ROOT / "frontend" / "src" / "generated" / "nyse-session-set.generated.ts"
    ts_path.parent.mkdir(parents=True, exist_ok=True)
    ts_path.write_text(ts_body, encoding="utf-8")

    arr_body = "".join([f'\n    "{d}",' for d in iso_list])
    js_txt = f"""/** AUTO-GENERATED — same source as frontend nyse-session-set.generated.ts */
(function (g) {{
  g.NYSE_SESSION_ISO_DATES = [{arr_body}
  ];
  g.NYSE_SESSION_SET = new Set(g.NYSE_SESSION_ISO_DATES);
  g.isNyseSessionIsoDate = function (iso) {{
    return g.NYSE_SESSION_SET.has(String(iso || "").slice(0, 10));
  }};
}})(typeof window !== "undefined" ? window : globalThis);
"""

    js_path = ROOT / "web" / "legacy-vanilla" / "nyse-session-set.generated.js"
    js_path.write_text(js_txt, encoding="utf-8")

    print(f"Wrote {ts_path.relative_to(ROOT)} ({len(iso_list)} sessions)")
    print(f"Wrote {js_path.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
