"""Audit trail.

The brief makes the audit log non-negotiable, so this is the one service that
must never silently fail to record. Two deliberate choices:

* **Never raise.** An audit write failing must not roll back the action the user
  just took — attendance being marked matters more than the log line. Failures
  are logged at ERROR level so they are visible in monitoring.
* **Actor may be ``None``.** The low-attendance cron and other system jobs write
  audit entries with no human actor; that is recorded honestly rather than
  attributed to whoever happened to configure the job.
"""
from __future__ import annotations

import logging
from typing import Any, Optional

from bson import ObjectId

from .. import db
from ..models.schemas import audit_log_doc

log = logging.getLogger(__name__)


def record(
    *,
    institution_id: ObjectId,
    action: str,
    actor_id: Optional[ObjectId] = None,
    target_id: Any = None,
    target_type: Optional[str] = None,
    reason: Optional[str] = None,
    previous_state: Any = None,
    new_state: Any = None,
    metadata: Optional[dict] = None,
) -> Optional[ObjectId]:
    """Append one entry to the audit log. Returns its id, or None on failure."""
    try:
        doc = audit_log_doc(
            institution_id=institution_id,
            actor_id=actor_id,
            action=action,
            target_id=target_id,
            target_type=target_type,
            reason=reason,
            previous_state=previous_state,
            new_state=new_state,
            metadata=metadata,
        )
        result = db.audit_logs().insert_one(doc)
        return result.inserted_id
    except Exception as exc:  # pragma: no cover - defensive by design
        log.error(
            "AUDIT WRITE FAILED action=%s actor=%s target=%s: %s",
            action,
            actor_id,
            target_id,
            exc,
        )
        return None


def record_for_current_user(action: str, **kwargs) -> Optional[ObjectId]:
    """Convenience wrapper that fills in actor/institution from the request.

    Only valid inside an authenticated request; background jobs must call
    :func:`record` with explicit ids.
    """
    from ..auth.guards import current_institution_id, current_user_id

    return record(
        institution_id=current_institution_id(),
        actor_id=current_user_id(),
        action=action,
        **kwargs,
    )
