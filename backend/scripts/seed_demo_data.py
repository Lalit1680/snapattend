"""Create a demo institution with realistic history, for local development.

Running the app against an empty database means every screen is empty, which
makes the dashboard, the trend chart, and the defaulter list impossible to judge.
This script fills in four weeks of plausible attendance across three subjects so
those screens have something to render.

What it does *not* do is fabricate biometrics. Face and voice embeddings can only
come from real samples, and writing ``face_enrolled: True`` without a matching
vector in Chroma would produce a database that lies — the coverage endpoint would
promise matches the class-photo pipeline cannot deliver. Seeded students are left
un-enrolled; enroll one or two through the student portal to exercise that path.

Usage::

    python scripts/seed_demo_data.py
    python scripts/seed_demo_data.py --reset          # wipe and recreate
    python scripts/seed_demo_data.py --weeks 8
    python scripts/seed_demo_data.py --students 40

``--reset`` deletes only documents belonging to the demo institution, matched by
its slug. Other tenants in the same database are never touched.
"""
from __future__ import annotations

import argparse
import random
import sys
from datetime import timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from bson import ObjectId  # noqa: E402

from app import create_app  # noqa: E402
from app import db, vector_store  # noqa: E402
from app.auth.passwords import hash_password  # noqa: E402
from app.models import schemas  # noqa: E402
from app.models.constants import (  # noqa: E402
    AttendanceMethod,
    AttendanceStatus,
    EnrollmentStatus,
    PhotoReviewStatus,
    Role,
    SessionStatus,
    UserStatus,
    VerificationMode,
)
from app.utils.timeutil import utcnow  # noqa: E402

SLUG = "demo-university"
INSTITUTION_NAME = "Demo University"
DEMO_PASSWORD = "Password123!"  # nosec - local demo credentials, printed on stdout

ADMIN = ("admin@demo.edu", "Priya Raman")
TEACHERS = [
    ("teacher@demo.edu", "Arun Menon"),
    ("teacher2@demo.edu", "Sara Iqbal"),
]
SUBJECTS = [
    # name, code, teacher index, threshold override
    ("Data Structures", "CS201", 0, None),
    ("Operating Systems", "CS305", 0, 80.0),
    ("Linear Algebra", "MA102", 1, None),
]
FIRST_NAMES = [
    "Aditya", "Bhavna", "Chetan", "Divya", "Eshan", "Farah", "Gaurav", "Hina",
    "Ishan", "Jaya", "Kabir", "Lakshmi", "Manav", "Nisha", "Omar", "Pooja",
    "Rahul", "Sneha", "Tarun", "Uma", "Varun", "Wasim", "Yash", "Zara",
]
LAST_NAMES = [
    "Agarwal", "Bose", "Chandra", "Desai", "Iyer", "Joshi", "Kapoor", "Nair",
    "Patel", "Rao", "Sharma", "Verma",
]

# Each student gets one of these attendance profiles, which is what makes the
# analytics screens interesting: without a spread of behaviours the defaulter
# list is either empty or everyone.
PROFILES = (
    ("regular", 0.95, 0.45),
    ("typical", 0.85, 0.35),
    ("patchy", 0.70, 0.15),
    ("defaulter", 0.55, 0.05),
)
# How self-service check-ins split between QR and voice is decided per record in
# _method_for; see there.


def _reset(institution_id: ObjectId) -> None:
    """Delete every document belonging to this institution, and its vectors.

    Ordered child-first so a crash halfway through leaves no orphans pointing at
    a deleted parent. The Chroma pass matters as much as the Mongo one: dropping a
    student row while leaving their face vector behind would be exactly the kind
    of stranded biometric data the privacy rules exist to prevent.
    """
    scoped = {"institution_id": institution_id}

    student_ids = [
        str(s["_id"]) for s in db.students().find(scoped, {"_id": 1})
    ]
    for student_id in student_ids:
        vector_store.delete_student_embeddings(student_id)
    if student_ids:
        print(f"reset: purged vectors for {len(student_ids)} student(s)")

    for collection in (
        db.attendance_records(),
        db.pending_face_matches(),
        db.enrollments(),
        db.sessions(),
        db.subjects(),
        db.students(),
        db.invites(),
        db.alert_log(),
        db.audit_logs(),
        db.users(),
    ):
        collection.delete_many(scoped)
    db.institutions().delete_one({"_id": institution_id})
    print(f"reset: removed the existing '{SLUG}' institution and all its data")


