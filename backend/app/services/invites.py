"""Email-based onboarding: teacher invites and student self-enrollment invites.

Every account in SnapAttend is created by a targeted invite — there is no public
signup link or shared enrollment QR. That is a product requirement (institution
membership stays controlled and traceable) and it shapes this module:

* A ``users`` row is created **at invite time**, in ``INVITED`` status with no
  password. This lets a teacher add students to a roster before those students
  have accepted, which is how bulk import needs to work.
* The invite row stores only the token's SHA-256, so the database is not a
  source of working invite links.
* Re-inviting revokes the previous token rather than issuing a second live one,
  so exactly one link per person is ever valid.
"""
from __future__ import annotations

import logging
from typing import Mapping, Optional, Sequence

from bson import ObjectId
from pymongo.errors import DuplicateKeyError

from .. import db
from ..config import Config
from ..models.constants import (
    AuditAction,
    EnrollmentStatus,
    InviteStatus,
    InviteType,
    Role,
    UserStatus,
)
from ..models.schemas import invite_doc, student_doc, user_doc
from ..utils.errors import ApiError, conflict
from ..utils.timeutil import in_seconds, utcnow
from ..utils.tokens import make_invite_token, read_invite_token, token_fingerprint
from . import audit, email_templates, mailer

log = logging.getLogger(__name__)


def _invite_url(token: str, invite_type: str) -> str:
    """Teachers and students land on different flows.

    A teacher only needs to set a password; a student continues into face/voice
    capture, so their link points at the enrollment wizard instead.
    """
    path = "/enroll" if invite_type == InviteType.STUDENT else "/accept-invite"
    return f"{Config.FRONTEND_URL}{path}?token={token}"


# --------------------------------------------------------------------------- #
# Creating invites
# --------------------------------------------------------------------------- #
def _find_or_create_user(
    *,
    email: str,
    name: str,
    role: str,
    institution_id: ObjectId,
) -> tuple[Mapping, bool]:
    """Return ``(user, created)`` for an invitee.

    Re-inviting someone who exists but has not yet activated is normal (the first
    email got lost). Re-inviting an *active* account is a conflict — we will not
    quietly hand out a password-setting link for a live account.
    """
    existing = db.users().find_one({"email": email})
    if existing:
        if str(existing.get("institution_id")) != str(institution_id):
            # Users belong to exactly one institution; there is no cross-tenant
            # membership in this model.
            raise conflict(
                "That email address already belongs to a different institution on SnapAttend."
            )
        if existing.get("status") == UserStatus.ACTIVE:
            raise conflict(f"{email} already has an active account.")
        if existing.get("role") != role:
            raise conflict(
                f"{email} was already invited as a {existing.get('role')}. "
                f"Revoke that invitation before re-inviting them as a {role}."
            )
        return existing, False

    doc = user_doc(
        email=email,
        name=name,
        role=role,
        institution_id=institution_id,
        password_hash=None,
        status=UserStatus.INVITED,
    )
    try:
        result = db.users().insert_one(doc)
    except DuplicateKeyError:
        # Lost a race against a concurrent invite for the same address.
        again = db.users().find_one({"email": email})
        if again:
            return again, False
        raise conflict(f"Could not create an account for {email}.")
    doc["_id"] = result.inserted_id
    return doc, True


def _revoke_outstanding(email: str, institution_id: ObjectId) -> None:
    db.invites().update_many(
        {
            "email": email,
            "institution_id": institution_id,
            "status": InviteStatus.PENDING,
        },
        {"$set": {"status": InviteStatus.REVOKED, "revoked_at": utcnow()}},
    )


