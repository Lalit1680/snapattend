"""Route guards and tenant scoping.

Two invariants are enforced here, and they are the backbone of the security
model:

1. **Role gates.** ``@role_required(Role.TEACHER, Role.ADMIN)`` wraps
   ``jwt_required()`` so a route can never accidentally be authenticated but
   unauthorised.

2. **Institution scoping.** Every tenant-scoped query is built through
   :func:`scope`, which injects the caller's ``institution_id``. Route code that
   forgets to scope a query is the single most likely way to leak cross-tenant
   data, so the helper makes the scoped path the *easy* path and
   :func:`assert_same_institution` acts as a second line of defence on documents
   fetched by id.

The JWT carries ``role`` and ``institution_id`` as claims for convenience, but
authorisation decisions read the **freshly-loaded user document** instead. That
way disabling an account or changing a role takes effect on the next request
rather than whenever the access token happens to expire.
"""
from __future__ import annotations

import functools
import logging
from typing import Any, Callable, Iterable, Mapping

from bson import ObjectId
from flask import g
from flask_jwt_extended import current_user, jwt_required, verify_jwt_in_request

from .. import db
from ..models.constants import Role, UserStatus
from ..utils.errors import ApiError, forbidden, unauthorized
from ..utils.serialization import oid

log = logging.getLogger(__name__)


# --------------------------------------------------------------------------- #
# JWT <-> user wiring (registered by the app factory)
# --------------------------------------------------------------------------- #
def register_jwt_callbacks(jwt_manager) -> None:
    """Teach Flask-JWT-Extended how to turn a token into a user document."""

    @jwt_manager.user_identity_loader
    def _identity(user: Any) -> str:
        # Accept either a raw id or a user document when minting tokens.
        if isinstance(user, Mapping):
            return str(user.get("_id"))
        return str(user)

    @jwt_manager.user_lookup_loader
    def _load_user(_jwt_header: dict, jwt_data: dict):
        identity = jwt_data.get("sub")
        try:
            user_id = ObjectId(str(identity))
        except Exception:
            return None
        user = db.users().find_one({"_id": user_id})
        if not user:
            return None
        # A disabled account keeps a technically-valid token; refuse it here.
        if user.get("status") == UserStatus.DISABLED:
            return None
        return user

    @jwt_manager.user_lookup_error_loader
    def _lookup_failed(_jwt_header, _jwt_data):
        return ApiError("Your session is no longer valid. Please sign in again.", 401).to_response()

    # Uniform 401s in our standard envelope instead of Flask-JWT's own shapes.
    @jwt_manager.unauthorized_loader
    def _missing_token(reason: str):
        return ApiError("Authentication required", 401, details={"reason": reason}).to_response()

    @jwt_manager.invalid_token_loader
    def _invalid_token(reason: str):
        return ApiError("Invalid authentication token", 401, details={"reason": reason}).to_response()

    @jwt_manager.expired_token_loader
    def _expired_token(_header, _payload):
        return ApiError("Your session has expired", 401, code="token_expired").to_response()

    @jwt_manager.needs_fresh_token_loader
    def _needs_fresh(_header, _payload):
        return ApiError("Please sign in again to continue", 401, code="fresh_token_required").to_response()


# --------------------------------------------------------------------------- #
# Current-caller accessors
# --------------------------------------------------------------------------- #
def current_user_doc() -> Mapping:
    """The authenticated user document. Raises 401 outside an authed request."""
    user = current_user
    if not user:
        raise unauthorized()
    return user


def current_user_optional() -> Mapping | None:
    """The user document if one is signed in, otherwise ``None``.

    The counterpart to :func:`optional_auth`. Routes reachable anonymously must
    use this — :func:`current_user_doc` and everything built on it raise 401, which
    on an optional route would defeat the point.
    """
    return current_user or None


def is_authenticated() -> bool:
    return bool(current_user)


def current_user_id() -> ObjectId:
    return current_user_doc()["_id"]


def current_role() -> str:
    return str(current_user_doc().get("role", ""))


def current_institution_id() -> ObjectId:
    inst = current_user_doc().get("institution_id")
    if not inst:
        # Should be impossible: every user is created inside an institution.
        log.error("User %s has no institution_id", current_user_doc().get("_id"))
        raise forbidden("Your account is not linked to an institution")
    return inst if isinstance(inst, ObjectId) else oid(inst)


def is_admin() -> bool:
    return current_role() == Role.ADMIN


