# SnapAttend API reference

Version **1.0.0**. Every path below is real — this document was written against
`backend/app/routes/*.py`, not from a plan.

Nine blueprints, one error envelope, no versioned URL prefix. The API is JSON in and
JSON out, with three deliberate exceptions: CSV exports (`text/csv`), class-photo and
CSV *uploads* (`multipart/form-data`), and QR codes plus review crops (base64 data
URLs embedded in JSON, so there is no image endpoint and nothing on disk).

## Contents

- [Conventions](#conventions)
  - [The error envelope](#the-error-envelope)
  - [Authentication](#authentication)
  - [Tenancy: 404, never 403](#tenancy-404-never-403)
  - [Rate limiting](#rate-limiting)
  - [Dates, ids and pagination](#dates-ids-and-pagination)
  - [CSV exports](#csv-exports)
- [Five semantics that are easy to get wrong](#five-semantics-that-are-easy-to-get-wrong)
- [App level](#app-level) — `GET /`, `GET /healthz`
- [`/api/auth`](#apiauth) — registration, sign-in, invites, passwords
- [`/api/subjects`](#apisubjects) — subjects and rosters
- [`/api/students`](#apistudents) — student records, CSV import, biometrics
- [`/api/sessions`](#apisessions) — sessions, QR, class photo, review queue
- [`/api/attendance`](#apiattendance) — check-in, overrides, a student's own record
- [`/api/analytics`](#apianalytics) — reports, trends, defaulters
- [`/api/enroll`](#apienroll) — a student enrolling their own biometrics
- [`/api/admin`](#apiadmin) — institution, users, audit, privacy, alerts
- [`/api/public`](#apipublic) — the one unauthenticated endpoint
- [Enumerations](#enumerations)

---

## Conventions

### The error envelope

Every failure — validation, permission, rate limit, unhandled exception — is the same
shape, produced by `ApiError.to_response()` in `backend/app/utils/errors.py`:

```json
{
  "error": {
    "code": "conflict",
    "message": "A subject with that code already exists.",
    "details": { "code": "CS101" }
  }
}
```

`message` is written for a human and is safe to display verbatim. `code` is stable and
safe to branch on. `details` is free-form and often absent; where an endpoint puts
something useful in it, this document says so.

When a route raises without naming a code, the code is derived from the status:

| Status | Default `code` |
| --- | --- |
| 400 | `bad_request` |
| 401 | `unauthorized` |
| 403 | `forbidden` |
| 404 | `not_found` |
| 409 | `conflict` |
| 413 | `payload_too_large` |
| 422 | `unprocessable` |
| 429 | `rate_limited` |
| 500 | `server_error` |
| 503 | `service_unavailable` |

The convenience constructors (`bad_request`, `conflict`, `unprocessable`, …) turn
keyword arguments into `details`, which is why you see `details.hint`,
`details.session_id` and `details.allowed` on specific errors below.

**`GET /healthz` is the one endpoint that does not use the envelope.** Its 503 is a
complete diagnostic payload, not an error — see [App level](#app-level).

### Authentication

Flask-JWT-Extended, **headers only**. There is no cookie, so there is no CSRF surface
and `supports_credentials` is `False` on the CORS config.

```
Authorization: Bearer <access_token>
```

| Token | Lifetime | Env override |
| --- | --- | --- |
| access | 30 minutes | `JWT_ACCESS_TOKEN_MINUTES` |
| refresh | 14 days | `JWT_REFRESH_TOKEN_DAYS` |

Six endpoints need no token at all: `GET /`, `GET /healthz`,
`POST /api/auth/register-institution`, `POST /api/auth/login`,
`POST /api/auth/forgot-password`, `POST /api/auth/reset-password`, plus
`GET /api/auth/invite` and `POST /api/auth/accept-invite` (which authenticate with a
signed invite token instead) and `GET /api/public/scan` (which reads a JWT if one is
present but works without).

`POST /api/auth/refresh` is the only endpoint that takes the **refresh** token in the
`Authorization` header. Sending an access token there fails.

Roles are `admin`, `teacher`, `student`. Below, **staff** means `admin` *or*
`teacher`. A teacher is additionally scoped to the subjects they are assigned to: a
teacher calling a subject-scoped endpoint for someone else's subject gets a 404.

### Tenancy: 404, never 403

Every document carries an `institution_id` and every query filters on it. A request
for a resource that exists in another institution returns **404**, not 403, because a
403 would confirm the resource exists. Do not read a 404 as "wrong id" — it may be
"not yours".

### Rate limiting

Flask-Limiter with `RATELIMIT_STORAGE_URI = "memory://"`. **There is no global default
limit** — an endpoint is limited only if this document says so. Limits are per client
IP.

`RATELIMIT_HEADERS_ENABLED` is on, so limited responses carry `X-RateLimit-*` and a
429 carries `Retry-After` in seconds.

Two endpoints are deliberately *un*-limited despite being hit hard:
`GET /api/sessions/<id>/live` (the 3-second poll behind the live console) and
`POST /api/attendance/override` (a teacher correcting a roster in a hurry must never
be throttled).

Uploads are capped by `MAX_CONTENT_LENGTH` (`MAX_UPLOAD_MB`, default 16 MB) — exceeded
before any route code runs, giving a 413. Individual endpoints cap tighter: 16 MB for
a class photo, 8 MB per enrollment sample, 4 MB for a voice check-in clip, 512 KB for
a student CSV.

### Dates, ids and pagination

- **Ids** are Mongo ObjectId hex strings. A malformed id is a 400, not a 404.
- **Timestamps** in responses are ISO-8601 UTC with a `Z` suffix.
- **`?since` / `?until`** appear on most reporting endpoints, parse ISO-8601, and are
  **silently ignored when unparseable** rather than rejected. That is intentional: a
  bad date should narrow nothing, not break a dashboard.
- **`?limit`** always has a default and a hard ceiling, both listed per endpoint. Only
  `GET /api/admin/audit` supports `?skip`; nothing here is cursor-paginated.
- **Repeatable params** (`?subject_id=a&subject_id=b`) are read with `getlist`. Bracket
  syntax (`subject_id[]=a`) does *not* work — the frontend's axios instance has an
  explicit serializer for exactly this reason.

### CSV exports

Seven endpoints return `text/csv` instead of JSON. Each one:

- prepends a **UTF-8 BOM**, so Excel opens accented names correctly;
- sets `Content-Disposition: attachment; filename="..."` with a timestamped name
  (`attendance-cs101-20260830-1412.csv`);
- sets `Cache-Control: no-store`.

The backend exposes `Content-Disposition` through CORS (`expose_headers`), so a
browser fetch can read the filename rather than inventing one.

A CSV endpoint that *fails* still returns the JSON error envelope — with a
`Content-Type` of JSON, but a client that requested `responseType: 'blob'` will
receive it as a blob and has to parse it.

---

## Five semantics that are easy to get wrong

**1. A check-in returns 200 for all three outcomes.** `POST /api/attendance/qr` and
the accepting branch of `POST /api/attendance/voice` return 200 whether the student
was *newly* marked, was *already* present, or was *blocked by a teacher's override*.
Read the body, not the status:

```json
{ "ok": true,  "created": true,  "already_present": false, "blocked_by_override": false }
{ "ok": true,  "created": false, "already_present": true,  "blocked_by_override": false }
{ "ok": false, "created": false, "already_present": false, "blocked_by_override": true  }
```

`ok` is `false` only in the third case. A manual override always wins: once a teacher
has marked a student absent by hand, a later QR scan does not silently undo it.

**2. A rejected voice sample is a 200, not a 401.** Failing 1:1 speaker verification
is a normal outcome, so `POST /api/attendance/voice` answers
`{"ok": false, "accepted": false, "can_retry": true, ...}` with the distance and the
voiced duration so the UI can say *why*. Only a broken request (wrong mode, not
enrolled, unreadable audio) is a 4xx.

**3. `invite_url` and `reset_url` appear only when SMTP is unconfigured.** With mail
configured, an invite response carries `email_sent: true` and no URL. With mail off,
the link comes back in the response so the UI can show a copyable field. Never assume
the key exists; never assume it does not.

**4. `session_roster_view` is already sorted — do not re-sort it.** Present students
first, then alphabetical by lowercased name. That ordering is the product behaviour of
the live console: newly-marked students rise to the top.

**5. Empty active sessions are excluded from analytics denominators.** A session that
is open but has nobody marked yet would otherwise drag every percentage down while a
class is still walking in. `sessions_excluded` in a subject report tells you how many
were dropped.

---

## App level

Registered directly on the app in `backend/app/__init__.py`, outside every blueprint.

### `GET /`

No auth. Identifies the service.

```json
{
  "name": "SnapAttend API",
  "version": "1.0.0",
  "docs": "See README.md for the endpoint reference.",
  "health": "/healthz"
}
```

### `GET /healthz`

No auth. A **real readiness probe**: `200` with `"status": "ok"` only when every
dependency answers, `503` with `"status": "degraded"` otherwise. Both statuses return
the same complete body — the 503 is the diagnostic, so a client should treat it as
data rather than an error.

```json
{
  "status": "ok",
  "version": "1.0.0",
  "environment": "development",
  "time": "2026-08-30T14:12:03Z",
  "missing_settings": [],
  "checks": {
    "mongodb": { "ok": true, "database": "Attendance_System", "configured": true },
    "chroma":  { "ok": true, "face_embeddings": 128, "voice_embeddings": 96,
                 "persist_dir": "…/chroma" },
    "mail":    { "ok": true, "configured": true, "server": "smtp.gmail.com",
                 "port": 587, "sender": "no-reply@example.edu",
                 "suppressed": false, "queued": 0 },
    "face_crops": { "review_items_total": 3, "crops_retained": 3,
                    "unresolved_items": 3, "resolved_but_crop_retained": 0,
                    "crop_ttl_hours": 24, "class_photos_stored": 0,
                    "enrollment_images_stored": 0 }
  }
}
```

`missing_settings` names environment variables that were never set and is usually the
actual cause of a degraded reading — far more useful than `mongodb: not ok`.

Overall health is `all(c.get("ok", True) for c in checks.values())`: **a check with no
`ok` key counts as passing.** `face_crops` has no `ok` key, which is why it never
turns the probe red on its own. A client filtering for failures must test
`checks[name].ok === false`, not `!checks[name].ok`.

`resolved_but_crop_retained` should always be `0`. A non-zero value means a review
crop outlived its queue item, which is a retention-policy violation worth
investigating.

---

## `/api/auth`

### `POST /api/auth/register-institution`

No auth. **`5 per hour; 20 per day`.** The only self-service signup in the product: it
creates the tenant and makes the caller its admin. Everyone else arrives by invitation.

Body: `institution_name`, `name`, `email`, `password`, optional `slug`.

**201** →

```json
{
  "access_token": "…", "refresh_token": "…",
  "token_type": "Bearer", "expires_in": 1800,
  "user": {
    "id": "…", "email": "dean@example.edu", "name": "Dean",
    "role": "admin", "status": "active", "institution_id": "…",
    "institution": { "id": "…", "name": "Example Institute", "slug": "example-institute",
                     "settings": { "attendance_threshold": 75,
                                   "low_attendance_alerts_enabled": true,
                                   "alert_cooldown_days": 7 } }
  }
}
```

**409** on a duplicate email or a duplicate slug. An omitted slug is derived from the
institution name and made unique automatically with a `-2`, `-3` suffix, so it never
collides — only an *explicit* slug can conflict.

### `POST /api/auth/login`

No auth. **`10 per minute; 60 per hour`.** Body: `email`, `password`.

**200** → the same `{**tokens, user}` shape as registration.

An unknown email and a wrong password return **one identical 401**, deliberately: a
distinguishable response is an account-enumeration oracle. Two 403s *are*
distinguishable, because in both cases the credentials were correct and the user needs
to be told what to do:

| Status | `code` | Meaning |
| --- | --- | --- |
| 401 | `unauthorized` | wrong email **or** wrong password |
| 403 | `account_disabled` | an admin disabled this account |
| 403 | `account_not_activated` | invited but never accepted — use the invite link |

### `POST /api/auth/refresh`

**Refresh token** in the `Authorization` header. Not rate-limited.

```json
{ "access_token": "…", "token_type": "Bearer", "expires_in": 1800, "user": { … } }
```

No new refresh token is issued — the original stays valid for its full 14 days.

### `GET /api/auth/me`

Any authenticated user. → `{ "user": { … } }`.

For a student the `user` object gains a `student` block:

```json
"student": { "id": "…", "roll_number": "21CS004", "enrollment_status": "complete",
             "face_enrolled": true, "voice_enrolled": true }
```

### `POST /api/auth/logout`

Any authenticated user. → `{ "ok": true, "message": "Signed out" }`.

**A no-op server-side.** There is no token blocklist; JWTs stay valid until they
expire. The client discards them. This is called for symmetry and for the audit-free
convenience of having an endpoint to hit.

### `POST /api/auth/change-password`

Any authenticated user. **`10 per hour`.** Body: `current_password`, `new_password`.

→ `{ "ok": true, "message": "…" }`. **401** if `current_password` is wrong.

Existing tokens keep working — the password hash is not part of the JWT.

### `POST /api/auth/forgot-password`

No auth. **`5 per hour; 20 per day`.** Body: `email`.

**Always 200, always the same message**, whether or not the address exists:

```json
{ "ok": true, "message": "If that email address has an account, a reset link is on its way." }
```

`reset_url` is added only when `MAIL_SUPPRESS_SEND` is on, for local development.

An invited-but-never-activated account gets nothing: it has no password to reset, and
the invite link is the correct path in.

### `POST /api/auth/reset-password`

No auth. **`10 per hour`.** Body: `token`, `password`.

→ `{ "ok": true, "message": "…" }`. **Returns no tokens** — the user signs in
afterwards, which proves the new password works.

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `token_invalid` | malformed, tampered with, or expired |
| 400 | `token_used` | already redeemed |

Single use is achieved without any server-side state: the token embeds a fingerprint of
the password hash it was issued against, so changing the password invalidates it.

### `GET /api/auth/invite?token=…`

No auth. **`30 per hour`.** Reads an invite so the accept screen can show who it is for
before asking for a password.

```json
{
  "email": "ada@example.edu", "name": "Ada Lovelace",
  "role": "student", "invite_type": "student",
  "institution": { "name": "Example Institute", "slug": "example-institute" },
  "needs_biometrics": true
}
```

### `POST /api/auth/accept-invite`

No auth. **`10 per hour`.** Body: `token`, `password`, optional `name` (overrides the
name the inviter typed).

**201** → `{**tokens, user}`, plus for a student:

```json
{ "next_step": "biometrics", "enrollment_status": "pending_biometrics" }
```

The caller is signed in immediately, so the biometric wizard is one navigation away
rather than another sign-in.

### `GET /api/auth/institution`

Any authenticated user. → `{ "institution": { … } }` — the full document including
`settings`. Read-only; admins write settings through `PATCH /api/admin/institution`.

---

## `/api/subjects`

Staff only throughout. A teacher sees and manages only their own subjects.

Every response wraps a subject in this view (`_subject_view`): the stored document plus
`teachers`, and — on the list and detail endpoints — the counts:

```json
{
  "id": "…", "name": "Data Structures", "code": "CS101",
  "attendance_threshold": 80, "archived": false,
  "teacher_ids": ["…"], "institution_id": "…",
  "created_at": "…", "updated_at": "…",
  "teachers": [{ "id": "…", "name": "Grace Hopper", "email": "grace@example.edu" }],
  "roster_size": 42, "session_count": 18
}
```

`attendance_threshold` may be `null`, meaning *inherit the institution default*. That
is a distinct state from a stored number equal to the default.

### `GET /api/subjects`

`?include_archived=1|true|yes` to include archived subjects (default: hidden).

→ `{ "subjects": [ … ] }`

### `POST /api/subjects`

Body: `name`, `code`, optional `teacher_ids`, optional `attendance_threshold`.

`code` is uppercased and stripped of spaces, and must be 2–24 characters. **201** →
`{ "subject": { … } }`. **409** if the code is already used in this institution.

A teacher creating a subject is assigned to it automatically — otherwise they would
immediately lose access to the thing they just made.

### `GET /api/subjects/<id>`

→ `{ "subject": { … }, "effective_threshold": 80 }`

`effective_threshold` resolves the inheritance for you, so a client never has to know
the institution default.

### `PATCH /api/subjects/<id>`

Body may contain `name`, `code`, `attendance_threshold`, `archived`, `teacher_ids`.
An empty body is **400 "Nothing to update"**.

- **`attendance_threshold: null` is meaningful** — it clears the override and returns
  the subject to inheriting the institution default. Omitting the key leaves it alone.
- **`teacher_ids` is admin-only** (409 for a teacher — reassigning teachers is not a
  teacher's call). An empty array is a 400: a subject with no teacher is unreachable.

→ `{ "subject": { … } }`

### `DELETE /api/subjects/<id>`

**409 if the subject has any sessions**, with the count and the alternative in
`details`:

```json
{ "error": { "code": "conflict",
             "message": "…",
             "details": { "session_count": 18, "hint": "Archive it instead" } } }
```

Attendance history is not something to lose to a stray click. A subject with no
sessions deletes cleanly → `{ "ok": true, "deleted": true }`.

### `GET /api/subjects/<id>/roster`

```json
{
  "roster": [
    { "student_id": "…", "name": "Ada Lovelace", "email": "ada@example.edu",
      "roll_number": "21CS004", "enrollment_status": "complete",
      "face_enrolled": true, "voice_enrolled": true, "joined_at": "…" }
  ],
  "count": 42
}
```

Sorted by lowercased name.

### `POST /api/subjects/<id>/roster`

Body: `student_ids` (array), or `student_id` for one.

```json
{ "ok": true, "added": ["…"], "already_enrolled": ["…"], "rejected": ["…"], "roster_size": 43 }
```

Partial success by design: one bad id in a bulk add does not discard the good ones.
`rejected` holds ids that are not students of this institution.

### `DELETE /api/subjects/<id>/roster/<student_id>`

→ `{ "ok": true, "removed": true, "roster_size": 42 }`. **400** if the student is not
on the roster.

**Attendance history is deliberately retained.** Removing a student from a roster does
not rewrite what happened in past sessions; it only stops them appearing in future
ones.

### `GET /api/subjects/<id>/available-students`

Students of this institution *not* on this roster — the candidate list for the add
dialog.

```json
{
  "students": [
    { "student_id": "…", "name": "Alan Turing", "email": "alan@example.edu",
      "roll_number": "21CS007", "enrollment_status": "pending_biometrics",
      "face_enrolled": false, "account_status": "active" }
  ],
  "count": 17
}
```

Disabled accounts are omitted.

---

## `/api/students`

Staff only throughout. `_student_view` is the shape everywhere:

```json
{
  "student_id": "…", "user_id": "…",
  "name": "Ada Lovelace", "email": "ada@example.edu", "account_status": "active",
  "roll_number": "21CS004", "enrollment_status": "complete",
  "face_enrolled": true, "voice_enrolled": true,
  "face_sample_count": 4, "voice_sample_count": 2,
  "created_at": "…"
}
```

### `GET /api/students`

| Param | Notes |
| --- | --- |
| `subject_id` | restrict to one subject's roster |
| `enrollment_status` | `invited` \| `pending_biometrics` \| `complete` |
| `face_enrolled` | `0` / `false` to find students who still need enrollment |
| `q` | substring match over name, email and roll number |
| `limit` | default 200, max 1000 |

→ `{ "students": [ … ], "count": 200 }`

### `GET /api/students/<id>`

```json
{
  "student": { … },
  "subjects": [{ "id": "…", "name": "Data Structures", "code": "CS101" }],
  "enrollment": {
    "student_id": "…", "enrollment_status": "pending_biometrics", "complete": false,
    "passphrase": "attendance is a promise kept",
    "steps": [
      { "key": "face", "label": "Face", "done": true, "detail": "4 samples",
        "required_samples": 2, "vector_present": true },
      { "key": "voice", "label": "Voice", "done": false, "detail": "Not recorded yet",
        "required_samples": 1, "vector_present": false }
    ]
  }
}
```

`vector_present` is read back from Chroma rather than trusted from the Mongo flag, so
a student whose vector was lost in a rebuild shows as needing re-enrollment instead of
silently never matching.

### `POST /api/students`

Body: `email`, `name`, optional `subject_id`, optional `roll_number` (max 32 chars).

**201** → the standard invite response plus `student_id`:

```json
{
  "ok": true, "user_id": "…", "invite_id": "…", "student_id": "…",
  "email": "ada@example.edu", "name": "Ada Lovelace",
  "created_user": true, "email_sent": false,
  "invite_url": "http://localhost:5173/accept-invite?token=…",
  "enrolled_in_subject": true
}
```

`invite_url` is present **only when SMTP is unconfigured**. `email_sent` reflects
whether a mail server exists, not whether delivery succeeded.

### `POST /api/students/import`

Bulk invite from CSV. Either `multipart/form-data` with a `file` field, or JSON with a
`csv` string. Optional `subject_id` and `dry_run`. Max **512 KB**.

Expected columns are `name,email`; a header row is detected and skipped.

**`dry_run` → 200**, nothing written:

```json
{
  "dry_run": true,
  "would_invite": [{ "name": "Ada Lovelace", "email": "ada@example.edu" }],
  "would_invite_count": 38,
  "row_errors": [{ "row": 12, "message": "Not a valid email address", "value": "ada@" }],
  "subject": { "id": "…", "name": "Data Structures", "code": "CS101" }
}
```

**Real run → 201:**

```json
{
  "ok": true,
  "invited": [ … ], "invited_count": 38,
  "skipped": [{ "email": "grace@example.edu", "reason": "already a user" }],
  "row_errors": [ … ],
  "enrolled_in_subject": 38,
  "subject": { … },
  "emails_sent": false
}
```

**Partial success is deliberate.** 38 good rows are imported even when 2 rows are
malformed; the failures come back in `row_errors` for the operator to fix and re-run.
Only when *no* row is usable is it a **400**, with `details.row_errors` (first 25) and
`details.error_count`.

Always run with `dry_run` first. That is what it is for.

### `GET /api/students/import/template`

CSV, `snapattend-students-template.csv`:

```
name,email
Ada Lovelace,ada@example.edu
Alan Turing,alan@example.edu
```

### `PATCH /api/students/<id>`

Body: `roll_number` and/or `name`. Empty body → **400 "Nothing to update"**.
→ `{ "student": { … } }`

Email is not editable — it is the identity the account signs in with.

### `POST /api/students/<id>/reset-biometrics`

Body: **`reason` (required)**, plus `face` and `voice` (both default `true`). Setting
both to `false` is a 400.

```json
{ "ok": true, "message": "…", "enrollment_status": "pending_biometrics",
  "face_cleared": true, "voice_cleared": false }
```

Deletes the vectors from Chroma and clears the flags, so the student re-enrolls. Audit
logged with the reason — a staff member wiping someone's biometrics has to say why.

### `GET /api/students/<id>/attendance`

`?limit` default 50, max 200. Also honours `?since` / `?until`.

→ `{ "student": { … }, "report": { … }, "history": [ … ] }` — see
[`/api/analytics`](#apianalytics) for the `report` and `history` shapes.

A teacher sees only the subjects they teach, so the same URL legitimately returns
different data for a teacher and an admin.

### `POST /api/students/<id>/resend-invite`

→ the standard invite response. **409** if the account is already active — there is
nothing to accept.

---

## `/api/sessions`

Staff only throughout. Limits: `MAX_PHOTO_BYTES` 16 MB, default duration 60 minutes,
maximum 12 hours.

`_session_view` **omits `qr_current_token`, `qr_current_nonce` and
`qr_previous_nonce`** — the live token is only ever handed out by the two QR-bearing
endpoints, never as a side effect of reading a session. It adds derived fields:

```json
{
  "id": "…", "subject_id": "…", "teacher_id": "…", "institution_id": "…",
  "title": "Week 6 — Balanced trees",
  "verification_mode": "class_photo_qr", "mode_label": "Class Photo + QR",
  "uses_photo": true, "uses_qr": true, "uses_voice": false,
  "status": "active", "is_open": true,
  "start_time": "…", "end_time": "…",
  "photo_review_status": "pending_review",
  "created_at": "…", "updated_at": "…",
  "subject": { "id": "…", "name": "Data Structures", "code": "CS101" },
  "present_count": 31, "roster_size": 42, "absent_count": 11
}
```

`is_open` is computed from `status` *and* the clock: an `active` session past its
`end_time` is not open, and self-service check-in refuses it.

### `GET /api/sessions`

`?subject_id`, `?status` (`active` | `ended`), `?since`, `?until`, `?limit` default 50
max 200. → `{ "sessions": [ … ] }`, newest first.

### `POST /api/sessions`

Body: `subject_id` (required), `verification_mode` (required, one of the four),
optional `title`, optional `start_time` / `end_time` / `duration_minutes`.

Defaults to starting now and running 60 minutes. `duration_minutes` clamps to 5…720
and is ignored when `end_time` is given. `end_time <= start_time` is a 400; a span over
12 hours is a 400.

**201** →

```json
{
  "session": { … },
  "coverage": { "roster_size": 42, "face_enrolled": 38, "vectors_present": 38,
                "missing": [{ "student_id": "…", "name": "Alan Turing" }] },
  "qr": { "token": "…", "expires_at": "…", "ttl_seconds": 30,
          "png_data_url": "data:image/png;base64,…",
          "target_url": "http://localhost:5173/scan?t=…" }
}
```

`coverage` is `null` for modes with no photo step. `qr` is present only for modes with
a QR step — minted immediately so the teacher's screen has something to project the
moment the session opens.

Three 409s:

| `message` | `details` |
| --- | --- |
| the subject is archived | — |
| the roster is empty | `hint: "POST /api/subjects/<id>/roster"` |
| this subject already has an open session | `session_id` of the existing one |

The last one catches a double-click and a teacher who forgot to end this morning's
class — either would split one class's attendance across two records.

### `GET /api/sessions/<id>`

→ `{ "session": { … }, "roster": [ … ], "review_queue_count": 2 }`

`roster` is `session_roster_view` — see
[`GET /api/attendance/session/<id>`](#get-apiattendancesessionsession_id) for the row
shape. **Already sorted; do not re-sort.**

### `PATCH /api/sessions/<id>`

Body: `title` and/or `end_time` (to extend a running class). Empty → **400 "Nothing to
update"**.

**Sending `verification_mode` is a 409, always.** The mode is immutable once created:
students may already have checked in under it, and switching would leave recorded
`method_used` values inconsistent with the session. End it and open a new one.

### `POST /api/sessions/<id>/end`

→ `{ "session": { … }, "crops_discarded": 2 }`

Ending a session **immediately deletes that session's review-queue crops** — the
retention promise, enforced at the moment the crops stop being needed. Calling it
twice is safe: → `{ "session": { … }, "already_ended": true }`.

### `GET /api/sessions/<id>/live`

**The 3-second poll. Not rate-limited.**

```json
{
  "session": { … }, "roster": [ … ],
  "present_count": 31, "absent_count": 11, "review_queue_count": 2,
  "server_time": "2026-08-30T14:12:03Z",
  "qr": { "token": "…", "expires_at": "…", "ttl_seconds": 30,
          "png_data_url": "data:image/png;base64,…", "target_url": "…" }
}
```

**QR rotation is a side effect of this call.** The poll that refreshes the roster is
the same poll that mints the next 30-second token, so the projected code stays live
without a second request. `qr` is absent for modes without a QR step.

Use `server_time` — not the browser clock — as the reference for the countdown. A
laptop with a skewed clock would otherwise show a code as expired while students are
successfully scanning it.

### `GET /api/sessions/<id>/qr`

`?force=1|true|yes` to rotate immediately instead of waiting for the current token to
expire.

→ `{ "qr": { … } }`. **400** if the session's mode has no QR step. **409** if the
session is closed.

### `GET /api/sessions/<id>/coverage`

→ the `coverage` object shown above. Answers "if I take a photo now, who *cannot*
possibly be matched" — worth showing before the first upload rather than after.

### `POST /api/sessions/<id>/photo`

**`30 per hour`.** `multipart/form-data`, field `photo` (or `file`). Max 16 MB.
**409** if the session has ended.

Slow by nature — dlib detection on a wide classroom shot takes seconds, sometimes
tens of seconds. Client timeouts should be generous.

**201** →

```json
{
  "faces_detected": 34,
  "auto_matched": 29, "newly_marked": 27, "already_present": 2,
  "rejected": 1, "needs_review": 4,
  "photo_review_status": "pending_review",
  "duration_ms": 8210,
  "warnings": ["3 students on this roster have no face enrolled"],
  "roster_size": 42, "face_enrolled_count": 38,
  "matches": [
    { "student_id": "…", "name": "Ada Lovelace",
      "confidence": 0.94, "distance": 0.06,
      "face_box": { "top": 210, "right": 480, "bottom": 300, "left": 390 } }
  ],
  "review_items": [ … ]
}
```

`faces_detected` counts faces; `auto_matched` counts confident identifications;
`newly_marked` is the number of attendance rows actually created. They differ, and the
difference is the point: `already_present` students were matched again, `rejected`
faces were too small (under `MIN_FACE_PIXELS`, 48 px), and `needs_review` faces went
to the queue rather than being guessed at.

The uploaded image is decoded in memory and **never written to disk**.

### `GET /api/sessions/<id>/review`

`?include_resolved=1|true|yes`.

```json
{
  "items": [
    { "id": "…", "session_id": "…",
      "face_box": { "top": 210, "right": 480, "bottom": 300, "left": 390 },
      "crop_data_url": "data:image/jpeg;base64,…", "crop_available": true,
      "reason": "ambiguous",
      "best_guess_student_id": "…", "best_guess_name": "Ada Lovelace",
      "confidence_score": 0.71, "distance": 0.29,
      "resolved": false, "resolution": null,
      "assigned_student_id": null, "assigned_name": null,
      "created_at": "…", "expires_at": "…" }
  ],
  "count": 4,
  "assignable_students": [
    { "student_id": "…", "name": "Ada Lovelace", "status": "present", "face_enrolled": true }
  ],
  "photo_review_status": "pending_review"
}
```

`reason` is one of `low_confidence`, `no_match`, `ambiguous`, `low_resolution`.

`crop_available` can be `false` on an item that still exists: the crop expired (24 h
TTL) while the queue item did not. Render the box coordinates and the best guess, and
say the crop is gone — do not render a broken image.

`assignable_students` **includes students who are already present**, on purpose. The
common ambiguity is two faces competing for one identity, and resolving it correctly
sometimes means assigning a face to someone already marked.

### `POST /api/sessions/<id>/review/<pending_id>`

Body: `resolution` — one of `assigned`, `dismissed`, `not_a_student` — plus
`student_id` **required when `resolution` is `assigned`**.

```json
{ "resolved": true, "resolution": "assigned", "marked": true,
  "remaining_review_items": 3, "photo_review_status": "pending_review" }
```

`photo_review_status` flips to `resolved` when the last item is cleared, which is the
signal the live console uses to drop the review banner.

| Status | Meaning |
| --- | --- |
| 400 | `resolution` missing or not one of the three |
| 400 | `assigned` with no `student_id` |
| 400 | that student is not on this subject's roster |
| 404 | the queue item is gone (resolved elsewhere, or its TTL expired) |
| 409 | `already_resolved` |

`dismissed` means *this is a person, but not one I can identify*.
`not_a_student` means *that is a poster, a reflection, or someone walking past*. Both
clear the item without marking anyone; the distinction is preserved for the audit
trail.

### `DELETE /api/sessions/<id>/review`

→ `{ "ok": true, "crops_discarded": 4 }`

Abandons the queue and deletes every crop for the session. The privacy escape hatch: a
teacher who does not want to work through the queue can destroy the images now rather
than waiting for the TTL.

### `GET /api/sessions/<id>/export`

CSV, `session-<code>-<stamp>.csv`. One row per roster student with status, method,
confidence, override flag and reason.

---

## `/api/attendance`

Mixed roles — read each one. `MAX_AUDIO_BYTES` is 4 MB.

### `POST /api/attendance/qr`

**Student.** **`20 per minute; 200 per hour`.** Body: `token` (from the scanned URL).

**200** → the mark-result shape:

```json
{
  "ok": true, "status": "present", "created": true,
  "already_present": false, "blocked_by_override": false,
  "method": "qr", "confidence_score": null, "marked_at": "2026-08-30T14:12:03Z",
  "session": { "id": "…", "title": "Week 6 — Balanced trees",
               "subject": "Data Structures", "subject_code": "CS101" },
  "message": "You're marked present."
}
```

All three outcomes are 200 — see
[semantics #1](#five-semantics-that-are-easy-to-get-wrong).

| Status | `code` | Meaning |
| --- | --- | --- |
| 400 | `token_invalid` | not a real token, or tampered with |
| 400 | `qr_rotated` | the code moved on — rescan |
| 403 | `not_enrolled` | the student is not on this subject's roster |
| 409 | `session_ended` | — |
| 409 | `window_closed` | still `active`, but past `end_time` |

`qr_rotated` is not a hard failure. Each rotation keeps the *previous* nonce valid for
one window, so a student who scanned as the code changed still succeeds; this error
means they were two rotations behind, which is what a forwarded screenshot looks like.

### `POST /api/attendance/voice`

**Student.** **`10 per minute; 60 per hour`.** Body: `session_id`, `audio` (data URL or
bare base64). Max 4 MB.

The clip must be **16 kHz mono 16-bit PCM WAV**. There is no ffmpeg on the server and
`soundfile` cannot read WebM/Opus, so the conversion happens in the browser
(`frontend/src/lib/audio.js`). Sending a raw MediaRecorder blob fails.

**Accepted → 200:** the mark-result shape above, plus
`"accepted": true, "distance": 0.18, "confidence": 0.82`.

**Rejected → 200, not 4xx:**

```json
{
  "ok": false, "accepted": false,
  "message": "That didn't sound like your enrolled voice. Try again somewhere quieter.",
  "distance": 0.41, "confidence": 0.44,
  "voiced_seconds": 2.3, "can_retry": true
}
```

Real errors:

| Status | `code` | `details` |
| --- | --- | --- |
| 403 | `not_enrolled` | not on this subject's roster |
| 409 | `mode_mismatch` | `verification_mode` — this session does not accept voice |
| 409 | `voice_not_enrolled` | no voiceprint on file |
| 422 | `unprocessable` | under 1.5 s of *voiced* audio, or unreadable |
| 503 | `voice_pipeline_unavailable` | Resemblyzer/librosa not importable |

Note that `voice` is a valid method for the `voice` mode **and** nothing else —
`class_photo_qr` does not include voice. `VerificationMode.includes_voice` is true only
for `voice`.

### `POST /api/attendance/override`

**Staff. Not rate-limited** — a teacher fixing a roster in front of a class must never
be throttled.

Body: `session_id`, `student_id`, `present` (must be a JSON boolean, not `"true"`),
optional `reason`.

**`reason` is effectively mandatory.** It is validated by `clean_reason`, which rejects
blank and near-empty values: an override with no explanation is indistinguishable from
a mistake six weeks later.

Intended response:

```json
{ "created": false, "status": "present", "message": "Student marked present",
  "record": { … }, "blocked_by_override": false }
```

> **Known defect in 1.0.0.** The route returns `jsonify(result)` where `result` is the
> `MarkResult` dataclass carrying the **raw Mongo document** in `record`. Flask
> serializes the dataclass but cannot serialize the `ObjectId` values inside `record`,
> so this endpoint raises `TypeError` and answers **500** — *after* the write and the
> audit entry have already committed. The override takes effect; the client is told it
> failed. Two consequences for a client: do not depend on this response body, and
> re-read `GET /api/sessions/<id>/live` for the truth. The fix is one line in
> `backend/app/routes/attendance.py` — pass `record` through `serialize_doc`, or build
> the response the way `_mark_result_response` does (it omits `record`, which is why
> the QR and voice paths are unaffected). See
> [Known defects](#appendix-known-defects-in-100).

Errors: **400** if the student is not on the roster (with
`details.hint: "Add them to the roster first, then override."`), **400** if `present`
is not a boolean, **403** if the caller does not manage the session, **404** if the
session is not theirs.

### `POST /api/attendance/override/bulk`

**Staff.** Body: `session_id`, `student_ids` (non-empty array, **max 200**), `present`,
optional `reason`.

```json
{ "ok": true,
  "applied": ["…", "…"], "applied_count": 2,
  "skipped": [{ "student_id": "…", "reason": "not_on_roster" }],
  "status": "present" }
```

Exists because "mark the six students who were on the field trip present" is otherwise
six requests, and a teacher typing the same reason six times starts typing "x". One
reason, **one audit entry per student**, still fully logged.

This endpoint builds its response by hand and is not affected by the defect above.

### `GET /api/attendance/me`

**Student.** `?limit` default 30 max 100, plus `?since` / `?until`.

```json
{
  "report": { "student_id": "…",
              "overall": { "present": 96, "total": 120, "percentage": 80.0 },
              "subjects": [ … ] },
  "history": [ … ],
  "enrollment": { "face_enrolled": true, "voice_enrolled": true, "status": "complete" }
}
```

### `GET /api/attendance/me/open-sessions`

**Student.** The check-in screen's whole data source.

```json
{
  "sessions": [
    { "session_id": "…", "title": "Week 6 — Balanced trees",
      "subject": "Data Structures", "subject_code": "CS101",
      "verification_mode": "voice", "mode_label": "Voice only",
      "action": "voice", "closes_at": "2026-08-30T15:00:00Z",
      "already_present": false, "needs_voice_enrollment": false }
  ],
  "server_time": "2026-08-30T14:12:03Z"
}
```

**Only self-service modes appear** — `qr` and `voice`. A `class_photo` session is not
something a student can act on, so listing it would offer a button that cannot work.

`action` tells the UI which control to render. `needs_voice_enrollment` is the case
where the session wants voice and the student has none: show the enrollment link, not
a record button.

### `GET /api/attendance/me/export`

**Student.** CSV, `my-attendance-<stamp>.csv`. A student can export their own record —
the transparency counterpart to being measured by it.

### `GET /api/attendance/session/<session_id>`

**Staff.**

```json
{
  "session_id": "…", "verification_mode": "class_photo_qr",
  "rows": [
    { "student_id": "…", "name": "Ada Lovelace", "email": "ada@example.edu",
      "roll_number": "21CS004", "enrollment_status": "complete",
      "face_enrolled": true, "voice_enrolled": true,
      "status": "present", "method_used": "face_photo",
      "confidence_score": 0.94, "was_manual_override": false,
      "override_reason": null, "marked_at": "2026-08-30T14:12:03Z" }
  ],
  "present_count": 31, "absent_count": 11,
  "by_method": { "face_photo": 27, "qr": 3, "manual": 1 }
}
```

`rows` is present-first, then alphabetical by lowercased name.
`confidence_score` is `null` for `qr` and `manual` — there is no score for a scan or a
human decision, and a stale number there would be a lie.

---

## `/api/analytics`

Staff only throughout. An admin sees the whole institution; a teacher sees only their
own subjects.

`?subject_id` is repeatable and is **intersected** with the caller's scope, never
unioned. A teacher passing another teacher's subject id narrows the result to nothing
rather than widening their access.

Denominator rules that make the numbers trustworthy:

- **Empty active sessions are excluded.** A session open with nobody marked yet is not
  yet evidence of anything. `sessions_excluded` reports how many were dropped.
- **Late joiners are handled.** A student added to a roster in week 6 is measured
  against the sessions since they joined, not against week 1.

### `GET /api/analytics/overview`

Role-dependent. **Admin:**

```json
{
  "students_total": 412, "teachers_total": 18, "pending_invites": 7,
  "subjects_total": 24, "sessions_total": 318, "active_sessions": 2,
  "attendance_records": 11840,
  "overall_attendance": 82.4,
  "face_enrolled": 388, "voice_enrolled": 351, "enrollment_completion": 85.2,
  "threshold": 75,
  "generated_at": "2026-08-30T14:12:03Z"
}
```

**Teacher:**

```json
{
  "subjects": [
    { "subject_id": "…", "name": "Data Structures", "code": "CS101",
      "roster_size": 42, "sessions_total": 18,
      "average_attendance": 84.1, "defaulter_count": 5, "threshold": 80 }
  ],
  "sessions_total": 46, "average_attendance": 81.7
}
```

### `GET /api/analytics/subjects/<id>`

Honours `?since` / `?until`. Returns the report directly, not wrapped:

```json
{
  "subject": { "id": "…", "name": "Data Structures", "code": "CS101" },
  "threshold": 80,
  "sessions_total": 18, "sessions_excluded": 1,
  "students_total": 42, "class_average": 84.1, "defaulter_count": 5,
  "students": [
    { "student_id": "…", "name": "Alan Turing", "email": "alan@example.edu",
      "roll_number": "21CS007",
      "present": 9, "total": 17, "absent": 8,
      "percentage": 52.9, "below_threshold": true }
  ]
}
```

`students` is sorted worst-first (by percentage, then name) — the list is for finding
who needs attention, so the answer is at the top.

### `GET /api/analytics/subjects/<id>/trend`

`?limit` default 20, min 2, max 60.

```json
{
  "subject": { "id": "…", "name": "Data Structures", "code": "CS101" },
  "subject_id": "…",
  "points": [
    { "session_id": "…", "date": "2026-07-14", "label": "Jul 14",
      "present": 38, "eligible": 42, "percentage": 90.5, "status": "ended" }
  ]
}
```

**Oldest first**, ready to plot left to right. `eligible` is the late-joiner-aware
denominator, so it can differ between points for the same subject.

### `GET /api/analytics/subjects/<id>/export`

CSV, `attendance-<CODE>-<stamp>.csv`. Honours `?since` / `?until`.

### `GET /api/analytics/students/<id>`

```json
{
  "report": {
    "student_id": "…",
    "overall": { "present": 96, "total": 120, "percentage": 80.0 },
    "subjects": [
      { "subject_id": "…", "subject_name": "Data Structures", "subject_code": "CS101",
        "present": 15, "total": 18, "absent": 3,
        "percentage": 83.3, "threshold": 80, "below_threshold": false }
    ]
  }
}
```

`subjects` is sorted by percentage ascending. For a **teacher**, `subjects` is filtered
to their own and `overall` is **recomputed** from that subset, with
`"scoped_to_your_subjects": true` added so the UI can label the figure honestly rather
than presenting a partial number as the student's overall attendance.

### `GET /api/analytics/students/<id>/export`

**Admin only.** A teacher gets a 400 with `details.hint` pointing at the per-subject
export — a single teacher should not be able to walk out with a student's complete
cross-subject record.

### `GET /api/analytics/defaulters`

`?threshold` to override the configured one, `?min_sessions` default **3** (1–100),
plus `?subject_id`, `?since`, `?until`.

```json
{
  "defaulters": [
    { "student_id": "…", "name": "Alan Turing", "email": "alan@example.edu",
      "roll_number": "21CS007",
      "subject_id": "…", "subject_name": "Data Structures", "subject_code": "CS101",
      "present": 9, "total": 17, "percentage": 52.9,
      "threshold": 80, "shortfall": 27.1 }
  ],
  "count": 12, "threshold": 80, "min_sessions": 3
}
```

`min_sessions` exists so a subject that has met twice does not generate a defaulter
list where everyone who missed one class is flagged.

One row **per student per subject**: the same student can appear more than once, which
is correct — attendance rules are per subject.

A caller with no subjects in scope gets `{"defaulters": [], "count": 0, "threshold": null}`
rather than an error.

### `GET /api/analytics/defaulters/export`

CSV, `defaulters-<stamp>.csv`. Same filters.

### `GET /api/analytics/methods`

Honours `?subject_id`, `?since`, `?until`.

```json
{ "methods": [ { "method": "face_photo", "count": 8412, "percentage": 71.0 },
               { "method": "qr", "count": 2100, "percentage": 17.7 } ],
  "total": 11840 }
```

Sorted by count descending. Answers "is the class-photo pipeline actually carrying the
load, or is everyone falling back to manual" — which is the question worth asking
after a term of use.

### `GET /api/analytics/enrollment-coverage`

```json
{
  "subjects": [
    { "subject_id": "…", "subject_name": "Data Structures", "subject_code": "CS101",
      "roster_size": 42, "face_enrolled": 31, "voice_enrolled": 28,
      "face_coverage": 73.8 }
  ]
}
```

**Sorted worst coverage first.** A subject at 73 % face coverage cannot have a
successful class-photo session no matter how good the photo is, so this is the list to
act on before blaming the thresholds.

---

## `/api/enroll`

**Student only.** Staff calling any of these gets a **400** explaining that staff
manage enrollment from the student management screen — the endpoints are self-service
by definition and a teacher cannot record someone else's face.

`MAX_SAMPLE_BYTES` is 8 MB per sample, `MAX_SAMPLES` is 5. Samples are accepted as
data URLs or bare base64, and missing `=` padding is tolerated.

Sample counts, which match `frontend/src/lib/constants.js` exactly:

| Modality | Min | Max |
| --- | --- | --- |
| Face | 2 | 5 |
| Voice | 1 | 3 |

### `GET /api/enroll/status`

```json
{
  "student_id": "…", "enrollment_status": "pending_biometrics", "complete": false,
  "passphrase": "attendance is a promise kept",
  "steps": [ { "key": "face", "label": "Face", "done": true, "detail": "4 samples",
               "required_samples": 2, "vector_present": true }, … ],
  "face_sample_range": { "min": 2, "max": 5 },
  "voice_sample_range": { "min": 1, "max": 3 },
  "audio_requirements": {
    "sample_rate": 16000, "format": "16-bit PCM WAV, mono",
    "min_voiced_seconds": 1.5, "max_clip_seconds": 20.0
  }
}
```

`enrollment_status` reaches `complete` only when **both** modalities are enrolled.

### `POST /api/enroll/face`

**`20 per hour`.** Body: `samples` — an array of 2–5 JPEG/PNG data URLs.

**201** →

```json
{ "ok": true, "message": "Face enrolled from 4 samples.", "modality": "face",
  "samples_accepted": 4, "consistency": 0.93,
  "rejections": [{ "index": 2, "reason": "no_face", "message": "No face found in that frame." }],
  "enrollment_status": "pending_biometrics" }
```

`consistency` is how tightly the accepted samples cluster. A low value means the frames
disagree about who is in them — usually two different people, or one person in wildly
different lighting.

**Partial acceptance is normal:** four good frames out of five succeeds, and the
rejected one is reported so the UI can say which thumbnail failed and why.

**422** when *too few* samples survive, with the detail in the envelope:

```json
{ "error": { "code": "unprocessable",
             "message": "Only 1 of 3 samples were usable; at least 2 are needed.",
             "details": { "accepted_samples": 1,
                          "rejections": [{ "index": 0, "reason": "no_face", "message": "…" }] } } }
```

**503** `face_pipeline_unavailable` when dlib/`face_recognition` cannot be imported —
a deployment problem, not a user problem, and worth saying so plainly.

The frames are discarded the moment the 128-d encoding is computed.

### `POST /api/enroll/voice`

**`20 per hour`.** Body: `samples` — 1–3 WAV clips, **16 kHz mono 16-bit PCM**.

**201** → the same shape plus `duration_seconds` and `passphrase`.

**503** is `voice_pipeline_unavailable` here. Same 422 contract for too-few-usable
samples; typical `reason` values are `too_short` (under 1.5 s of voiced audio) and
`unreadable`.

### `POST /api/enroll/reset`

**`10 per hour`.** Body: `face` and/or `voice` booleans.

```json
{ "ok": true, "message": "…", "enrollment_status": "pending_biometrics",
  "face_cleared": true, "voice_cleared": false }
```

A student can re-enroll themselves — after a haircut, or because they enrolled in bad
light. No reason required: it is their own biometric. (A *staff* reset, via
`POST /api/students/<id>/reset-biometrics`, does require one.)

### `GET /api/enroll/passphrase`

```json
{ "passphrase": "attendance is a promise kept",
  "min_voiced_seconds": 1.5, "max_clip_seconds": 20.0, "sample_rate": 16000,
  "already_enrolled": false,
  "note": "Say this phrase naturally, at your normal speaking volume." }
```

Per-institution, not per-student. Speaker verification is 1:1 against the enrolled
voiceprint — the phrase is a script that makes clips comparable, not a secret.

### `GET /api/enroll/subjects`

→ `{ "subjects": [{ "id": "…", "name": "Data Structures", "code": "CS101" }] }`

The student's own rosters, so the wizard can say what their enrollment is *for*.

---

## `/api/admin`

**Admin only** throughout. None of these endpoints is rate-limited.

### `GET /api/admin/institution`

```json
{
  "institution": { "id": "…", "name": "Example Institute", "slug": "example-institute",
                   "settings": { "attendance_threshold": 75,
                                 "low_attendance_alerts_enabled": true,
                                 "alert_cooldown_days": 7 },
                   "created_at": "…" },
  "counts": { "teachers": 18, "students": 412, "admins": 2,
              "subjects": 24, "sessions": 318, "pending_invites": 7 },
  "mail": { "configured": true, "server": "smtp.gmail.com", "port": 587,
            "sender": "no-reply@example.edu", "suppressed": false, "queued": 0 }
}
```

### `PATCH /api/admin/institution`

Body: `name` and/or `settings`. **`settings` is merged, not replaced** — sending one
key leaves the others alone.

**`slug` is immutable by design.** It appears in invite and reset URLs that are already
in people's inboxes; changing it would break them.

Only three settings are writable:

| Key | Type | Validation |
| --- | --- | --- |
| `attendance_threshold` | int | 0–100 |
| `low_attendance_alerts_enabled` | bool | — |
| `alert_cooldown_days` | int | clamped 1–90, default 7 |

Any other key is a **400** naming the offenders in `details.unknown` — a typo'd
setting silently doing nothing is worse than an error.

→ `{ "ok": true, "institution": { "id": "…", "name": "…", "slug": "…", "settings": { … } } }`

### `GET /api/admin/users`

`?role`, `?status`, `?q` (regex-escaped before use), `?limit` default 100 max 500.

An unrecognised `?role` is a **400** with `details.allowed` listing the valid values.

```json
{
  "users": [
    { "id": "…", "email": "ada@example.edu", "name": "Ada Lovelace",
      "role": "student", "status": "active",
      "created_at": "…", "last_login_at": "…",
      "student": { "id": "…", "roll_number": "21CS004",
                   "enrollment_status": "complete",
                   "face_enrolled": true, "voice_enrolled": true } }
  ],
  "count": 100, "limit": 100
}
```

The `student` block is present only on student accounts. `password_hash` is never
returned by anything.

### `POST /api/admin/teachers`

Body: `email`, `name`. **201** → the standard invite response (`invite_url` only when
SMTP is unconfigured).

### `POST /api/admin/users/<id>/resend-invite`

→ the standard invite response, with a freshly minted token.

### `DELETE /api/admin/users/<id>/invite`

→ `{ "ok": true, "message": "Invitation revoked and placeholder removed" }`

Revoking an unaccepted invite deletes the placeholder user along with it, so a
mistyped address does not leave a permanent ghost in the user list.

### `POST /api/admin/users/<id>/disable`

Optional `reason`. → `{ "ok": true, "status": "disabled" }`

Three 409s, all of them locking-yourself-out guards:

- disabling **yourself**;
- disabling the **institution owner**;
- disabling the **last active admin**.

Disabling is reversible and preserves history; there is no user-deletion endpoint,
because deleting a user would orphan their attendance records.

### `POST /api/admin/users/<id>/enable`

→ `{ "ok": true, "status": "active" }` — or `"invited"` if the account has no
`password_hash`. Enabling someone who never accepted their invite returns them to
`invited`, not `active`, because there is still no password to sign in with.

### `POST /api/admin/users/<id>/role`

Body: `role` ∈ `admin` | `teacher`. An unrecognised value is a **400** with
`details.allowed`.

→ `{ "ok": true, "role": "admin" }`, or `{ "ok": true, "role": "admin", "unchanged": true }`
when it was already that role.

**409** for a **student** account (the student ↔ staff boundary is not a role toggle —
a student has a biometric profile and roster memberships that a teacher does not), and
**409** for **demoting yourself** (the same lockout guard as above).

### `GET /api/admin/invites`

`?status` default `pending`; pass `all` for every invite. `?limit` default 100 max 500.

→ `{ "invites": [ … ] }` with `token_hash` stripped from every row. A revoked invite is
kept rather than deleted, so "who invited this person, and when" survives.

### `GET /api/admin/audit`

`?action`, `?target_type`, `?actor_id`, `?limit` default 100 max 500, `?skip` 0–100000.

```json
{
  "entries": [
    { "id": "…", "action": "attendance.manual_override",
      "actor_id": "…", "actor": { "name": "Grace Hopper",
                                  "email": "grace@example.edu", "role": "teacher" },
      "target_id": "…", "target_type": "student",
      "reason": "Was present, arrived late after the photo",
      "previous_state": { "status": "absent", "method_used": null },
      "new_state": { "status": "present", "method_used": "manual" },
      "metadata": { "session_id": "…", "subject_id": "…" },
      "created_at": "2026-08-30T14:12:03Z" }
  ],
  "count": 100, "skip": 0, "limit": 100,
  "actions": ["alert.low_attendance_sent", "attendance.manual_override", … ]
}
```

`actions` is the sorted list of every possible action value, so a filter dropdown does
not need a hardcoded copy of the enum.

System-generated entries (the alert cron, for instance) have no actor id and come back
with `actor: { "name": "System" }`.

Append-only. There is no endpoint that edits or deletes an audit entry.

### `GET /api/admin/privacy`

```json
{
  "face_crops": { "review_items_total": 3, "crops_retained": 3, "unresolved_items": 3,
                  "resolved_but_crop_retained": 0, "crop_ttl_hours": 24,
                  "class_photos_stored": 0, "enrollment_images_stored": 0 },
  "vector_store": { "face_embeddings": 388, "voice_embeddings": 351,
                    "persist_dir": "…/chroma" },
  "guarantees": [ "Class photos are never written to disk.", … ],
  "checked_at": "2026-08-30T14:12:03Z"
}
```

This endpoint exists so the privacy promise is **auditable rather than merely
documented**. `class_photos_stored` and `enrollment_images_stored` are counts of files
on disk, and they are `0` because nothing writes them — a non-zero value would mean
the retention design had been broken.

`vector_store` reports `{"error": "…", "persist_dir": "…"}` instead of counts when
Chroma cannot be opened.

### `POST /api/admin/privacy/sweep`

→ `{ "ok": true, "crops_discarded": 2 }`

A manual run of the retention sweep. Mongo's TTL index already does this about once a
minute, and ending a session deletes its crops immediately; this is for the operator
who wants the guarantee to hold *now* rather than within the minute.

### `POST /api/admin/alerts/run`

Body optional. **`dry_run` defaults to `true`** — the destructive reading is the one
you have to ask for. Optional `threshold` to override the configured one.

```json
{
  "institution": "Example Institute",
  "candidates": 12,
  "sent": [{ "student_id": "…", "email": "alan@example.edu",
             "subject": "Data Structures", "percentage": 52.9, "dry_run": true }],
  "skipped": [{ "student_id": "…", "subject": "Algorithms",
                "reason": "alerted within the last 7 day(s)" }],
  "dry_run": true, "cooldown_days": 7, "min_sessions": 3,
  "checked_at": "2026-08-30T14:12:03Z"
}
```

`skipped` reasons are human-readable strings: `alerted within the last N day(s)`,
`no email on file`, `account is disabled`.

Two early exits, both **200** with a shape that differs from the above — check for the
keys before reading `sent`:

```json
{ "error": "institution_not_found", "sent": [], "skipped": [], "candidates": 0 }
{ "disabled": true, "sent": [], "skipped": [], "candidates": 0, "message": "…" }
```

The second is the ordinary case where `low_attendance_alerts_enabled` is off. Note that
`error` here is a *string field in a 200 body*, not the error envelope.

The same logic runs from `backend/scripts/send_low_attendance_alerts.py` on a cron.

### `GET /api/admin/alerts`

`?limit` default 50 max 200.

```json
{ "alerts": [ { "student_id": "…", "student_name": "Alan Turing",
                "subject_name": "Data Structures",
                "percentage": 52.9, "threshold": 80,
                "sent_at": "2026-08-28T07:00:11Z" } ] }
```

The cooldown log, which is also the answer to "did we already email this student".

---

## `/api/public`

### `GET /api/public/scan?t=<token>`

**No auth required, but a JWT is read if present** (`optional_auth`).
**`60 per minute`.** Accepts `?t=` or `?token=`.

The landing endpoint for a scanned QR code. A phone camera opens
`http://localhost:5173/scan?t=…` with no session, so this has to work
unauthenticated — and then tell the visitor exactly what to do next.

```json
{
  "session_id": "…", "title": "Week 6 — Balanced trees",
  "subject_name": "Data Structures", "subject_code": "CS101",
  "verification_mode": "class_photo_qr", "status": "active",
  "server_time": "2026-08-30T14:12:03Z",
  "authenticated": true,
  "student": { "can_check_in": true, "student_id": "…", "action": "qr" }
}
```

The session summary is **deliberately sparse** — title, subject, mode, status. It is
reachable by anyone who can photograph a projector screen, so it reveals nothing
beyond what is already on that screen. No roster, no counts, no teacher name.

`student` explains the visitor's situation. Either `can_check_in: true` with a
`student_id` and an `action` of `voice` or `qr`, or a `reason`:

| `reason` | What the UI should offer |
| --- | --- |
| `not_signed_in` | a sign-in link that returns here |
| `staff_account` | "you are signed in as staff" — nothing to do |
| `no_student_profile` | an account anomaly; contact the institution |
| `wrong_institution` | this code belongs to another institution |
| `not_enrolled` | not on this subject's roster |
| `already_present` | plus `method_used` and `marked_at` — show the confirmation |

Token errors surface as the normal envelope: **400** `token_invalid` or `qr_rotated`,
**409** `session_ended` or `window_closed`.

Resolving the token here does **not** mark anyone present. This endpoint is read-only;
the actual check-in is `POST /api/attendance/qr`, which needs the student's JWT.

---

## Enumerations

Every value the API will send or accept, from `backend/app/models/constants.py`.

**`Role`** — `admin`, `teacher`, `student`. `STAFF` is `(admin, teacher)`.

**`UserStatus`** — `invited`, `active`, `disabled`.

**`EnrollmentStatus`** — `invited`, `pending_biometrics`, `complete`.

**`VerificationMode`** —

| Value | `mode_label` | Photo | QR | Voice | Self-service |
| --- | --- | --- | --- | --- | --- |
| `class_photo` | Class Photo only | ✓ | | | |
| `qr` | QR only | | ✓ | | ✓ |
| `voice` | Voice only | | | ✓ | ✓ |
| `class_photo_qr` | Class Photo + QR | ✓ | ✓ | | ✓ |

Note there is no combined voice mode. `includes_voice` is true for `voice` alone, and
`POST /api/attendance/voice` against any other mode is a 409 `mode_mismatch`.
"Self-service" is what `GET /api/attendance/me/open-sessions` filters on.

**`SessionStatus`** — `active`, `ended`. (`is_open` additionally checks the clock.)

**`PhotoReviewStatus`** — `none`, `pending_review`, `resolved`.

**`AttendanceMethod`** — `face_photo`, `face_photo_review`, `voice`, `qr`, `manual`.
`face_photo_review` is a match a human confirmed from the review queue, kept distinct
from `face_photo` so "how much did the pipeline get right unaided" stays answerable.

**`AttendanceStatus`** — `present`, `absent`.

**`ReviewReason`** — `low_confidence`, `no_match`, `ambiguous`, `low_resolution`.

**`ReviewResolution`** — `assigned`, `dismissed`, `not_a_student`.

**`InviteType`** — `teacher`, `student`. **`InviteStatus`** — `pending`, `accepted`,
`revoked`.

**`AuditAction`** — the complete list, and also the contents of `actions` in the audit
response:

```
institution.created          user.invited                user.invite_revoked
user.activated               user.disabled               user.enabled
user.password_reset          subject.created             subject.updated
subject.deleted              roster.student_added        roster.student_removed
session.created              session.ended               attendance.marked
attendance.manual_override   class_photo.processed       class_photo.review_resolved
class_photo.crops_discarded  biometric.enrolled          biometric.reset
institution.settings_updated alert.low_attendance_sent
```

### Thresholds and tunables

Defaults from `backend/app/config.py`; every one is an environment variable, documented
with its reasoning in `backend/.env.example`.

| Setting | Default | Meaning |
| --- | --- | --- |
| `FACE_MATCH_THRESHOLD` | 0.12 | at or below this cosine distance, mark automatically |
| `FACE_REVIEW_CEILING` | 0.28 | between the two, send to the review queue |
| `FACE_AMBIGUITY_MARGIN` | 0.04 | two candidates closer than this apart are `ambiguous` |
| `VOICE_MATCH_THRESHOLD` | 0.25 | speaker-verification acceptance distance |
| `MIN_FACE_PIXELS` | 48 | smaller detections are rejected, not guessed at |
| `FACE_CROP_TTL_HOURS` | 24 | review-crop retention ceiling |
| `QR_TOKEN_TTL_SECONDS` | 30 | QR rotation period |
| `DEFAULT_ATTENDANCE_THRESHOLD` | 75 | institution default, overridable per subject |
| `MAX_UPLOAD_MB` | 16 | request-level cap (413 before route code runs) |

---

## Appendix: known defects in 1.0.0

Found while writing this document, against the source as it stands. Neither is fixed
here — `backend/` is treated as complete and read-only in this checkout.

**1. `POST /api/attendance/override` returns 500.** `backend/app/routes/attendance.py:320`
does `return jsonify(result)` on the `MarkResult` dataclass. Flask 3 serializes
dataclasses, but `MarkResult.record` is the **raw Mongo document** returned by
`find_one`/`insert_one`, whose `ObjectId` fields (`_id`, `session_id`, `student_id`,
`subject_id`, `institution_id`, `marked_by`) have no JSON representation — so
serialization raises `TypeError` and the error handler answers 500.

The write and the audit entry commit *before* the response is built, so the override
does take effect; only the reply fails. `POST /api/attendance/override/bulk` builds its
response by hand and is fine, as are the QR and voice paths, which go through
`_mark_result_response` — that helper omits `record` entirely.

The one-line fix, in `override()`:

```python
return jsonify(
    {
        "ok": True,
        "created": result.created,
        "status": result.status,
        "message": result.message,
        "record": serialize_doc(result.record),
    }
)
```

Until then, a client should treat a 500 from this endpoint as "probably applied" and
re-read `GET /api/sessions/<id>/live` for the authoritative roster rather than
retrying — a retry is harmless (the operation is idempotent for a given target state)
but will fail identically.

**2. Both suites now run, but no route has been exercised against a live database.**
`python -m pytest` reports 291 passed and `npm run build` succeeds, so the app factory,
the guards, the validators, the error envelope and the frontend bundle are all verified.
What that does *not* cover is any route body that performs a database write — the
hermetic suite deliberately forbids a Mongo connection. So every request and response
shape in this document was read from the source rather than observed from a live
response, and the first run against a real Atlas instance is still the first real
execution of the write paths.