def create_invite(
    *,
    email: str,
    name: str,
    role: str,
    institution_id: ObjectId,
    invited_by: Optional[ObjectId],
    send_email: bool = True,
) -> dict:
    """Create (or refresh) an invite and queue the email.

    Returns ``{user_id, email, name, invite_id, created_user, invite_url}``. The
    URL is returned so that a dev without SMTP configured can still complete the
    flow from the API response — it is never shown to other users.
    """
    invite_type = InviteType.STUDENT if role == Role.STUDENT else InviteType.TEACHER
    user, created_user = _find_or_create_user(
        email=email, name=name, role=role, institution_id=institution_id
    )
    user_id: ObjectId = user["_id"]

    if role == Role.STUDENT:
        _ensure_student_profile(user_id=user_id, institution_id=institution_id)

    _revoke_outstanding(email, institution_id)

    token = make_invite_token(
        email=email, institution_id=str(institution_id), invite_type=invite_type
    )
    doc = invite_doc(
        email=email,
        institution_id=institution_id,
        invite_type=invite_type,
        token_hash=token_fingerprint(token),
        invited_by=invited_by,
        user_id=user_id,
        expires_at=in_seconds(Config.INVITE_TOKEN_MAX_AGE_SECONDS),
    )
    invite_id = db.invites().insert_one(doc).inserted_id

    institution = db.institutions().find_one({"_id": institution_id}) or {}
    institution_name = institution.get("name", "your institution")
    url = _invite_url(token, invite_type)

    if send_email:
        inviter = db.users().find_one({"_id": invited_by}) if invited_by else None
        if invite_type == InviteType.STUDENT:
            subject, html = email_templates.student_invite(
                name=user.get("name", name), institution=institution_name, invite_url=url
            )
        else:
            subject, html = email_templates.teacher_invite(
                name=user.get("name", name),
                institution=institution_name,
                invite_url=url,
                inviter_name=(inviter or {}).get("name"),
            )
        mailer.send(email, subject, html)

    audit.record(
        institution_id=institution_id,
        actor_id=invited_by,
        action=AuditAction.USER_INVITED,
        target_id=user_id,
        target_type="user",
        new_state={"email": email, "role": role, "status": UserStatus.INVITED},
        metadata={"invite_id": str(invite_id), "invite_type": invite_type},
    )

    return {
        "user_id": user_id,
        "email": email,
        "name": user.get("name", name),
        "invite_id": invite_id,
        "created_user": created_user,
        "invite_url": url,
    }


def _ensure_student_profile(*, user_id: ObjectId, institution_id: ObjectId) -> ObjectId:
    """Create the ``students`` row for a user if it does not exist yet."""
    existing = db.students().find_one({"user_id": user_id}, {"_id": 1})
    if existing:
        return existing["_id"]
    doc = student_doc(user_id=user_id, institution_id=institution_id)
    try:
        return db.students().insert_one(doc).inserted_id
    except DuplicateKeyError:
        again = db.students().find_one({"user_id": user_id}, {"_id": 1})
        if again:
            return again["_id"]
        raise


def bulk_invite_students(
    *,
    rows: Sequence[Mapping],
    institution_id: ObjectId,
    invited_by: Optional[ObjectId],
) -> dict:
    """Invite many students, reporting per-row outcomes.

    Partial success is the whole point: one duplicate email in a 200-row CSV must
    not discard the other 199 students.
    """
    invited: list[dict] = []
    skipped: list[dict] = []

    for row in rows:
        email = str(row.get("email", "")).strip().lower()
        name = str(row.get("name", "")).strip() or email.split("@")[0]
        try:
            result = create_invite(
                email=email,
                name=name,
                role=Role.STUDENT,
                institution_id=institution_id,
                invited_by=invited_by,
            )
            invited.append({"email": email, "name": name, "student_user_id": str(result["user_id"])})
        except ApiError as exc:
            skipped.append({"email": email, "reason": exc.message})
        except Exception as exc:  # pragma: no cover - unexpected per-row failure
            log.error("Bulk invite failed for %s: %s", email, exc, exc_info=True)
            skipped.append({"email": email, "reason": "Unexpected error creating this invite"})

    return {"invited": invited, "skipped": skipped, "invited_count": len(invited)}


