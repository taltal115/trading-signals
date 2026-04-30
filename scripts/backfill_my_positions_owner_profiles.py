#!/usr/bin/env python3
"""Fill missing owner_email / owner_display_name on my_positions using Firebase Auth Admin."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT_DIR / "src"))

from dotenv import load_dotenv

from signals_bot.storage.firestore import MY_POSITIONS_COLLECTION, get_firestore_client


def _email_local(email: str) -> str:
    at = email.find("@")
    return email[:at] if at > 0 else email


def main() -> int:
    load_dotenv(override=False)
    try:
        import firebase_admin
        from firebase_admin import auth as fb_auth  # type: ignore[import-untyped]
    except ImportError:
        print("Install firebase-admin: pip install firebase-admin", file=sys.stderr)
        return 1

    p = argparse.ArgumentParser(
        description=(
            "Backfill owner_email (lowercase) and owner_display_name on my_positions from Firebase Auth."
        )
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Log actions only; do not write Firestore.",
    )
    args = p.parse_args()

    try:
        firebase_admin.get_app()
    except ValueError:
        firebase_admin.initialize_app()

    db = get_firestore_client()
    touched = 0
    scanned = 0
    missing_auth = 0

    for snap in db.collection(MY_POSITIONS_COLLECTION).stream():
        scanned += 1
        data = snap.to_dict() or {}
        if str(data.get("owner_email") or "").strip() and str(data.get("owner_display_name") or "").strip():
            continue
        uid = str(data.get("owner_uid") or "").strip()
        if not uid:
            continue
        try:
            record = fb_auth.get_user(uid)
        except fb_auth.UserNotFoundError:
            missing_auth += 1
            print(f"skip {snap.id}: no Firebase user for uid={uid}")
            continue
        email = str(record.email or "").strip().lower()
        disp = (
            str(record.display_name or "").strip()
            or _email_local(email)
            if email
            else uid[:12]
        )
        if args.dry_run:
            print(f"would patch {snap.id} owner_email={email!r} owner_display_name={disp!r}")
        else:
            snap.reference.set(
                {
                    "owner_email": email or None,
                    "owner_display_name": disp,
                },
                merge=True,
            )
            print(f"patched {snap.id}")
        touched += 1

    mode = "dry-run" if args.dry_run else "write"
    print(
        f"done ({mode}): scanned={scanned} patched={touched} missing_firebase_user={missing_auth}",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
