"""Send low-attendance email alerts. Intended to run once a day.

The brief calls for "a simple scheduled check (a periodic script/cron-style
function is fine — don't over-build a task queue for this)", so this is a plain
script driven by the operating system's scheduler rather than a broker.

Cron (Linux/macOS) — every day at 07:00::

    0 7 * * * cd /srv/snapattend/backend && /srv/snapattend/venv/bin/python \\
        scripts/send_low_attendance_alerts.py >> /var/log/snapattend-alerts.log 2>&1

Task Scheduler (Windows): create a Basic Task, action "Start a program",
program ``C:\\path\\to\\venv\\Scripts\\python.exe``, arguments
``scripts\\send_low_attendance_alerts.py``, start-in ``C:\\path\\to\\backend``.

Always try ``--dry-run`` first: it does the whole calculation and prints who
*would* be emailed without sending anything or writing the cooldown log.

The per-institution threshold, the cooldown between repeat alerts, and the
minimum number of sessions before a student can be flagged all live in the
service layer (``app/services/alerts.py``) — this file is only the entry point.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app import create_app  # noqa: E402
from app.services import alerts, mailer  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="calculate and report, but send no email and record no cooldown",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="print only the summary line (useful when appending to a log)",
    )
    args = parser.parse_args()

    # An app context is required: the service layer reads config and the mailer
    # needs the Flask-Mail extension initialised.
    app = create_app()
    with app.app_context():
        results = alerts.run_all(dry_run=args.dry_run)

        total_sent = 0
        total_skipped = 0
        failures = 0

        for result in results:
            name = result.get("institution") or "(unnamed)"
            if result.get("error"):
                failures += 1
                print(f"ERROR  {name}: {result['error']}")
                continue

            sent = result.get("sent") or []
            skipped = result.get("skipped") or []
            total_sent += len(sent)
            total_skipped += len(skipped)

            if args.quiet:
                continue

            print(
                f"\n{name}: {result.get('candidates', 0)} below threshold, "
                f"{len(sent)} alert(s), {len(skipped)} skipped "
                f"(cooldown {result.get('cooldown_days')}d, "
                f"min {result.get('min_sessions')} sessions)"
            )
            for row in sent:
                print(
                    f"    -> {row.get('email')}  {row.get('subject')}  "
                    f"{row.get('percentage')}%"
                )
            for row in skipped:
                print(
                    f"    -- {row.get('student_id')}  {row.get('subject')}: "
                    f"{row.get('reason')}"
                )

        prefix = "DRY RUN: would send" if args.dry_run else "sent"
        print(
            f"\n{prefix} {total_sent} alert(s) across {len(results)} institution(s); "
            f"{total_skipped} skipped, {failures} failed"
        )

        # The mail queue is a background thread; without this the process can exit
        # with messages still queued. run_all() is synchronous, so by the time we
        # get here every send has been enqueued — we just need to let it drain.
        if not args.dry_run and total_sent:
            mailer.flush(timeout=60)
            remaining = mailer.pending_count()
            if remaining:
                print(f"WARNING: {remaining} message(s) still queued after 60s")
                failures += 1

    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
