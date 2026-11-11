"""Class-photo attendance: orchestrates pipeline -> attendance -> review queue.

This is the glue between the pure matching pipeline (``pipelines.face``) and
persistence. The ordering matters and is deliberate:

1. Run detection + matching **entirely in memory**.
2. Write the confident matches as attendance records.
3. Write the leftover faces to the review queue (crops included).
4. Update the session's ``photo_review_status`` so the dashboard knows whether
   attendance for this session is final.
5. Return a summary. The photo bytes go out of scope here and are never persisted.

If step 2 or 3 fails, the photo is gone and the teacher simply re-uploads — there
is no partially-written biometric state to clean up, which is why this is not
wrapped in a transaction.
"""
from __future__ import annotations

import logging
from typing import Mapping, Optional

from bson import ObjectId

from .. import db, vector_store
from ..models.constants import (
    AttendanceMethod,
    AuditAction,
    PhotoReviewStatus,
    ReviewResolution,
    VerificationMode,
)
from ..pipelines.face import FaceMatchConfig, FacePipelineError, match_class_photo
from ..pipelines.imaging import ImageDecodeError
from ..utils.errors import ApiError, bad_request
from ..utils.timeutil import utcnow
from . import attendance, audit, face_crop_store

log = logging.getLogger(__name__)


def process_class_photo(
    *,
    session: Mapping,
    photo_bytes: bytes,
    actor_id: ObjectId,
) -> dict:
    """Detect, match and record attendance from one class photo.

    Returns a summary suitable for returning straight to the teacher's dashboard.
    """
    mode = str(session.get("verification_mode"))
    if not VerificationMode.includes_photo(mode):
        raise bad_request(
            f"This session uses '{VerificationMode.LABELS.get(mode, mode)}', which does not "
            f"use a class photo."
        )
    if not photo_bytes:
        raise bad_request("No photo was uploaded")

    session_id: ObjectId = session["_id"]
    subject_id: ObjectId = session["subject_id"]
    institution_id: ObjectId = session["institution_id"]

    roster = attendance.roster_student_ids(subject_id)
    if not roster:
        raise bad_request(
            "This subject has no students on its roster yet, so there is nothing to match against."
        )

    # Only students with an enrolled face vector can possibly be matched; scoping
    # the query to them keeps the search tight and lets us tell the teacher
    # exactly who was un-matchable rather than leaving them to guess.
    enrolled = list(
        db.students().find(
            {"_id": {"$in": roster}, "face_enrolled": True}, {"_id": 1}
        )
    )
    searchable_ids = [str(s["_id"]) for s in enrolled]
    not_enrolled = len(roster) - len(searchable_ids)

    try:
        result = match_class_photo(
            photo_bytes,
            institution_id=str(institution_id),
            roster_student_ids=searchable_ids,
            cfg=FaceMatchConfig.from_config(),
        )
    except ImageDecodeError as exc:
        raise bad_request(str(exc))
    except FacePipelineError as exc:
        raise ApiError(str(exc), 503, code="face_pipeline_unavailable")

    if not_enrolled:
        result.warnings.append(
            f"{not_enrolled} student(s) on this roster have not enrolled their face yet and "
            f"cannot be matched from a photo."
        )

    # --- 2. Confident matches -> attendance records ------------------------
    bulk = attendance.mark_many_present(
        session=session,
        entries=[
            {
                "student_id": ObjectId(m.student_id),
                "confidence_score": m.confidence,
                "face_box": m.box,
            }
            for m in result.matches
        ],
        method=AttendanceMethod.FACE_PHOTO,
        marked_by=actor_id,
    )

    # --- 3. Everything else -> review queue --------------------------------
    face_crop_store.store_review_items(session=session, items=result.review_items)

    # --- 4. Session bookkeeping -------------------------------------------
    review_status = (
        PhotoReviewStatus.PENDING_REVIEW if result.review_items else PhotoReviewStatus.RESOLVED
    )
    stats = result.summary()
    stats.update(
        {
            "auto_marked": len(bulk["marked"]),
            "already_present": len(bulk["already_present"]),
            "roster_size": len(roster),
            "face_enrolled_count": len(searchable_ids),
        }
    )
    db.sessions().update_one(
        {"_id": session_id},
        {
            "$set": {
                "photo_review_status": review_status,
                "photo_processed_at": utcnow(),
                "photo_stats": stats,
                "updated_at": utcnow(),
            }
        },
    )

    audit.record(
        institution_id=institution_id,
        actor_id=actor_id,
        action=AuditAction.CLASS_PHOTO_PROCESSED,
        target_id=session_id,
        target_type="session",
        new_state={"photo_review_status": review_status},
        metadata=stats,
    )

    # --- 5. Summary; photo_bytes falls out of scope here -------------------
    matched_names = _name_map([ObjectId(m.student_id) for m in result.matches])
    return {
        "faces_detected": result.faces_detected,
        "auto_matched": result.auto_matched,
        "newly_marked": len(bulk["marked"]),
        "already_present": len(bulk["already_present"]),
        "rejected": bulk["rejected"],
        "needs_review": result.needs_review,
        "photo_review_status": review_status,
        "duration_ms": result.duration_ms,
        "warnings": result.warnings,
        "roster_size": len(roster),
        "face_enrolled_count": len(searchable_ids),
        "matches": [
            {
                "student_id": m.student_id,
                "name": matched_names.get(m.student_id, "Unknown"),
                "confidence": m.confidence,
                "distance": m.distance,
                "face_box": m.box,
            }
            for m in result.matches
        ],
        "review_items": face_crop_store.list_review_items(session_id),
    }


