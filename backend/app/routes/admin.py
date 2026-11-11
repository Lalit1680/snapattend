"""Admin-only routes: institution settings, staff management, audit, privacy.

Everything here is gated on ``Role.ADMIN`` and scoped to the caller's own
institution. There is no cross-institution tooling and no impersonation — the
brief rules both out explicitly, and their absence is a feature: an admin
account that cannot reach another tenant's data cannot leak it.

The privacy report endpoint deserves a note. The brief requires that no raw
biometric files persist, and asks for that to be *confirmed*, not asserted. Code
review confirms it once; ``GET /api/admin/privacy`` keeps confirming it in
production, because a retention bug that nobody can observe is a retention bug
that ships.
"""
from __future__ import annotations

import logging

from flask import Blueprint, jsonify, request

from .. import db, vector_store
from ..auth import guards
from ..models.constants import AuditAction, InviteStatus, Role, UserStatus
from ..services import alerts, audit, face_crop_store, invites, mailer
from ..utils.errors import bad_request, conflict
from ..utils.serialization import oid, serialize_list
from ..utils.timeutil import utcnow
from ..utils.validators import (
    body,
    clamp_int,
    clean_email,
    clean_name,
    clean_reason,
    clean_threshold,
    require,
)
from ._helpers import invite_response

log = logging.getLogger(__name__)

bp = Blueprint("admin", __name__, url_prefix="/api/admin")

# Settings an admin may change, and how each is validated. Keeping this as data
# rather than a chain of ifs means adding a setting is a one-line change and an
# unknown key is rejected rather than silently written into the document.
_SETTING_VALIDATORS = {
    "attendance_threshold": lambda v: clean_threshold(v, field="attendance_threshold"),
    "low_attendance_alerts_enabled": lambda v: bool(v),
    "alert_cooldown_days": lambda v: clamp_int(v, 7, minimum=1, maximum=90),
}


# --------------------------------------------------------------------------- #
# Institution
# --------------------------------------------------------------------------- #
@bp.get("/institution")
@guards.role_required(Role.ADMIN)
def get_institution():
    institution_id = guards.current_institution_id()
    institution = db.institutions().find_one({"_id": institution_id})
    counts = {
        "teachers": db.users().count_documents(
            {"institution_id": institution_id, "role": Role.TEACHER}
        ),
        "students": db.users().count_documents(
            {"institution_id": institution_id, "role": Role.STUDENT}
        ),
        "admins": db.users().count_documents(
            {"institution_id": institution_id, "role": Role.ADMIN}
        ),
        "subjects": db.subjects().count_documents(
            {"institution_id": institution_id, "archived": {"$ne": True}}
        ),
        "sessions": db.sessions().count_documents({"institution_id": institution_id}),
        "pending_invites": db.invites().count_documents(
            {"institution_id": institution_id, "status": InviteStatus.PENDING}
        ),
    }
    return jsonify(
        {
            "institution": {
                "id": str(institution["_id"]),
                "name": institution.get("name"),
                "slug": institution.get("slug"),
                "settings": institution.get("settings", {}),
                "created_at": institution.get("created_at"),
            },
            "counts": counts,
            "mail": mailer.describe(),
        }
    )


@bp.patch("/institution")
@guards.role_required(Role.ADMIN)
def update_institution():
    """Rename the institution and/or change its settings.

    The slug is intentionally immutable: it appears in invite emails that are
    already in inboxes, and changing it would quietly break them.
    """
    data = body()
    institution_id = guards.current_institution_id()
    current = db.institutions().find_one({"_id": institution_id})

    updates: dict = {}
    if data.get("name"):
        updates["name"] = clean_name(data["name"])

    settings_in = data.get("settings")
    if settings_in is not None:
        if not isinstance(settings_in, dict):
            raise bad_request("settings must be an object")
        unknown = sorted(set(settings_in) - set(_SETTING_VALIDATORS))
        if unknown:
            raise bad_request("Unknown setting(s)", unknown=unknown)
        merged = dict(current.get("settings") or {})
        for key, raw in settings_in.items():
            merged[key] = _SETTING_VALIDATORS[key](raw)
        updates["settings"] = merged

    if not updates:
        raise bad_request("Nothing to update")

    db.institutions().update_one({"_id": institution_id}, {"$set": updates})
    audit.record(
        institution_id=institution_id,
        actor_id=guards.current_user_id(),
        action=AuditAction.SETTINGS_UPDATED,
        target_id=institution_id,
        target_type="institution",
        previous_state={
            "name": current.get("name"),
            "settings": current.get("settings"),
        },
        new_state=updates,
    )
    fresh = db.institutions().find_one({"_id": institution_id})
    return jsonify(
        {
            "ok": True,
            "institution": {
                "id": str(fresh["_id"]),
                "name": fresh.get("name"),
                "slug": fresh.get("slug"),
                "settings": fresh.get("settings", {}),
            },
        }
    )


