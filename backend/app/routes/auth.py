"""Authentication: institution signup, login, refresh, invites, password reset.

Rate limits are applied per-endpoint rather than globally. Login and the two
password-reset entry points are the ones worth throttling — a blanket default
limit would also throttle the teacher dashboard's polling, which is legitimate
traffic.

Two behaviours here are deliberate and easy to "fix" incorrectly later:

* ``/forgot-password`` always returns the same success response, whether or not
  the address exists. Otherwise the endpoint becomes a free account-enumeration
  oracle.
* ``/login`` returns one generic message for unknown-email, wrong-password and
  not-yet-activated. ``passwords.verify_password`` also runs a dummy bcrypt
  comparison when there is no stored hash, so the timing does not leak which case
  it was either.
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify
from flask_jwt_extended import create_access_token, create_refresh_token, jwt_required
from pymongo.errors import DuplicateKeyError

from .. import db
from ..auth import guards
from ..auth.passwords import PasswordTooLong, hash_password, verify_password
from ..config import Config
from ..extensions import limiter
from ..models.constants import (
    AuditAction,
    EnrollmentStatus,
    InviteType,
    Role,
    UserStatus,
)
from ..models.schemas import institution_doc, user_doc
from ..services import audit, email_templates, invites, mailer
from ..utils.errors import ApiError, bad_request, conflict, unauthorized
from ..utils.serialization import serialize_doc
from ..utils.timeutil import utcnow
from ..utils.tokens import (
    make_reset_token,
    read_reset_token,
    reset_token_matches_password,
)
from ..utils.validators import (
    body,
    clean_email,
    clean_name,
    clean_password,
    clean_slug,
    require,
    slugify,
)

log = logging.getLogger(__name__)

bp = Blueprint("auth", __name__, url_prefix="/api/auth")


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _issue_tokens(user) -> dict:
    """Mint an access/refresh pair.

    ``role`` and ``institution_id`` ride along as claims for the frontend's
    convenience only — every server-side authorisation check re-reads the user
    document (see ``auth/guards``), so a stale claim cannot grant access.
    """
    identity = str(user["_id"])
    claims = {
        "role": user.get("role"),
        "institution_id": str(user.get("institution_id")),
        "name": user.get("name"),
    }
    return {
        "access_token": create_access_token(identity=identity, additional_claims=claims),
        "refresh_token": create_refresh_token(identity=identity, additional_claims=claims),
        "token_type": "Bearer",
        "expires_in": int(Config.JWT_ACCESS_TOKEN_EXPIRES.total_seconds()),
    }


def _public_user(user, *, student=None, institution=None) -> dict:
    """The user shape the frontend consumes everywhere."""
    payload = {
        "id": str(user["_id"]),
        "email": user.get("email"),
        "name": user.get("name"),
        "role": user.get("role"),
        "status": user.get("status"),
        "institution_id": str(user.get("institution_id")),
    }
    if institution is not None:
        payload["institution"] = {
            "id": str(institution.get("_id")),
            "name": institution.get("name"),
            "slug": institution.get("slug"),
            "settings": institution.get("settings", {}),
        }
    if student is not None:
        payload["student"] = {
            "id": str(student["_id"]),
            "roll_number": student.get("roll_number"),
            "enrollment_status": student.get("enrollment_status"),
            "face_enrolled": bool(student.get("face_enrolled")),
            "voice_enrolled": bool(student.get("voice_enrolled")),
        }
    return payload


def _load_context(user) -> dict:
    institution = db.institutions().find_one({"_id": user.get("institution_id")})
    student = (
        db.students().find_one({"user_id": user["_id"]})
        if user.get("role") == Role.STUDENT
        else None
    )
    return _public_user(user, student=student, institution=institution)


def _unique_slug(base: str) -> str:
    """Find a free institution slug, appending -2, -3, ... on collision."""
    slug = base
    suffix = 2
    while db.institutions().count_documents({"slug": slug}, limit=1):
        slug = f"{base}-{suffix}"
        suffix += 1
        if suffix > 50:  # pragma: no cover - absurd collision count
            raise conflict("Could not generate a unique slug for that institution name")
    return slug


# --------------------------------------------------------------------------- #
# Institution signup (creates the first admin)
# --------------------------------------------------------------------------- #
@bp.post("/register-institution")
@limiter.limit("5 per hour; 20 per day")
def register_institution():
    """Create an institution and its owning admin account.

    This is the only self-service account creation in the product — every other
    account arrives by invite. The caller becomes the institution's admin.
    """
    data = body()
    require(data, "institution_name", "name", "email", "password")

    institution_name = clean_name(data["institution_name"], field="institution_name")
    admin_name = clean_name(data["name"])
    email = clean_email(data["email"])
    password = clean_password(data["password"])
    slug = (
        clean_slug(data["slug"])
        if data.get("slug")
        else _unique_slug(slugify(institution_name) or "institution")
    )

    if db.users().count_documents({"email": email}, limit=1):
        raise conflict("An account with that email address already exists.")

    try:
        password_hash = hash_password(password)
    except PasswordTooLong as exc:
        raise bad_request(str(exc))

    institution = institution_doc(name=institution_name, slug=slug)
    try:
        institution_id = db.institutions().insert_one(institution).inserted_id
    except DuplicateKeyError:
        raise conflict("That institution slug is already taken.")

    admin = user_doc(
        email=email,
        name=admin_name,
        role=Role.ADMIN,
        institution_id=institution_id,
        password_hash=password_hash,
        status=UserStatus.ACTIVE,
    )
    try:
        admin["_id"] = db.users().insert_one(admin).inserted_id
    except DuplicateKeyError:
        # Lost a race on the email index — roll back the institution so we do not
        # leave an orphan tenant with no owner.
        db.institutions().delete_one({"_id": institution_id})
        raise conflict("An account with that email address already exists.")

    db.institutions().update_one(
        {"_id": institution_id}, {"$set": {"owner_user_id": admin["_id"]}}
    )
    institution["_id"] = institution_id
    institution["owner_user_id"] = admin["_id"]

    audit.record(
        institution_id=institution_id,
        actor_id=admin["_id"],
        action=AuditAction.INSTITUTION_CREATED,
        target_id=institution_id,
        target_type="institution",
        new_state={"name": institution_name, "slug": slug},
    )

    subject, html = email_templates.admin_welcome(
        name=admin_name, institution=institution_name, slug=slug
    )
    mailer.send(email, subject, html)

    return (
        jsonify(
            {
                **_issue_tokens(admin),
                "user": _public_user(admin, institution=institution),
            }
        ),
        201,
    )


# --------------------------------------------------------------------------- #
# Login / refresh / me
# --------------------------------------------------------------------------- #
@bp.post("/login")
@limiter.limit("10 per minute; 60 per hour")
def login():
    data = body()
    require(data, "email", "password")
    email = clean_email(data["email"])
    password = str(data["password"])

    user = db.users().find_one({"email": email})
    # verify_password runs a bcrypt comparison even when user is None, so the
    # response time does not distinguish "no such account" from "wrong password".
    if not verify_password(password, (user or {}).get("password_hash")):
        log.info("Failed login attempt for %s", email)
        raise unauthorized("Incorrect email address or password.")

    if user.get("status") == UserStatus.DISABLED:
        raise ApiError(
            "This account has been disabled. Contact your administrator.",
            403,
            code="account_disabled",
        )
    if user.get("status") == UserStatus.INVITED:
        raise ApiError(
            "Finish setting up your account using the link in your invitation email.",
            403,
            code="account_not_activated",
        )

    db.users().update_one({"_id": user["_id"]}, {"$set": {"last_login_at": utcnow()}})
    return jsonify({**_issue_tokens(user), "user": _load_context(user)})


@bp.post("/refresh")
@jwt_required(refresh=True)
def refresh():
    """Exchange a refresh token for a new access token.

    The user document is re-read by the JWT user loader, so a disabled account
    cannot refresh its way into a fresh access token.
    """
    user = guards.current_user_doc()
    identity = str(user["_id"])
    claims = {
        "role": user.get("role"),
        "institution_id": str(user.get("institution_id")),
        "name": user.get("name"),
    }
    from flask_jwt_extended import create_access_token as _create

    return jsonify(
        {
            "access_token": _create(identity=identity, additional_claims=claims),
            "token_type": "Bearer",
            "expires_in": int(Config.JWT_ACCESS_TOKEN_EXPIRES.total_seconds()),
            "user": _load_context(user),
        }
    )


@bp.get("/me")
@guards.any_authenticated
def me():
    return jsonify({"user": _load_context(guards.current_user_doc())})


@bp.post("/logout")
@guards.any_authenticated
def logout():
    """No-op server side.

    JWTs are stateless and short-lived; the client discards them. A token
    denylist would need shared state (Redis or a Mongo collection checked on
    every request) for very little benefit at this scale — the access token
    expires in 30 minutes.
    """
    return jsonify({"ok": True, "message": "Signed out"})


@bp.post("/change-password")
@guards.any_authenticated
@limiter.limit("10 per hour")
def change_password():
    data = body()
    require(data, "current_password", "new_password")
    user = guards.current_user_doc()

    if not verify_password(str(data["current_password"]), user.get("password_hash")):
        raise unauthorized("Your current password is incorrect.")

    new_password = clean_password(data["new_password"], field="new_password")
    try:
        new_hash = hash_password(new_password)
    except PasswordTooLong as exc:
        raise bad_request(str(exc))

    db.users().update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": new_hash, "updated_at": utcnow()}},
    )
    audit.record(
        institution_id=user["institution_id"],
        actor_id=user["_id"],
        action=AuditAction.PASSWORD_RESET,
        target_id=user["_id"],
        target_type="user",
        metadata={"self_service": True},
    )
    return jsonify({"ok": True, "message": "Password updated"})


# --------------------------------------------------------------------------- #
# Password reset by email
# --------------------------------------------------------------------------- #
@bp.post("/forgot-password")
@limiter.limit("5 per hour; 20 per day")
def forgot_password():
    """Email a reset link. Always reports success (no account enumeration)."""
    data = body()
    require(data, "email")
    email = clean_email(data["email"])

    generic = {
        "ok": True,
        "message": "If that email address has an account, a reset link is on its way.",
    }

    user = db.users().find_one({"email": email})
    if not user or user.get("status") != UserStatus.ACTIVE or not user.get("password_hash"):
        # Invited-but-not-activated users get nothing here; their invite link is
        # the correct path and re-sending it is an admin action.
        log.info("Password reset requested for unusable account: %s", email)
        return jsonify(generic)

    token = make_reset_token(user_id=str(user["_id"]), password_hash=user["password_hash"])
    reset_url = f"{Config.FRONTEND_URL}/reset-password?token={token}"
    subject, html = email_templates.password_reset(
        name=user.get("name") or email, reset_url=reset_url
    )
    mailer.send(email, subject, html)

    if Config.MAIL_SUPPRESS_SEND:
        # Local dev convenience: without SMTP the link is otherwise only in the
        # server log. Never enabled when real mail is configured.
        generic["reset_url"] = reset_url
    return jsonify(generic)


@bp.post("/reset-password")
@limiter.limit("10 per hour")
def reset_password():
    data = body()
    require(data, "token", "password")
    payload = read_reset_token(str(data["token"]))
    new_password = clean_password(data["password"])

    from ..utils.serialization import oid

    user = db.users().find_one({"_id": oid(payload.get("user_id"))})
    if not user:
        raise ApiError("This reset link is no longer valid.", 400, code="token_invalid")
    # The token embeds a fingerprint of the password hash it was issued against,
    # which makes it single-use: once the password changes, the link dies.
    if not reset_token_matches_password(payload, user.get("password_hash")):
        raise ApiError(
            "This reset link has already been used. Request a new one.",
            400,
            code="token_used",
        )

    try:
        new_hash = hash_password(new_password)
    except PasswordTooLong as exc:
        raise bad_request(str(exc))

    db.users().update_one(
        {"_id": user["_id"]},
        {"$set": {"password_hash": new_hash, "updated_at": utcnow()}},
    )
    audit.record(
        institution_id=user["institution_id"],
        actor_id=user["_id"],
        action=AuditAction.PASSWORD_RESET,
        target_id=user["_id"],
        target_type="user",
        metadata={"via": "email_link"},
    )
    return jsonify({"ok": True, "message": "Password updated. You can now sign in."})


# --------------------------------------------------------------------------- #
# Invite acceptance (teachers and students)
# --------------------------------------------------------------------------- #
@bp.get("/invite")
@limiter.limit("30 per hour")
def read_invite():
    """Validate an invite token so the acceptance page can render context."""
    from flask import request

    token = request.args.get("token", "")
    if not token:
        raise bad_request("No invitation token was supplied")

    context = invites.load_invite(token)
    user = context["user"]
    return jsonify(
        {
            "email": user.get("email"),
            "name": user.get("name"),
            "role": user.get("role"),
            "invite_type": context["invite_type"],
            "institution": {
                "name": context["institution"].get("name"),
                "slug": context["institution"].get("slug"),
            },
            "needs_biometrics": context["invite_type"] == InviteType.STUDENT,
        }
    )


@bp.post("/accept-invite")
@limiter.limit("10 per hour")
def accept_invite():
    """Set a password from an invite link and sign the user in.

    Returning tokens immediately is what lets a student continue straight into
    face/voice capture without a second login step.
    """
    data = body()
    require(data, "token", "password")
    context = invites.load_invite(str(data["token"]))
    user = context["user"]
    invite = context["invite"]

    password = clean_password(data["password"])
    try:
        password_hash = hash_password(password)
    except PasswordTooLong as exc:
        raise bad_request(str(exc))

    # Allow correcting the display name at acceptance time — bulk CSV imports
    # often carry an abbreviated or misspelled name.
    if data.get("name"):
        new_name = clean_name(data["name"])
        db.users().update_one({"_id": user["_id"]}, {"$set": {"name": new_name}})
        user["name"] = new_name

    invites.activate_user(user_id=user["_id"], password_hash=password_hash)
    invites.mark_accepted(invite["_id"])

    audit.record(
        institution_id=user["institution_id"],
        actor_id=user["_id"],
        action=AuditAction.USER_ACTIVATED,
        target_id=user["_id"],
        target_type="user",
        previous_state={"status": UserStatus.INVITED},
        new_state={"status": UserStatus.ACTIVE},
    )

    fresh = db.users().find_one({"_id": user["_id"]})
    payload = {**_issue_tokens(fresh), "user": _load_context(fresh)}
    if fresh.get("role") == Role.STUDENT:
        payload["next_step"] = "biometrics"
        payload["enrollment_status"] = EnrollmentStatus.PENDING_BIOMETRICS
    return jsonify(payload), 201


@bp.get("/institution")
@guards.any_authenticated
def my_institution():
    """Institution metadata, readable by any signed-in member."""
    institution = db.institutions().find_one({"_id": guards.current_institution_id()})
    return jsonify({"institution": serialize_doc(institution)})