# --------------------------------------------------------------------------- #
# Decorators
# --------------------------------------------------------------------------- #
def role_required(*roles: str) -> Callable:
    """Require a valid JWT *and* one of ``roles``.

    Usage::

        @bp.post("/subjects")
        @role_required(Role.ADMIN, Role.TEACHER)
        def create_subject(): ...
    """
    allowed = set(roles) or set(Role.ALL)

    def decorator(fn: Callable) -> Callable:
        @functools.wraps(fn)
        @jwt_required()
        def wrapper(*args, **kwargs):
            role = current_role()
            if role not in allowed:
                raise forbidden(
                    f"This action requires one of these roles: {', '.join(sorted(allowed))}"
                )
            # Stash for logging/auditing without re-reading the proxy everywhere.
            g.actor_id = current_user_doc()["_id"]
            g.institution_id = current_institution_id()
            g.actor_role = role
            return fn(*args, **kwargs)

        return wrapper

    return decorator


def any_authenticated(fn: Callable) -> Callable:
    """Any signed-in user of any role."""
    return role_required(*Role.ALL)(fn)


def optional_auth(fn: Callable) -> Callable:
    """Populate ``current_user`` when a token is present, but do not require one.

    Used by the public QR landing page, which needs to know whether to render the
    check-in button or a "sign in to continue" prompt.
    """

    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            verify_jwt_in_request(optional=True)
        except Exception:
            pass  # Malformed token on an optional route == treat as anonymous.
        return fn(*args, **kwargs)

    return wrapper


# --------------------------------------------------------------------------- #
# Tenant scoping
# --------------------------------------------------------------------------- #
def scope(filter_: Mapping | None = None, *, institution_id: ObjectId | None = None) -> dict:
    """Return a Mongo filter with ``institution_id`` pinned to the caller's tenant.

    Always build tenant-scoped queries through this helper::

        db.sessions().find(scope({"status": SessionStatus.ACTIVE}))

    Passing ``institution_id`` explicitly is only for background jobs (the
    low-attendance cron) that run without a request context.
    """
    query = dict(filter_ or {})
    query["institution_id"] = institution_id or current_institution_id()
    return query


def assert_same_institution(doc: Mapping | None, *, what: str = "resource") -> Mapping:
    """Verify a fetched document belongs to the caller's institution.

    Returns 404 rather than 403 on mismatch: telling a caller "this exists but is
    not yours" confirms the existence of another tenant's data, which is itself a
    small leak.
    """
    if not doc:
        raise ApiError(f"{what.capitalize()} not found", 404)
    doc_inst = doc.get("institution_id")
    if doc_inst is None or str(doc_inst) != str(current_institution_id()):
        log.warning(
            "Cross-institution access blocked: user=%s tried %s=%s",
            current_user_doc().get("_id"),
            what,
            doc.get("_id"),
        )
        raise ApiError(f"{what.capitalize()} not found", 404)
    return doc


def assert_can_manage_subject(subject: Mapping) -> Mapping:
    """Admins manage any subject in their institution; teachers only their own.

    Keeping this in one function means the same rule applies to subject edits,
    session creation, roster changes and analytics — there is no second copy to
    drift out of sync.
    """
    assert_same_institution(subject, what="subject")
    if is_admin():
        return subject
    teacher_ids = {str(t) for t in (subject.get("teacher_ids") or [])}
    if str(current_user_id()) not in teacher_ids:
        raise forbidden("You are not assigned to teach this subject")
    return subject


def assert_can_manage_session(session: Mapping) -> Mapping:
    """Session ownership follows subject ownership, plus the session's own teacher."""
    assert_same_institution(session, what="session")
    if is_admin():
        return session
    if str(session.get("teacher_id")) == str(current_user_id()):
        return session
    subject = db.subjects().find_one({"_id": session.get("subject_id")})
    if subject:
        teacher_ids = {str(t) for t in (subject.get("teacher_ids") or [])}
        if str(current_user_id()) in teacher_ids:
            return session
    raise forbidden("You are not assigned to this session")


def teacher_subject_ids() -> list[ObjectId]:
    """Subject ids the caller may act on (all of them for an admin)."""
    query = scope() if is_admin() else scope({"teacher_ids": current_user_id()})
    return [s["_id"] for s in db.subjects().find(query, {"_id": 1})]


def as_object_ids(values: Iterable[Any]) -> list[ObjectId]:
    out: list[ObjectId] = []
    for value in values:
        if isinstance(value, ObjectId):
            out.append(value)
        else:
            out.append(oid(value))
    return out
