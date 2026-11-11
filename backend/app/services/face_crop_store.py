"""Review-queue face crops — the single storage chokepoint for face imagery.

This module exists so the privacy requirement is auditable in one place. The
brief asks for confirmation at code-review time that no raw biometric imagery is
retained, so here is the complete inventory of face pixels in SnapAttend:

1. The **uploaded class photo** is read into memory by the route, passed to the
   matching pipeline, and dropped when the request ends. It is never written to
   disk, never put in Mongo, and never handed to an external service. There is
   deliberately no code anywhere that persists it.
2. The **review-queue crops** created for unmatched faces are stored as small
   base64 JPEGs on the ``pending_face_matches`` document, and are removed by:
   - :func:`discard_crop` the moment a teacher resolves that item,
   - :func:`discard_session_crops` when a session's queue is fully resolved,
   - a TTL index on ``expires_at`` (see :func:`app.db.ensure_indexes`) which
     deletes the whole document after ``FACE_CROP_TTL_HOURS`` regardless.
3. **Enrollment samples** are embedded and discarded inside the request; only the
   128-d vector reaches Chroma.

Nothing else stores an image. ``utils.serialization`` additionally blocks
``crop_jpeg_b64`` from generic document serialisation so a crop can only ever
leave the server through the explicit review-queue endpoint.

Why the crop lives in Mongo rather than on disk
-----------------------------------------------
A 200px JPEG is ~4-6 KB, so document size is a non-issue, and co-locating it with
the review record gives one deletion path instead of two. A filesystem cache
would need its own sweeper and could orphan files if a delete failed midway —
exactly the failure mode this requirement cannot tolerate.
"""
from __future__ import annotations

import logging
from typing import Mapping, Optional, Sequence

from bson import ObjectId

from .. import db
from ..config import Config
from ..models.constants import AuditAction, PhotoReviewStatus
from ..models.schemas import pending_face_match_doc
from ..pipelines.imaging import to_data_url
from ..utils.timeutil import in_hours, utcnow
from . import audit

log = logging.getLogger(__name__)


def store_review_items(
    *,
    session: Mapping,
    items: Sequence,
    replace_existing: bool = True,
) -> list[ObjectId]:
    """Persist review-queue entries for a processed class photo.

    ``items`` are ``ClassPhotoReviewItem`` instances from the face pipeline.
    Re-uploading a photo for the same session replaces the previous unresolved
    queue by default — otherwise a teacher who retakes a bad photo would be left
    reviewing phantom faces from the discarded one.
    """
    session_id: ObjectId = session["_id"]

    if replace_existing:
        removed = db.pending_face_matches().delete_many(
            {"session_id": session_id, "resolved": False}
        )
        if removed.deleted_count:
            log.info(
                "Replaced %s unresolved review item(s) for session %s",
                removed.deleted_count,
                session_id,
            )

    if not items:
        return []

    expires_at = in_hours(Config.FACE_CROP_TTL_HOURS)
    docs = [
        pending_face_match_doc(
            session_id=session_id,
            institution_id=session["institution_id"],
            subject_id=session["subject_id"],
            crop_jpeg_b64=item.crop_jpeg_b64,
            face_box=item.box,
            best_guess_student_id=(
                ObjectId(item.best_guess_student_id) if item.best_guess_student_id else None
            ),
            confidence_score=item.confidence,
            distance=item.distance,
            reason=item.reason,
            expires_at=expires_at,
        )
        for item in items
    ]
    result = db.pending_face_matches().insert_many(docs)
    return list(result.inserted_ids)


def list_review_items(session_id: ObjectId, *, include_resolved: bool = False) -> list[dict]:
    """Review queue for a session, with crops rendered as data URLs.

    This is the *only* function that lets a face crop out of the database, and it
    is reachable exclusively from the teacher review endpoint.
    """
    query: dict = {"session_id": session_id}
    if not include_resolved:
        query["resolved"] = False

    items = list(db.pending_face_matches().find(query).sort("created_at", 1))
    if not items:
        return []

    guess_ids = [i["best_guess_student_id"] for i in items if i.get("best_guess_student_id")]
    assigned_ids = [i["assigned_student_id"] for i in items if i.get("assigned_student_id")]
    names = _student_names(list({*guess_ids, *assigned_ids}))

    out: list[dict] = []
    for item in items:
        guess_id = item.get("best_guess_student_id")
        assigned_id = item.get("assigned_student_id")
        out.append(
            {
                "id": str(item["_id"]),
                "session_id": str(item["session_id"]),
                "face_box": item.get("face_box"),
                "crop_data_url": to_data_url(item.get("crop_jpeg_b64")),
                "crop_available": bool(item.get("crop_jpeg_b64")),
                "reason": item.get("reason"),
                "best_guess_student_id": str(guess_id) if guess_id else None,
                "best_guess_name": names.get(str(guess_id)) if guess_id else None,
                "confidence_score": item.get("confidence_score"),
                "distance": item.get("distance"),
                "resolved": bool(item.get("resolved")),
                "resolution": item.get("resolution"),
                "assigned_student_id": str(assigned_id) if assigned_id else None,
                "assigned_name": names.get(str(assigned_id)) if assigned_id else None,
                "created_at": item.get("created_at"),
                "expires_at": item.get("expires_at"),
            }
        )
    return out


