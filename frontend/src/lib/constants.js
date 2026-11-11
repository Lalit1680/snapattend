/**
 * Enums mirrored from `backend/app/models/constants.py`.
 *
 * These are duplicated rather than fetched because they are part of the API's
 * shape, not its data: a rename on the backend is a breaking change that should
 * fail loudly here. Keep the two files in step -- the backend is the source of
 * truth.
 */

export const Role = {
  ADMIN: 'admin',
  TEACHER: 'teacher',
  STUDENT: 'student',
};

export const STAFF_ROLES = [Role.ADMIN, Role.TEACHER];

export const ROLE_LABELS = {
  [Role.ADMIN]: 'Administrator',
  [Role.TEACHER]: 'Teacher',
  [Role.STUDENT]: 'Student',
};

export const UserStatus = {
  INVITED: 'invited',
  ACTIVE: 'active',
  DISABLED: 'disabled',
};

export const EnrollmentStatus = {
  INVITED: 'invited',
  PENDING_BIOMETRICS: 'pending_biometrics',
  COMPLETE: 'complete',
};

export const ENROLLMENT_STATUS_LABELS = {
  [EnrollmentStatus.INVITED]: 'Invited',
  [EnrollmentStatus.PENDING_BIOMETRICS]: 'Biometrics pending',
  [EnrollmentStatus.COMPLETE]: 'Enrolled',
};

export const VerificationMode = {
  CLASS_PHOTO: 'class_photo',
  QR: 'qr',
  VOICE: 'voice',
  CLASS_PHOTO_QR: 'class_photo_qr',
};

/** Matches `VerificationMode.LABELS` on the backend. */
export const MODE_LABELS = {
  [VerificationMode.CLASS_PHOTO]: 'Class Photo only',
  [VerificationMode.QR]: 'QR only',
  [VerificationMode.VOICE]: 'Voice only',
  [VerificationMode.CLASS_PHOTO_QR]: 'Class Photo + QR',
};

export const MODE_HINTS = {
  [VerificationMode.CLASS_PHOTO]:
    'You photograph the room; faces are matched against enrolled students.',
  [VerificationMode.QR]:
    'Students scan a code that rotates every 30 seconds from their own signed-in device.',
  [VerificationMode.VOICE]:
    'Students record the passphrase; their voice is verified against their enrollment.',
  [VerificationMode.CLASS_PHOTO_QR]:
    'Photo for the room, plus a rotating code for anyone the photo missed.',
};

export const MODE_OPTIONS = [
  VerificationMode.CLASS_PHOTO,
  VerificationMode.QR,
  VerificationMode.VOICE,
  VerificationMode.CLASS_PHOTO_QR,
].map((value) => ({ value, label: MODE_LABELS[value], hint: MODE_HINTS[value] }));

export const modeIncludesPhoto = (mode) =>
  mode === VerificationMode.CLASS_PHOTO || mode === VerificationMode.CLASS_PHOTO_QR;
export const modeIncludesQr = (mode) =>
  mode === VerificationMode.QR || mode === VerificationMode.CLASS_PHOTO_QR;
export const modeIncludesVoice = (mode) => mode === VerificationMode.VOICE;
/** Modes a student can act on themselves, from their own device. */
export const modeIsSelfService = (mode) => modeIncludesQr(mode) || modeIncludesVoice(mode);

export const SessionStatus = {
  ACTIVE: 'active',
  ENDED: 'ended',
};

export const PhotoReviewStatus = {
  NONE: 'none',
  PENDING_REVIEW: 'pending_review',
  RESOLVED: 'resolved',
};

export const AttendanceMethod = {
  FACE_PHOTO: 'face_photo',
  FACE_PHOTO_REVIEW: 'face_photo_review',
  VOICE: 'voice',
  QR: 'qr',
  MANUAL: 'manual',
};

export const METHOD_LABELS = {
  [AttendanceMethod.FACE_PHOTO]: 'Face (photo)',
  [AttendanceMethod.FACE_PHOTO_REVIEW]: 'Face (reviewed)',
  [AttendanceMethod.VOICE]: 'Voice',
  [AttendanceMethod.QR]: 'QR code',
  [AttendanceMethod.MANUAL]: 'Manual',
  unknown: 'Unknown',
};

export const METHOD_TONES = {
  [AttendanceMethod.FACE_PHOTO]: 'success',
  [AttendanceMethod.FACE_PHOTO_REVIEW]: 'info',
  [AttendanceMethod.VOICE]: 'info',
  [AttendanceMethod.QR]: 'info',
  [AttendanceMethod.MANUAL]: 'warn',
};

export const AttendanceStatus = {
  PRESENT: 'present',
  ABSENT: 'absent',
};

