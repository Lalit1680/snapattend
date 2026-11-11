"""Domain enums, and the contract that the frontend mirrors them exactly.

``frontend/src/lib/constants.js`` duplicates these enums by hand, and says so:
"Keep the two files in step -- the backend is the source of truth." Nothing
enforced that until this file. A rename here without a matching rename there is a
breaking change that otherwise shows up as a filter that quietly matches nothing.

The frontend checks parse ``constants.js`` as text rather than running it, since
there is no JS runtime in the test environment. They skip cleanly when the
frontend is absent, so a backend-only deployment can still run the suite.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.models.constants import (
    AttendanceMethod,
    AttendanceStatus,
    AuditAction,
    EnrollmentStatus,
    InviteStatus,
    InviteType,
    PhotoReviewStatus,
    ReviewReason,
    ReviewResolution,
    Role,
    SessionStatus,
    UserStatus,
    VerificationMode,
)
from app.utils.errors import ApiError

BACKEND_DIR = Path(__file__).resolve().parent.parent
APP_DIR = BACKEND_DIR / "app"
FRONTEND_CONSTANTS = BACKEND_DIR.parent / "frontend" / "src" / "lib" / "constants.js"

#: Enums that exist on both sides and must agree value-for-value. ``InviteType``
#: and ``AuditAction`` are deliberately absent: the frontend never compares
#: against them, so mirroring them would be dead code to keep in step.
MIRRORED = [
    "Role",
    "UserStatus",
    "EnrollmentStatus",
    "VerificationMode",
    "SessionStatus",
    "PhotoReviewStatus",
    "AttendanceMethod",
    "AttendanceStatus",
    "ReviewReason",
    "ReviewResolution",
    "InviteStatus",
]

BACKEND_CLASSES = {
    "Role": Role,
    "UserStatus": UserStatus,
    "EnrollmentStatus": EnrollmentStatus,
    "VerificationMode": VerificationMode,
    "SessionStatus": SessionStatus,
    "PhotoReviewStatus": PhotoReviewStatus,
    "AttendanceMethod": AttendanceMethod,
    "AttendanceStatus": AttendanceStatus,
    "ReviewReason": ReviewReason,
    "ReviewResolution": ReviewResolution,
    "InviteStatus": InviteStatus,
}


requires_frontend = pytest.mark.skipif(
    not FRONTEND_CONSTANTS.exists(),
    reason="frontend/ is not present in this checkout",
)


def _py_enum(cls) -> set[str]:
    """The string values a constants class declares.

    Skips ``ALL``/``STAFF`` (tuples) and ``LABELS`` (a dict) by type rather than by
    name, so a new grouping attribute does not have to be added here.
    """
    return {v for k, v in vars(cls).items() if not k.startswith("_") and isinstance(v, str)}


def _js_enum(name: str) -> set[str]:
    source = FRONTEND_CONSTANTS.read_text(encoding="utf-8")
    match = re.search(rf"export const {name} = \{{(.*?)\n\}};", source, re.S)
    assert match, f"{name} is not exported from {FRONTEND_CONSTANTS.name}"
    return set(re.findall(r"'([^']*)'", match.group(1)))


# --------------------------------------------------------------------------- #
# Backend-internal invariants
# --------------------------------------------------------------------------- #
def test_role_all_lists_every_role():
    assert set(Role.ALL) == _py_enum(Role)
    assert len(Role.ALL) == 3


def test_staff_is_admin_and_teacher_but_not_student():
    # `require_staff` is built on this; a student slipping in would be able to
    # create sessions for a subject they attend.
    assert set(Role.STAFF) == {Role.ADMIN, Role.TEACHER}
    assert Role.STUDENT not in Role.STAFF


def test_verification_mode_all_and_labels_cover_the_same_modes():
    assert set(VerificationMode.ALL) == _py_enum(VerificationMode)
    assert set(VerificationMode.LABELS) == set(VerificationMode.ALL)


@pytest.mark.parametrize(
    ("mode", "photo", "qr", "voice", "self_service"),
    [
        (VerificationMode.CLASS_PHOTO, True, False, False, False),
        (VerificationMode.QR, False, True, False, True),
        (VerificationMode.VOICE, False, False, True, True),
        (VerificationMode.CLASS_PHOTO_QR, True, True, False, True),
    ],
)
def test_the_mode_capability_truth_table(mode, photo, qr, voice, self_service):
    """The asymmetry the brief calls out, written out in full.

    ``class_photo`` is a teacher-driven bulk action with nothing for a student to
    do; ``class_photo_qr`` adds the student-facing fallback. Every "should this
    student see a check-in button" decision in the app comes from these four rows,
    and ``modeIncludes*`` in ``constants.js`` reimplements them.
    """
    assert VerificationMode.includes_photo(mode) is photo
    assert VerificationMode.includes_qr(mode) is qr
    assert VerificationMode.includes_voice(mode) is voice
    assert VerificationMode.student_self_service(mode) is self_service


@pytest.mark.parametrize("mode", ["", None, "face", "class_photo_voice"])
def test_the_mode_helpers_say_no_to_an_unknown_mode(mode):
    # They are called with whatever a session document holds, including one
    # written by an older version of the app.
    assert VerificationMode.includes_photo(mode) is False
    assert VerificationMode.includes_qr(mode) is False
    assert VerificationMode.includes_voice(mode) is False
    assert VerificationMode.student_self_service(mode) is False


def test_attendance_method_all_lists_every_method():
    assert set(AttendanceMethod.ALL) == _py_enum(AttendanceMethod)
    assert len(AttendanceMethod.ALL) == 5


def test_manual_is_a_distinct_method_from_the_automatic_ones():
    # A report has to be able to say "this row was a teacher override", so manual
    # can never be folded into the method that it replaced.
    assert AttendanceMethod.MANUAL not in (
        AttendanceMethod.FACE_PHOTO,
        AttendanceMethod.FACE_PHOTO_REVIEW,
        AttendanceMethod.VOICE,
        AttendanceMethod.QR,
    )


@pytest.mark.parametrize("name", sorted(BACKEND_CLASSES))
def test_no_enum_reuses_a_value_for_two_names(name):
    cls = BACKEND_CLASSES[name]
    values = [v for k, v in vars(cls).items() if not k.startswith("_") and isinstance(v, str)]
    assert len(values) == len(set(values)), f"{name} has a duplicated value"


def test_invite_status_has_no_expired_state():
    """Load-bearing absence.

    Nothing sweeps the collection, so a lapsed invitation stays ``pending`` with
    ``expires_at`` in the past. ``GET /api/admin/invites?status=…`` passes the value
    straight into a Mongo query, so adding ``expired`` here without also writing it
    somewhere would create a filter that can only ever return an empty list — which
    is exactly the bug the frontend's ``derived:expired`` pseudo-filter replaced.
    """
    assert _py_enum(InviteStatus) == {"pending", "accepted", "revoked"}


def test_invite_type_matches_the_two_invite_flows():
    assert _py_enum(InviteType) == {"teacher", "student"}


def test_audit_actions_are_namespaced_and_unique():
    actions = _py_enum(AuditAction)
    # Every action is `subject.verb`. `humanizeAction` in `frontend/src/lib/format.js`
    # turns that into a label by replacing `.` and `_` with spaces, so one without a
    # separator would render as a single run-on word in the audit log.
    assert all("." in action for action in actions)
    declared = [v for k, v in vars(AuditAction).items() if not k.startswith("_") and isinstance(v, str)]
    # Two names sharing a value would make the log ambiguous about what happened.
    assert len(actions) == len(declared)


# --------------------------------------------------------------------------- #
# Frontend mirror
# --------------------------------------------------------------------------- #
@requires_frontend
@pytest.mark.parametrize("name", MIRRORED)
def test_the_frontend_mirrors_this_enum_exactly(name):
    backend = _py_enum(BACKEND_CLASSES[name])
    frontend = _js_enum(name)
    assert frontend == backend, (
        f"{name} has drifted: only in backend {sorted(backend - frontend)}, "
        f"only in frontend {sorted(frontend - backend)}"
    )


@requires_frontend
def test_the_frontend_mode_labels_match_the_backend_ones():
    source = FRONTEND_CONSTANTS.read_text(encoding="utf-8")
    block = re.search(r"export const MODE_LABELS = \{(.*?)\n\};", source, re.S)
    assert block, "MODE_LABELS is not exported from constants.js"
    # `[VerificationMode.CLASS_PHOTO]: 'Class Photo only',` -> the label only.
    labels = set(re.findall(r"\]: '([^']*)'", block.group(1)))
    assert labels == set(VerificationMode.LABELS.values())


@requires_frontend
def test_scan_reasons_match_the_literals_the_scan_endpoint_returns():
    """``ScanReason`` is not an error enum, so nothing on the backend declares it.

    The values live as bare literals in ``routes/public.py``, which is why this
    reads them out of the source rather than importing a class.
    """
    public_py = (APP_DIR / "routes" / "public.py").read_text(encoding="utf-8")
    served = set(re.findall(r'"reason":\s*"([a-z_]+)"', public_py))
    assert _js_enum("ScanReason") == served


@requires_frontend
def test_every_frontend_error_code_can_actually_be_raised():
    """A code the UI branches on but the backend never emits is dead code, and the
    branch it guards is unreachable — usually a silent failure to handle the case
    the author thought they were handling.
    """
    emitted = {
        ApiError._default_code(status)
        for status in range(400, 600)
        if ApiError._default_code(status) != "error"
    }
    for path in APP_DIR.rglob("*.py"):
        emitted.update(re.findall(r"""code=["']([a-z_]+)["']""", path.read_text(encoding="utf-8")))

    unraisable = _js_enum("ErrorCode") - emitted
    assert not unraisable, f"the UI handles codes nothing raises: {sorted(unraisable)}"