def _student_names(student_ids: Sequence[ObjectId]) -> dict[str, str]:
    if not student_ids:
        return {}
    students = list(db.students().find({"_id": {"$in": list(student_ids)}}, {"user_id": 1}))
    user_ids = [s["user_id"] for s in students if s.get("user_id")]
    users = {
        u["_id"]: (u.get("name") or u.get("email") or "Unknown")
        for u in db.users().find({"_id": {"$in": user_ids}}, {"name": 1, "email": 1})
    }
    return {str(s["_id"]): users.get(s.get("user_id"), "Unknown") for s in students}


def get_item(pending_id: ObjectId, session_id: ObjectId) -> Optional[Mapping]:
    """Fetch one item, scoped to its session so ids cannot be probed across sessions."""
    return db.pending_face_matches().find_one({"_id": pending_id, "session_id": session_id})


def discard_crop(pending_id: ObjectId) -> None:
    """Remove the stored JPEG, keeping the (non-biometric) resolution record.

    ``$unset`` rather than blanking the field: the audit-relevant facts (which
    face box, what confidence, who resolved it, how) are worth keeping, the pixels
    are not.
    """
    db.pending_face_matches().update_one(
        {"_id": pending_id},
        {"$unset": {"crop_jpeg_b64": ""}, "$set": {"crop_discarded": True}},
    )


def discard_session_crops(session_id: ObjectId, *, actor_id: Optional[ObjectId] = None) -> int:
    """Drop every crop for a session. Called once its review queue is resolved."""
    result = db.pending_face_matches().update_many(
        {"session_id": session_id, "crop_jpeg_b64": {"$exists": True}},
        {"$unset": {"crop_jpeg_b64": ""}, "$set": {"crop_discarded": True}},
    )
    if result.modified_count:
        session = db.sessions().find_one({"_id": session_id}, {"institution_id": 1})
        if session:
            audit.record(
                institution_id=session["institution_id"],
                actor_id=actor_id,
                action=AuditAction.REVIEW_DISCARDED,
                target_id=session_id,
                target_type="session",
                metadata={"crops_discarded": result.modified_count},
            )
        log.info("Discarded %s face crop(s) for session %s", result.modified_count, session_id)
    return result.modified_count


def unresolved_count(session_id: ObjectId) -> int:
    return db.pending_face_matches().count_documents({"session_id": session_id, "resolved": False})


def sweep_expired() -> int:
    """Belt-and-braces cleanup for expired crops.

    Mongo's TTL monitor runs about once a minute and will delete these documents
    on its own; this exists so ``scripts/cleanup_face_crops.py`` can force the
    issue (and so the guarantee holds on a deployment where TTL indexes were not
    created successfully).
    """
    now = utcnow()
    result = db.pending_face_matches().delete_many({"expires_at": {"$lte": now}})
    if result.deleted_count:
        log.info("Swept %s expired review item(s)", result.deleted_count)
    return result.deleted_count


def privacy_report() -> dict:
    """Current retention state — surfaced on the admin security panel.

    Makes the invariant observable rather than merely asserted: if
    ``crops_retained`` is ever non-zero for a session whose queue is resolved,
    something is wrong.
    """
    total = db.pending_face_matches().count_documents({})
    with_crop = db.pending_face_matches().count_documents({"crop_jpeg_b64": {"$exists": True}})
    unresolved = db.pending_face_matches().count_documents({"resolved": False})
    stale = db.pending_face_matches().count_documents(
        {"resolved": True, "crop_jpeg_b64": {"$exists": True}}
    )
    return {
        "review_items_total": total,
        "crops_retained": with_crop,
        "unresolved_items": unresolved,
        "resolved_but_crop_retained": stale,  # expected to be 0
        "crop_ttl_hours": Config.FACE_CROP_TTL_HOURS,
        "class_photos_stored": 0,  # by design — there is no code path that stores one
        "enrollment_images_stored": 0,
    }


def session_review_status(session_id: ObjectId, *, photo_processed: bool = True) -> str:
    """Derive a session's ``photo_review_status`` from its queue.

    ``photo_processed=False`` means no photo has been run for this session yet, in
    which case an empty queue is ``NONE`` rather than ``RESOLVED``. With a photo
    processed, an empty queue means every detected face was accounted for.
    """
    if not photo_processed:
        return PhotoReviewStatus.NONE
    return (
        PhotoReviewStatus.PENDING_REVIEW
        if unresolved_count(session_id) > 0
        else PhotoReviewStatus.RESOLVED
    )