def _make_user(email: str, name: str, role: str, institution_id: ObjectId) -> ObjectId:
    doc = schemas.user_doc(
        email=email.lower(),
        name=name,
        role=role,
        institution_id=institution_id,
        password_hash=hash_password(DEMO_PASSWORD),
        status=UserStatus.ACTIVE,
    )
    return db.users().insert_one(doc).inserted_id


def seed(*, weeks: int, student_count: int, reset: bool, seed_value: int) -> int:
    rng = random.Random(seed_value)  # reproducible: same data on every run

    existing = db.institutions().find_one({"slug": SLUG})
    if existing:
        if not reset:
            print(
                f"'{SLUG}' already exists (id {existing['_id']}).\n"
                f"Re-run with --reset to wipe and recreate it, or log in as "
                f"{ADMIN[0]} / {DEMO_PASSWORD}."
            )
            return 1
        _reset(existing["_id"])

    # --- Institution and staff --------------------------------------------
    institution_id = (
        db.institutions()
        .insert_one(schemas.institution_doc(name=INSTITUTION_NAME, slug=SLUG))
        .inserted_id
    )
    admin_id = _make_user(ADMIN[0], ADMIN[1], Role.ADMIN, institution_id)
    db.institutions().update_one(
        {"_id": institution_id}, {"$set": {"owner_user_id": admin_id}}
    )
    teacher_ids = [
        _make_user(email, name, Role.TEACHER, institution_id) for email, name in TEACHERS
    ]
    print(f"institution {INSTITUTION_NAME} ({institution_id})")
    print(f"  1 admin, {len(teacher_ids)} teachers")

    # --- Students ----------------------------------------------------------
    students: list[dict] = []
    used_emails: set[str] = set()
    for i in range(student_count):
        first = FIRST_NAMES[i % len(FIRST_NAMES)]
        last = LAST_NAMES[(i // len(FIRST_NAMES) + i) % len(LAST_NAMES)]
        name = f"{first} {last}"
        base = f"{first}.{last}".lower()
        email = f"{base}@demo.edu"
        if email in used_emails:  # two generated names collided
            email = f"{base}{i}@demo.edu"
        used_emails.add(email)

        user_id = _make_user(email, name, Role.STUDENT, institution_id)
        profile = PROFILES[i % len(PROFILES)]
        student_doc = schemas.student_doc(
            user_id=user_id,
            institution_id=institution_id,
            roll_number=f"2024{i + 1:03d}",
        )
        # Password is set, biometrics are not — the honest state for seeded data,
        # and the state the enrollment wizard expects to pick up from.
        student_doc["enrollment_status"] = EnrollmentStatus.PENDING_BIOMETRICS
        student_id = db.students().insert_one(student_doc).inserted_id
        students.append(
            {
                "_id": student_id,
                "name": name,
                "email": email,
                "profile": profile[0],
                "attend_rate": profile[1],
                "late_join_chance": profile[2],
            }
        )
    print(f"  {len(students)} students (password for everyone: {DEMO_PASSWORD})")

    # --- Subjects and rosters ---------------------------------------------
    subjects: list[dict] = []
    for name, code, teacher_index, threshold in SUBJECTS:
        subject_id = (
            db.subjects()
            .insert_one(
                schemas.subject_doc(
                    name=name,
                    code=code,
                    institution_id=institution_id,
                    teacher_ids=[teacher_ids[teacher_index]],
                    attendance_threshold=threshold,
                )
            )
            .inserted_id
        )
        # Not everyone takes everything — an 80% share per subject keeps the
        # rosters distinct so per-subject numbers actually differ.
        roster = [s for s in students if rng.random() < 0.8] or students[:]
        db.enrollments().insert_many(
            [
                schemas.enrollment_doc(
                    subject_id=subject_id,
                    student_id=s["_id"],
                    institution_id=institution_id,
                )
                for s in roster
            ]
        )
        subjects.append(
            {
                "_id": subject_id,
                "name": name,
                "code": code,
                "teacher_id": teacher_ids[teacher_index],
                "roster": roster,
            }
        )
        print(f"  subject {code} {name}: {len(roster)} students")

    # --- Historical sessions ----------------------------------------------
    now = utcnow()
    modes = VerificationMode.ALL
    total_sessions = 0
    total_records = 0

    for subject in subjects:
        # Two classes a week, walking backwards from a week ago so nothing
        # historical overlaps the open session created below.
        for week in range(weeks, 0, -1):
            for slot, hour in enumerate((10, 14)):
                start = (now - timedelta(weeks=week, days=slot)).replace(
                    hour=hour, minute=0, second=0, microsecond=0
                )
                end = start + timedelta(hours=1)
                mode = modes[(week + slot) % len(modes)]

                session = schemas.session_doc(
                    subject_id=subject["_id"],
                    teacher_id=subject["teacher_id"],
                    institution_id=institution_id,
                    verification_mode=mode,
                    start_time=start,
                    end_time=end,
                    title=None,
                )
                session["status"] = SessionStatus.ENDED
                session["ended_at"] = end
                session["created_at"] = start
                session["updated_at"] = end
                session_id = db.sessions().insert_one(session).inserted_id
                total_sessions += 1

                records = []
                for student in subject["roster"]:
                    # A student who joined the course late has no record at all
                    # for early sessions — this is what exercises the
                    # "denominator counts only sessions after they joined" rule.
                    if week > weeks - 2 and rng.random() < student["late_join_chance"]:
                        continue
                    present = rng.random() < student["attend_rate"]
                    if not present:
                        continue

                    method, confidence = _method_for(mode, rng)
                    record = schemas.attendance_record_doc(
                        session_id=session_id,
                        student_id=student["_id"],
                        subject_id=subject["_id"],
                        institution_id=institution_id,
                        method_used=method,
                        status=AttendanceStatus.PRESENT,
                        confidence_score=confidence,
                        was_manual_override=method == AttendanceMethod.MANUAL,
                        marked_by=(
                            subject["teacher_id"]
                            if method
                            in (AttendanceMethod.MANUAL, AttendanceMethod.FACE_PHOTO_REVIEW)
                            else None
                        ),
                    )
                    marked_at = start + timedelta(minutes=rng.randint(1, 20))
                    record["timestamp"] = marked_at
                    record["updated_at"] = marked_at
                    if method == AttendanceMethod.MANUAL:
                        record["override_reason"] = "Arrived late, verified in person"
                    records.append(record)

                if records:
                    db.attendance_records().insert_many(records)
                    total_records += len(records)

                if mode in (VerificationMode.CLASS_PHOTO, VerificationMode.CLASS_PHOTO_QR):
                    # Photo stats only; the photo itself was never stored.
                    db.sessions().update_one(
                        {"_id": session_id},
                        {
                            "$set": {
                                "photo_processed_at": start + timedelta(minutes=5),
                                "photo_review_status": PhotoReviewStatus.RESOLVED,
                                "photo_stats": {
                                    "faces_detected": len(records) + rng.randint(0, 2),
                                    "auto_matched": len(records),
                                    "needs_review": 0,
                                },
                            }
                        },
                    )

    print(f"  {total_sessions} past sessions, {total_records} attendance records")

    # --- One session left open, so the live view has something to show -----
    open_subject = subjects[0]
    open_session = schemas.session_doc(
        subject_id=open_subject["_id"],
        teacher_id=open_subject["teacher_id"],
        institution_id=institution_id,
        verification_mode=VerificationMode.CLASS_PHOTO_QR,
        start_time=now - timedelta(minutes=10),
        end_time=now + timedelta(minutes=50),
        title="Live demo session",
    )
    open_session_id = db.sessions().insert_one(open_session).inserted_id
    print(
        f"  1 open session ({open_subject['code']}, mode class_photo_qr, "
        f"id {open_session_id})"
    )

    _print_next_steps(open_session_id)
    return 0


def _method_for(mode: str, rng: random.Random) -> tuple[str, float | None]:
    """Pick a plausible ``method_used`` (and confidence) for a session's mode.

    The occasional manual override and review-queue assignment are deliberate:
    they are what makes the audit log and the ``/analytics/methods`` breakdown
    show something other than a single bar.
    """
    roll = rng.random()
    if mode == VerificationMode.CLASS_PHOTO:
        if roll < 0.05:
            return AttendanceMethod.MANUAL, None
        if roll < 0.15:
            return AttendanceMethod.FACE_PHOTO_REVIEW, round(rng.uniform(0.60, 0.80), 3)
        return AttendanceMethod.FACE_PHOTO, round(rng.uniform(0.82, 0.99), 3)
    if mode == VerificationMode.QR:
        return (AttendanceMethod.MANUAL, None) if roll < 0.05 else (AttendanceMethod.QR, None)
    if mode == VerificationMode.VOICE:
        if roll < 0.05:
            return AttendanceMethod.MANUAL, None
        return AttendanceMethod.VOICE, round(rng.uniform(0.78, 0.98), 3)
    # Combined mode: the photo carries most of the class, QR mops up.
    if roll < 0.04:
        return AttendanceMethod.MANUAL, None
    if roll < 0.25:
        return AttendanceMethod.QR, None
    return AttendanceMethod.FACE_PHOTO, round(rng.uniform(0.82, 0.99), 3)


def _print_next_steps(open_session_id: ObjectId) -> None:
    print(
        f"""
done. sign in at the frontend with any of:

  admin    {ADMIN[0]}
  teacher  {TEACHERS[0][0]}   (Data Structures, Operating Systems)
  teacher  {TEACHERS[1][0]}  (Linear Algebra)
  student  <firstname>.<lastname>@demo.edu   e.g. aditya.agarwal@demo.edu

  password for every account: {DEMO_PASSWORD}

next steps to exercise the biometric paths, which this script cannot seed:

  1. sign in as a student and complete face + voice enrollment in the portal
     (2-3 webcam frames and one passphrase recording)
  2. sign in as {TEACHERS[0][0]} and open session {open_session_id}
  3. upload a photo containing that student's face -> they should auto-match,
     and any unrecognised face lands in the review queue

seeded students are intentionally left un-enrolled: an embedding cannot be
invented, and a face_enrolled flag with no vector behind it would make the
coverage report wrong."""
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--reset", action="store_true", help="wipe the demo institution first")
    parser.add_argument("--weeks", type=int, default=4, help="weeks of history (default 4)")
    parser.add_argument("--students", type=int, default=24, help="student count (default 24)")
    parser.add_argument("--seed", type=int, default=42, help="RNG seed (default 42)")
    args = parser.parse_args()

    if args.weeks < 1 or args.students < 1:
        parser.error("--weeks and --students must be at least 1")

    app = create_app()
    with app.app_context():
        if not db.ping():
            print(
                "Cannot reach MongoDB. Check MONGODB_URI in backend/.env "
                "(see .env.example) and that your Atlas IP allow-list includes "
                "this machine."
            )
            return 1
        return seed(
            weeks=args.weeks,
            student_count=args.students,
            reset=args.reset,
            seed_value=args.seed,
        )


if __name__ == "__main__":
    sys.exit(main())