def resend(invite_or_user_email: str, *, institution_id: ObjectId, actor_id: ObjectId) -> dict:
    """Reissue an invite for someone who has not activated yet."""
    user = db.users().find_one({"email": invite_or_user_email, "institution_id": institution_id})
    if not user:
        raise ApiError("No pending invitation found for that email address.", 404)
    if user.get("status") == UserStatus.ACTIVE:
        raise conflict("That account is already active.")
    return create_invite(
        email=user["email"],
        name=user.get("name", user["email"]),
        role=user.get("role", Role.STUDENT),
        institution_id=institution_id,
        invited_by=actor_id,
    )


def revoke(*, user_id: ObjectId, institution_id: ObjectId, actor_id: ObjectId) -> None:
    """Cancel an outstanding invite and remove the placeholder account."""
    user = db.users().find_one({"_id": user_id, "institution_id": institution_id})
    if not user:
        raise ApiError("User not found", 404)
    if user.get("status") == UserStatus.ACTIVE:
        raise conflict("That account is already active; disable it instead of revoking.")

    _revoke_outstanding(user["email"], institution_id)
    # Remove the placeholder rows. Roster entries referencing this student go too,
    # otherwise a class would list a student who can never exist.
    student = db.students().find_one({"user_id": user_id}, {"_id": 1})
    if student:
        db.enrollments().delete_many({"student_id": student["_id"]})
        db.students().delete_one({"_id": student["_id"]})
    db.users().delete_one({"_id": user_id})

    audit.record(
        institution_id=institution_id,
        actor_id=actor_id,
        action=AuditAction.USER_INVITE_REVOKED,
        target_id=user_id,
        target_type="user",
        previous_state={"email": user["email"], "status": user.get("status")},
        new_state=None,
    )


# --------------------------------------------------------------------------- #
# Accepting invites
# --------------------------------------------------------------------------- #
def load_invite(token: str) -> dict:
    """Validate an invite token and return context for the acceptance screen.

    Checks the signature/expiry *and* that the stored invite row is still pending
    — so revoking an invite genuinely kills the link even though the signature
    would still verify.
    """
    payload = read_invite_token(token)
    fingerprint = token_fingerprint(token)
    invite = db.invites().find_one({"token_hash": fingerprint})

    if not invite:
        raise ApiError("This invitation link is not recognised.", 400, code="token_invalid")
    if invite.get("status") == InviteStatus.ACCEPTED:
        raise ApiError(
            "This invitation has already been used. Try signing in instead.",
            409,
            code="invite_used",
        )
    if invite.get("status") == InviteStatus.REVOKED:
        raise ApiError(
            "This invitation was cancelled. Ask your administrator for a new one.",
            400,
            code="invite_revoked",
        )

    user = db.users().find_one({"_id": invite.get("user_id")})
    if not user:
        raise ApiError("The account for this invitation no longer exists.", 404)
    if str(payload.get("email", "")).lower() != str(user.get("email", "")).lower():
        # Signature valid but bound to a different address: refuse rather than
        # trust the database row over the signed payload.
        raise ApiError("This invitation link is not valid.", 400, code="token_invalid")

    institution = db.institutions().find_one({"_id": invite.get("institution_id")}) or {}
    return {
        "invite": invite,
        "user": user,
        "institution": institution,
        "invite_type": invite.get("invite_type"),
    }


def mark_accepted(invite_id: ObjectId) -> None:
    db.invites().update_one(
        {"_id": invite_id},
        {"$set": {"status": InviteStatus.ACCEPTED, "accepted_at": utcnow()}},
    )


def activate_user(*, user_id: ObjectId, password_hash: str) -> None:
    """Flip an invited placeholder into a real, signed-in-able account."""
    db.users().update_one(
        {"_id": user_id},
        {
            "$set": {
                "password_hash": password_hash,
                "status": UserStatus.ACTIVE,
                "updated_at": utcnow(),
            }
        },
    )
    # Students still owe us biometrics before they are fully enrolled.
    db.students().update_one(
        {"user_id": user_id, "enrollment_status": EnrollmentStatus.INVITED},
        {"$set": {"enrollment_status": EnrollmentStatus.PENDING_BIOMETRICS, "updated_at": utcnow()}},
    )
