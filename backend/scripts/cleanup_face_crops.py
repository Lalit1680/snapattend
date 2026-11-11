"""Force-delete expired review-queue face crops, and report retention state.

This is a *backstop*, not the primary mechanism. Face crops carry an
``expires_at`` field and the collection has a TTL index, so MongoDB deletes them
on its own roughly once a minute; ending a session deletes that session's crops
immediately. This script exists for two cases:

* a deployment where the TTL index failed to create (``/healthz`` will say so),
* an operator who wants to prove the retention rule holds right now.

The brief's privacy requirement is non-negotiable: no raw biometric files are
persisted. Class photos are never written anywhere, enrollment frames are
discarded after embedding, and review-queue crops live only until the teacher
resolves the queue or the TTL expires. ``--report`` prints the numbers that
demonstrate it.

Optional daily run::

    30 3 * * * cd /srv/snapattend/backend && /srv/snapattend/venv/bin/python \\
        scripts/cleanup_face_crops.py

Usage::

    python scripts/cleanup_face_crops.py             # sweep, then report
    python scripts/cleanup_face_crops.py --report    # report only, delete nothing
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.services import face_crop_store  # noqa: E402

# Keys that must be zero for the privacy guarantee to hold, mapped to what a
# non-zero value would mean. Printed as a verdict rather than left to the reader.
INVARIANTS = {
    "resolved_but_crop_retained": "a resolved review item is still holding its crop",
    "class_photos_stored": "an uploaded class photo was persisted",
    "enrollment_images_stored": "a raw enrollment frame was persisted",
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--report",
        action="store_true",
        help="print retention state only; do not delete anything",
    )
    args = parser.parse_args()

    app = create_app()
    with app.app_context():
        if not args.report:
            deleted = face_crop_store.sweep_expired()
            print(f"swept {deleted} expired review item(s)")

        report = face_crop_store.privacy_report()
        print("\nretention state")
        print("---------------")
        for key, value in report.items():
            print(f"  {key:32} {value}")

        violations = [
            f"{key}={report[key]} — {why}"
            for key, why in INVARIANTS.items()
            if report.get(key)
        ]
        if violations:
            print("\nPRIVACY INVARIANT VIOLATED:")
            for violation in violations:
                print(f"  - {violation}")
            return 1

        unresolved = report.get("unresolved_items", 0)
        if unresolved:
            print(
                f"\nok — {unresolved} crop(s) retained for review queues still open. "
                f"These expire automatically after "
                f"{report.get('crop_ttl_hours')}h or when the session ends."
            )
        else:
            print("\nok — no face crops are being retained.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
