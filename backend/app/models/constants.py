"""Domain enums and canonical string constants.

Defining these once (instead of sprinkling literals through routes) means a typo
becomes an ImportError rather than a silently-never-matching query.
"""
from __future__ import annotations


# --- Roles ------------------------------------------------------------------
class Role:
    ADMIN = "admin"
    TEACHER = "teacher"
    STUDENT = "student"

    ALL = (ADMIN, TEACHER, STUDENT)
    # Roles that can manage subjects, sessions and rosters.
    STAFF = (ADMIN, TEACHER)


# --- Account lifecycle ------------------------------------------------------
class UserStatus:
    INVITED = "invited"      # row exists, no password set yet
    ACTIVE = "active"
    DISABLED = "disabled"    # soft-deleted; blocked at auth time


class EnrollmentStatus:
    INVITED = "invited"                  # email sent, nothing done yet
    PENDING_BIOMETRICS = "pending_biometrics"  # password set, samples missing
    COMPLETE = "complete"                # password + required biometrics done


# --- Sessions ---------------------------------------------------------------
class VerificationMode:
    """How attendance is captured for a session.

    Note the asymmetry the product brief calls out: ``CLASS_PHOTO`` is a
    *teacher-driven bulk* action, while ``QR`` and ``VOICE`` are *per-student
    self-service* actions. ``CLASS_PHOTO_QR`` combines them — the photo is the
    primary pass and QR is the fallback for anyone it missed.
    """

    CLASS_PHOTO = "class_photo"
    QR = "qr"
    VOICE = "voice"
    CLASS_PHOTO_QR = "class_photo_qr"

    ALL = (CLASS_PHOTO, QR, VOICE, CLASS_PHOTO_QR)

    LABELS = {
        CLASS_PHOTO: "Class Photo only",
        QR: "QR only",
        VOICE: "Voice only",
        CLASS_PHOTO_QR: "Class Photo + QR",
    }

    @classmethod
    def includes_photo(cls, mode: str) -> bool:
        return mode in (cls.CLASS_PHOTO, cls.CLASS_PHOTO_QR)

    @classmethod
    def includes_qr(cls, mode: str) -> bool:
        return mode in (cls.QR, cls.CLASS_PHOTO_QR)

    @classmethod
    def includes_voice(cls, mode: str) -> bool:
        return mode == cls.VOICE

    @classmethod
    def student_self_service(cls, mode: str) -> bool:
        """True when students have an action to take for this session."""
        return cls.includes_qr(mode) or cls.includes_voice(mode)


class SessionStatus:
    ACTIVE = "active"
    ENDED = "ended"


class PhotoReviewStatus:
    NONE = "none"                      # no class photo processed yet
    PENDING_REVIEW = "pending_review"  # unmatched faces awaiting a decision
    RESOLVED = "resolved"              # every detected face accounted for


# --- Attendance -------------------------------------------------------------
class AttendanceMethod:
    FACE_PHOTO = "face_photo"          # auto-matched from the class photo
    FACE_PHOTO_REVIEW = "face_photo_review"  # teacher-assigned from review queue
    VOICE = "voice"
    QR = "qr"
    MANUAL = "manual"                  # teacher override

    ALL = (FACE_PHOTO, FACE_PHOTO_REVIEW, VOICE, QR, MANUAL)


class AttendanceStatus:
    PRESENT = "present"
    ABSENT = "absent"


# --- Review queue -----------------------------------------------------------
class ReviewReason:
    LOW_CONFIDENCE = "low_confidence"   # best guess exists but below threshold
    NO_MATCH = "no_match"               # nothing in the roster came close
    AMBIGUOUS = "ambiguous"             # two students nearly equidistant
    LOW_RESOLUTION = "low_resolution"   # face box too small to trust


class ReviewResolution:
    ASSIGNED = "assigned"       # teacher picked a student -> marked present
    DISMISSED = "dismissed"     # visitor / duplicate / not a student
    NOT_A_STUDENT = "not_a_student"


# --- Invites ----------------------------------------------------------------
class InviteType:
    TEACHER = "teacher"
    STUDENT = "student"


class InviteStatus:
    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"


# --- Audit log actions ------------------------------------------------------
class AuditAction:
    INSTITUTION_CREATED = "institution.created"
    USER_INVITED = "user.invited"
    USER_INVITE_REVOKED = "user.invite_revoked"
    USER_ACTIVATED = "user.activated"
    USER_DISABLED = "user.disabled"
    USER_ENABLED = "user.enabled"
    PASSWORD_RESET = "user.password_reset"

    SUBJECT_CREATED = "subject.created"
    SUBJECT_UPDATED = "subject.updated"
    SUBJECT_DELETED = "subject.deleted"
    ROSTER_ADDED = "roster.student_added"
    ROSTER_REMOVED = "roster.student_removed"

    SESSION_CREATED = "session.created"
    SESSION_ENDED = "session.ended"

    ATTENDANCE_MARKED = "attendance.marked"
    ATTENDANCE_OVERRIDE = "attendance.manual_override"

    CLASS_PHOTO_PROCESSED = "class_photo.processed"
    REVIEW_RESOLVED = "class_photo.review_resolved"
    REVIEW_DISCARDED = "class_photo.crops_discarded"

    BIOMETRIC_ENROLLED = "biometric.enrolled"
    BIOMETRIC_RESET = "biometric.reset"

    SETTINGS_UPDATED = "institution.settings_updated"
    ALERT_SENT = "alert.low_attendance_sent"