# --------------------------------------------------------------------------- #
# Users
# --------------------------------------------------------------------------- #
@bp.get("/users")
@guards.role_required(Role.ADMIN)
def list_users():
    """Directory of institution members, filterable by role and status."""
    query = guards.scope()
    role = request.args.get("role")
    if role:
        if role not in Role.ALL:
            raise bad_request("Unknown role", allowed=list(Role.ALL))
        query["role"] = role
    status = request.args.get("status")
    if status:
        query["status"] = status
    search = (request.args.get("q") or "").strip()
    if search:
        # Escaped so a user typing "a.b" searches for that literal, not a regex.
        import re as _re

        pattern = _re.escape(search)
        query["$or"] = [
            {"name": {"$regex": pattern, "$options": "i"}},
            {"email": {"$regex": pattern, "$options": "i"}},
        ]

    limit = clamp_int(request.args.get("limit"), 100, minimum=1, maximum=500)
    users = list(
        db.users().find(query, {"password_hash": 0}).sort("name", 1).limit(limit)
    )

    # Attach enrollment state for students so the admin can see who still owes
    # biometrics without loading a second screen.
    student_user_ids = [u["_id"] for u in users if u.get("role") == Role.STUDENT]
    profiles = {
        s["user_id"]: s
        for s in db.students().find({"user_id": {"$in": student_user_ids}})
    }
    payload = []
    for user in users:
        row = {
            "id": str(user["_id"]),
            "email": user.get("email"),
            "name": user.get("name"),
            "role": user.get("role"),
            "status": user.get("status"),
            "created_at": user.get("created_at"),
            "last_login_at": user.get("last_login_at"),
        }
        profile = profiles.get(user["_id"])
        if profile:
            row["student"] = {
                "id": str(profile["_id"]),
                "roll_number": profile.get("roll_number"),
                "enrollment_status": profile.get("enrollment_status"),
                "face_enrolled": bool(profile.get("face_enrolled")),
                "voice_enrolled": bool(profile.get("voice_enrolled")),
            }
        payload.append(row)

    return jsonify({"users": payload, "count": len(payload), "limit": limit})


@bp.post("/teachers")
@guards.role_required(Role.ADMIN)
def invite_teacher():
    """Invite a teacher by email. No self-signup path exists for staff."""
    data = body()
    require(data, "email", "name")
    result = invites.create_invite(
        email=clean_email(data["email"]),
        name=clean_name(data["name"]),
        role=Role.TEACHER,
        institution_id=guards.current_institution_id(),
        invited_by=guards.current_user_id(),
    )
    return jsonify(invite_response(result)), 201


@bp.post("/users/<user_id>/resend-invite")
@guards.role_required(Role.ADMIN)
def resend_invite(user_id: str):
    user = guards.assert_same_institution(
        db.users().find_one({"_id": oid(user_id)}), what="user"
    )
    result = invites.resend(
        user["email"],
        institution_id=guards.current_institution_id(),
        actor_id=guards.current_user_id(),
    )
    return jsonify(invite_response(result))


@bp.delete("/users/<user_id>/invite")
@guards.role_required(Role.ADMIN)
def revoke_invite(user_id: str):
    invites.revoke(
        user_id=oid(user_id),
        institution_id=guards.current_institution_id(),
        actor_id=guards.current_user_id(),
    )
    return jsonify({"ok": True, "message": "Invitation revoked and placeholder removed"})