export const ReviewReason = {
  LOW_CONFIDENCE: 'low_confidence',
  NO_MATCH: 'no_match',
  AMBIGUOUS: 'ambiguous',
  LOW_RESOLUTION: 'low_resolution',
};

export const REVIEW_REASON_LABELS = {
  [ReviewReason.LOW_CONFIDENCE]: 'Low confidence',
  [ReviewReason.NO_MATCH]: 'No match found',
  [ReviewReason.AMBIGUOUS]: 'Two students matched',
  [ReviewReason.LOW_RESOLUTION]: 'Face too small',
};

export const REVIEW_REASON_HINTS = {
  [ReviewReason.LOW_CONFIDENCE]:
    'The closest enrolled student was near the threshold. Confirm or dismiss.',
  [ReviewReason.NO_MATCH]:
    'No enrolled student was close enough. Often a visitor, or someone who has not enrolled yet.',
  [ReviewReason.AMBIGUOUS]:
    'Two enrolled students scored almost identically, so the match was not safe to make.',
  [ReviewReason.LOW_RESOLUTION]:
    'The face was too few pixels across to compare reliably. Retake closer if this repeats.',
};

export const ReviewResolution = {
  ASSIGNED: 'assigned',
  DISMISSED: 'dismissed',
  NOT_A_STUDENT: 'not_a_student',
};

/**
 * `invites.status` from `backend/app/models/constants.py`.
 *
 * There is deliberately no `expired`. Nothing sweeps the collection, so an
 * invitation past its `expires_at` is still stored as `pending` and it is the link
 * itself that refuses to work -- `services/invites.py` checks the age of the signed
 * token, not this field. Expiry is therefore derived from `expires_at`, never read
 * from here.
 */
export const InviteStatus = {
  PENDING: 'pending',
  ACCEPTED: 'accepted',
  REVOKED: 'revoked',
};

/**
 * Error codes from `backend/app/utils/errors.py` that the UI reacts to by name
 * rather than just printing the message.
 *
 * The first eight are `ApiError._default_code(status)`'s mapping, mirrored so a
 * page can name a status without hard-coding the number. The rest are literal
 * `code="…"` strings raised by the services.
 */
export const ErrorCode = {
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  UNPROCESSABLE: 'unprocessable',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  SERVICE_UNAVAILABLE: 'service_unavailable',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_INVALID: 'token_invalid',
  TOKEN_USED: 'token_used',
  QR_ROTATED: 'qr_rotated',
  SESSION_ENDED: 'session_ended',
  WINDOW_CLOSED: 'window_closed',
  MODE_MISMATCH: 'mode_mismatch',
  NOT_ENROLLED: 'not_enrolled',
  VOICE_NOT_ENROLLED: 'voice_not_enrolled',
  ACCOUNT_DISABLED: 'account_disabled',
  ACCOUNT_NOT_ACTIVATED: 'account_not_activated',
  ALREADY_RESOLVED: 'already_resolved',
  FACE_PIPELINE_UNAVAILABLE: 'face_pipeline_unavailable',
  VOICE_PIPELINE_UNAVAILABLE: 'voice_pipeline_unavailable',
};

/**
 * `student.reason` on a **200** from `GET /api/public/scan`, from
 * `backend/app/routes/public.py`.
 *
 * Not error codes: the scan succeeded and resolved a real class, and these say why
 * the person holding the phone cannot mark themselves present in it — so they
 * arrive in the body, never in an error envelope. `not_enrolled` collides with
 * `ErrorCode.NOT_ENROLLED` by value only; the check-in endpoints raise that one as
 * a 403 while this one is a field on a successful lookup.
 */
export const ScanReason = {
  NOT_SIGNED_IN: 'not_signed_in',
  STAFF_ACCOUNT: 'staff_account',
  NO_STUDENT_PROFILE: 'no_student_profile',
  WRONG_INSTITUTION: 'wrong_institution',
  NOT_ENROLLED: 'not_enrolled',
  ALREADY_PRESENT: 'already_present',
};

/**
 * Audio constraints from `backend/app/pipelines/voice.py`. The browser has to
 * satisfy these before uploading, because the server rejects a clip that is too
 * short and the round trip is wasted.
 */
export const AUDIO = {
  SAMPLE_RATE: 16000,
  MIN_VOICED_SECONDS: 1.5,
  MAX_CLIP_SECONDS: 20.0,
};

/** Enrollment sample counts from `backend/app/services/enrollment.py`. */
export const SAMPLES = {
  FACE_MIN: 2,
  FACE_MAX: 5,
  VOICE_MIN: 1,
  VOICE_MAX: 3,
};

/** How often the live session view polls, in ms. Matches the backend's design note. */
export const LIVE_POLL_MS = 3000;
