"""Unit tests for universe snapshot write shape (index-entry safe parent doc)."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from signals_bot.storage import firestore as fs  # noqa: E402


class WriteUniverseSnapshotTests(unittest.TestCase):
    @patch.object(fs, "_build_client")
    def test_parent_doc_is_metadata_only(self, mock_build: MagicMock) -> None:
        db = MagicMock()
        mock_build.return_value = db
        parent_ref = MagicMock()
        db.collection.return_value.document.return_value = parent_ref

        fs.write_universe_snapshot(
            asof_date="2026-05-28",
            symbols=["AAA", "BBB", "CCC"],
            active_symbols=["AAA"],
            inactive_symbols=["BBB", "CCC"],
            symbol_details={
                "AAA": {"active": True, "status": "active"},
                "BBB": {"active": False, "status": "inactive_stale"},
            },
        )

        parent_ref.set.assert_called_once()
        doc = parent_ref.set.call_args[0][0]
        self.assertEqual(doc["symbol_count"], 3)
        self.assertEqual(doc["active_count"], 1)
        self.assertEqual(doc["inactive_count"], 2)
        self.assertTrue(doc["symbol_details_in_subcollection"])
        self.assertEqual(doc["active_symbols"], ["AAA"])
        self.assertNotIn("symbols", doc)
        self.assertNotIn("inactive_symbols", doc)
        self.assertNotIn("symbol_details", doc)


if __name__ == "__main__":
    unittest.main()