@bp.post("/users/<user_id>/disable")
@guards.role_required(Role.ADMIN)
def disable_user(user_id: str):
    """Soft-delete an account.

    Disabling rather than deleting keeps the attendance history intact — a
    graduated student's records still belong in the subject's report. The JWT user
    loader rejects disabled accounts, so access ends on their next request.
    """
    data = body()
    reason = clean_reason(data.get("reason"), required=False)
    target = guards.assert_same_institution(
        db.users().find_one({"_id": oid(user_id)}), what="user"
    )

    if str(target["_id"]) == str(guards.current_user_id()):
        raise conflict("You cannot disable your own account.")

    institution = db.institutions().find_one({"_id": guards.current_institution_id()})
    if institution and str(institution.get("owner_user_id")) == str(target["_id"]):
        raise conflict("The institution owner's account cannot be disabled.")

    if target.get("role") == Role.ADMIN:
        remaining = db.users().count_documents(
            {
                "institution_id": target["institution_id"],
                "role": Role.ADMIN,
                "status": UserStatus.ACTIVE,
                "_id": {"$ne": target["_id"]},
            }
        )
        if remaining == 0:
            raise conflict(
                "This is the last active admin — promote another admin before disabling it."
            )

    db.users().update_one(
        {"_id": target["_id"]},
        {"$set": {"status": UserStatus.DISABLED, "updated_at": utcnow()}},
    )
    audit.record(
        institution_id=target["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.USER_DISABLED,
        target_id=target["_id"],
        target_type="user",
        reason=reason or None,
        previous_state={"status": target.get("status")},
        new_state={"status": UserStatus.DISABLED},
    )
    return jsonify({"ok": True, "status": UserStatus.DISABLED})


@bp.post("/users/<user_id>/enable")
@guards.role_required(Role.ADMIN)
def enable_user(user_id: str):
    """Re-enable a disabled account.

    An account that never set a password goes back to ``invited``, not ``active``
    — otherwise it would be an account with no credentials that the login route
    treats as usable.
    """
    target = guards.assert_same_institution(
        db.users().find_one({"_id": oid(user_id)}), what="user"
    )
    new_status = UserStatus.ACTIVE if target.get("password_hash") else UserStatus.INVITED
    db.users().update_one(
        {"_id": target["_id"]},
        {"$set": {"status": new_status, "updated_at": utcnow()}},
    )
    audit.record(
        institution_id=target["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.USER_ENABLED,
        target_id=target["_id"],
        target_type="user",
        previous_state={"status": target.get("status")},
        new_state={"status": new_status},
    )
    return jsonify({"ok": True, "status": new_status})


@bp.post("/users/<user_id>/role")
@guards.role_required(Role.ADMIN)
def change_role(user_id: str):
    """Promote or demote between admin and teacher.

    Students are excluded on purpose: a student row carries a ``students``
    profile, roster memberships and biometric vectors, and silently converting
    that to a teacher would leave orphaned data. Create a separate staff account
    instead.
    """
    data = body()
    require(data, "role")
    new_role = str(data["role"])
    if new_role not in (Role.ADMIN, Role.TEACHER):
        raise bad_request("Role must be 'admin' or 'teacher'", allowed=[Role.ADMIN, Role.TEACHER])

    target = guards.assert_same_institution(
        db.users().find_one({"_id": oid(user_id)}), what="user"
    )
    if target.get("role") == Role.STUDENT:
        raise conflict(
            "Student accounts cannot be converted to staff. Invite a separate staff account."
        )
    if target.get("role") == new_role:
        return jsonify({"ok": True, "role": new_role, "unchanged": True})

    if (
        target.get("role") == Role.ADMIN
        and new_role == Role.TEACHER
        and str(target["_id"]) == str(guards.current_user_id())
    ):
        raise conflict("You cannot demote your own admin account.")

    db.users().update_one(
        {"_id": target["_id"]}, {"$set": {"role": new_role, "updated_at": utcnow()}}
    )
    audit.record(
        institution_id=target["institution_id"],
        actor_id=guards.current_user_id(),
        action=AuditAction.SETTINGS_UPDATED,
        target_id=target["_id"],
        target_type="user",
        previous_state={"role": target.get("role")},
        new_state={"role": new_role},
        metadata={"field": "role"},
    )
    return jsonify({"ok": True, "role": new_role})


@bp.get("/invites")
@guards.role_required(Role.ADMIN)
def list_invites():
    status = request.args.get("status", InviteStatus.PENDING)
    limit = clamp_int(request.args.get("limit"), 100, minimum=1, maximum=500)
    query = guards.scope()
    if status != "all":
        query["status"] = status
    rows = list(
        db.invites().find(query).sort("created_at", -1).limit(limit)
    )
    # token_hash is dropped by serialize_doc's never-serialize list, but being
    # explicit here documents the intent at the call site too.
    return jsonify({"invites": serialize_list(rows, drop=("token_hash",))})


# --------------------------------------------------------------------------- #
# Audit log
# --------------------------------------------------------------------------- #
@bp.get("/audit")
@guards.role_required(Role.ADMIN)
def audit_log():
    """The override/action trail the brief requires admins to be able to read."""
    query = guards.scope()
    action = request.args.get("action")
    if action:
        query["action"] = action
    target_type = request.args.get("target_type")
    if target_type:
        query["target_type"] = target_type
    actor_id = request.args.get("actor_id")
    if actor_id:
        query["actor_id"] = oid(actor_id)

    limit = clamp_int(request.args.get("limit"), 100, minimum=1, maximum=500)
    skip = clamp_int(request.args.get("skip"), 0, minimum=0, maximum=100_000)
    rows = list(
        db.audit_logs().find(query).sort("timestamp", -1).skip(skip).limit(limit)
    )

    actor_ids = [r["actor_id"] for r in rows if r.get("actor_id")]
    actors = {
        u["_id"]: {"name": u.get("name"), "email": u.get("email"), "role": u.get("role")}
        for u in db.users().find({"_id": {"$in": actor_ids}}, {"name": 1, "email": 1, "role": 1})
    }
    entries = []
    for row in rows:
        entry = serialize_list([row])[0]
        entry["actor"] = actors.get(row.get("actor_id")) or {"name": "System"}
        entries.append(entry)

    return jsonify(
        {
            "entries": entries,
            "count": len(entries),
            "skip": skip,
            "limit": limit,
            "actions": sorted(
                {
                    value
                    for key, value in vars(AuditAction).items()
                    if not key.startswith("_") and isinstance(value, str)
                }
            ),
        }
    )


# --------------------------------------------------------------------------- #
# Privacy / retention
# --------------------------------------------------------------------------- #
@bp.get("/privacy")
@guards.role_required(Role.ADMIN)
def privacy():
    """Live evidence that the retention rules are holding.

    ``resolved_but_crop_retained`` should always be 0; anything else means a
    resolution path skipped ``discard_crop`` and is a bug worth paging about.
    """
    report = face_crop_store.privacy_report()
    return jsonify(
        {
            "face_crops": report,
            "vector_store": vector_store.stats(),
            "guarantees": [
                "Uploaded class photos are never written to disk or to MongoDB.",
                "Enrollment images and voice recordings are discarded once embedded.",
                "Review-queue crops are deleted the moment a teacher resolves the item, "
                "with a TTL index as a backstop.",
                "Only embedding vectors persist, in ChromaDB, keyed by student id.",
            ],
            "checked_at": utcnow(),
        }
    )


@bp.post("/privacy/sweep")
@guards.role_required(Role.ADMIN)
def sweep_crops():
    """Force the crop expiry sweep instead of waiting on Mongo's TTL thread.

    Mongo's TTL monitor runs about once a minute; this exists so an admin
    responding to a privacy question can act immediately and see the count.
    """
    removed = face_crop_store.sweep_expired()
    return jsonify({"ok": True, "crops_discarded": removed})


# --------------------------------------------------------------------------- #
# Low-attendance alerts
# --------------------------------------------------------------------------- #
@bp.post("/alerts/run")
@guards.role_required(Role.ADMIN)
def run_alerts():
    """Trigger the low-attendance check for this institution.

    ``dry_run`` is the default: an admin clicking a button labelled "check" should
    not send fifty emails before seeing the list.
    """
    data = request.get_json(silent=True) or {}
    dry_run = bool(data.get("dry_run", True))
    threshold = (
        clean_threshold(data["threshold"]) if data.get("threshold") is not None else None
    )
    result = alerts.run(
        institution_id=guards.current_institution_id(),
        actor_id=guards.current_user_id(),
        dry_run=dry_run,
        threshold_override=threshold,
    )
    return jsonify(result)


@bp.get("/alerts")
@guards.role_required(Role.ADMIN)
def alert_history():
    limit = clamp_int(request.args.get("limit"), 50, minimum=1, maximum=200)
    return jsonify(
        {"alerts": alerts.recent_alerts(guards.current_institution_id(), limit=limit)}
    )