def _name_map(student_ids: list[ObjectId]) -> dict[str, str]:
    if not student_ids:
        return {}
    students = list(db.students().find({"_id": {"$in": student_ids}}, {"user_id": 1}))
    users = {
        u["_id"]: (u.get("name") or u.get("email") or "Unknown")
        for u in db.users().find(
            {"_id": {"$in": [s["user_id"] for s in students if s.get("user_id")]}},
            {"name": 1, "email": 1},
        )
    }
    return {str(s["_id"]): users.get(s.get("user_id"), "Unknown") for s in students}


def resolve_review_item(
    *,
    session: Mapping,
    pending_id: ObjectId,
    resolution: str,
    assigned_student_id: Optional[ObjectId],
    reason: Optional[str],
    actor_id: ObjectId,
) -> dict:
    """Apply a teacher's decision to one review-queue face.

    ``assigned`` marks the chosen student present with method
    ``face_photo_review`` — distinct from ``face_photo`` so analytics can tell an
    automated match from a human-confirmed one. ``dismissed`` / ``not_a_student``
    record the decision and mark nobody.

    In all cases the crop is destroyed immediately afterwards.
    """
    session_id: ObjectId = session["_id"]
    item = face_crop_store.get_item(pending_id, session_id)
    if not item:
        raise ApiError("That review item no longer exists.", 404)
    if item.get("resolved"):
        raise ApiError("That review item has already been resolved.", 409, code="already_resolved")

    marked: Optional[dict] = None

    if resolution == ReviewResolution.ASSIGNED:
        if not assigned_student_id:
            raise bad_request("Choose a student to assign this face to")
        outcome = attendance.mark_present(
            session=session,
            student_id=assigned_student_id,
            method=AttendanceMethod.FACE_PHOTO_REVIEW,
            confidence_score=item.get("confidence_score"),
            marked_by=actor_id,
            face_box=item.get("face_box"),
            write_audit=False,
        )
        marked = {
            "student_id": str(assigned_student_id),
            "created": outcome.created,
            "status": outcome.status,
            "message": outcome.message,
            "blocked_by_override": outcome.blocked_by_override,
        }
    elif resolution not in (ReviewResolution.DISMISSED, ReviewResolution.NOT_A_STUDENT):
        raise bad_request(f"Unknown resolution: {resolution}")

    db.pending_face_matches().update_one(
        {"_id": pending_id},
        {
            "$set": {
                "resolved": True,
                "resolution": resolution,
                "assigned_student_id": assigned_student_id,
                "resolved_by": actor_id,
                "resolved_at": utcnow(),
                "resolution_reason": reason,
            }
        },
    )
    # Privacy: the crop has served its purpose the instant a decision is made.
    face_crop_store.discard_crop(pending_id)

    audit.record(
        institution_id=session["institution_id"],
        actor_id=actor_id,
        action=AuditAction.REVIEW_RESOLVED,
        target_id=pending_id,
        target_type="pending_face_match",
        reason=reason,
        previous_state={"resolved": False, "reason": item.get("reason")},
        new_state={"resolved": True, "resolution": resolution},
        metadata={
            "session_id": str(session_id),
            "assigned_student_id": str(assigned_student_id) if assigned_student_id else None,
            "confidence_score": item.get("confidence_score"),
        },
    )

    remaining = face_crop_store.unresolved_count(session_id)
    new_status = (
        PhotoReviewStatus.PENDING_REVIEW if remaining else PhotoReviewStatus.RESOLVED
    )
    db.sessions().update_one(
        {"_id": session_id},
        {"$set": {"photo_review_status": new_status, "updated_at": utcnow()}},
    )
    if remaining == 0:
        # Queue fully resolved: sweep any crop that somehow survived.
        face_crop_store.discard_session_crops(session_id, actor_id=actor_id)

    return {
        "resolved": True,
        "resolution": resolution,
        "marked": marked,
        "remaining_review_items": remaining,
        "photo_review_status": new_status,
    }


def assignable_students(session: Mapping) -> list[dict]:
    """Roster students a review-queue face may be assigned to.

    Includes everyone on the roster, present or not: a teacher resolving a face
    may well be correcting a mis-attributed auto-match, and hiding already-present
    students would make that impossible.
    """
    rows = attendance.session_roster_view(session)
    return [
        {
            "student_id": row["student_id"],
            "name": row["name"],
            "status": row["status"],
            "face_enrolled": row["face_enrolled"],
        }
        for row in rows
    ]


def embedding_coverage(subject_id: ObjectId, institution_id: ObjectId) -> dict:
    """How much of a roster is actually matchable — shown before a photo upload.

    Cross-checks the Mongo flag against the vector store so a mismatch (flag set
    but no vector, e.g. after a manual Chroma wipe) is visible instead of silently
    producing a photo where half the class "isn't recognised".
    """
    roster = attendance.roster_student_ids(subject_id)
    if not roster:
        return {"roster_size": 0, "face_enrolled": 0, "vectors_present": 0, "missing": []}

    students = list(db.students().find({"_id": {"$in": roster}}, {"user_id": 1, "face_enrolled": 1}))
    flagged = [s for s in students if s.get("face_enrolled")]
    vectors_present = sum(
        1
        for s in flagged
        if vector_store.has_embedding(vector_store.FACE_COLLECTION, str(s["_id"]))
    )
    missing_ids = [s["_id"] for s in students if not s.get("face_enrolled")]
    names = _name_map(missing_ids)
    return {
        "roster_size": len(roster),
        "face_enrolled": len(flagged),
        "vectors_present": vectors_present,
        "missing": [{"student_id": str(i), "name": names.get(str(i), "Unknown")} for i in missing_ids],
    }
