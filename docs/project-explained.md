# SnapAttend, explained

This document explains what SnapAttend is, how it is built, and **how it actually
works** — the decisions inside each pipeline, not just the endpoints they sit
behind. It is meant to be read start to finish by someone who has never seen the
code, and it assumes nothing beyond "I know what a web app is."

The other three documents cover different ground: [README.md](../README.md) is
setup and operations, [api-reference.md](api-reference.md) is every endpoint's
parameters and response shape, and
[frontend-architecture.md](frontend-architecture.md) is the design tokens,
component props and API semantics the UI has to honour. This one is the *why*.

Every claim below was checked against the source at the time of writing;
where a specific line matters it is cited as `path:line`.

---

## Contents

1. [What SnapAttend is](#1-what-snapattend-is)
2. [Why three modalities](#2-why-three-modalities)
3. [The shape of the system](#3-the-shape-of-the-system)
4. [Multi-tenancy: the rule underneath everything](#4-multi-tenancy-the-rule-underneath-everything)
5. [The data model](#5-the-data-model)
6. [Accounts, and how a request gets authorised](#6-accounts-and-how-a-request-gets-authorised)
7. [Signed tokens](#7-signed-tokens)
8. [Verification modes](#8-verification-modes)
9. [Biometric enrollment](#9-biometric-enrollment)
10. [The vector store](#10-the-vector-store)
11. [The class-photo pipeline, end to end](#11-the-class-photo-pipeline-end-to-end)
12. [The review queue](#12-the-review-queue)
13. [Rotating-QR check-in](#13-rotating-qr-check-in)
14. [Voice check-in](#14-voice-check-in)
15. [Marking: the one decision point](#15-marking-the-one-decision-point)
16. [Analytics, and the denominator problem](#16-analytics-and-the-denominator-problem)
17. [Low-attendance alerts](#17-low-attendance-alerts)
18. [The audit log](#18-the-audit-log)
19. [Privacy posture](#19-privacy-posture)
20. [Errors](#20-errors)
21. [The frontend](#21-the-frontend)
22. [Running it](#22-running-it)
23. [Verification status and known issues](#23-verification-status-and-known-issues)

---

## 1. What SnapAttend is

SnapAttend is a multi-tenant attendance system for schools, colleges and training
institutes. One deployment serves many institutions; each one signs up, invites
its own staff and students, and can never see another's data.

The thing it replaces is a register being passed around a lecture hall, or a
teacher reading out thirty names. Both cost several minutes of every class, and
both are trivially defeated by a friend answering for you.

SnapAttend's answer is to make the *evidence* of attendance something a student
cannot hand to someone else:

- a **photograph of the room**, matched face-by-face against the enrolled roster;
- a **QR code on the projector that changes every 30 seconds**, so a screenshot
  sent to someone at home is stale before they can open it;
- a **spoken passphrase**, matched against a voiceprint the student enrolled
  earlier.

A teacher picks which of these a given class uses. Whatever the mechanism, the
teacher always has the final word: a manual override beats every algorithm in the
system, and it requires a typed reason that goes into the audit log.

The other half of the product is what you do with the data once you have it —
per-subject percentages that account for students who joined late, a configurable
attendance threshold, a defaulter list, CSV exports, and an email that warns a
student they are falling below the line while there is still time to fix it.

### Scale of the thing

| | |
|---|---|
| Backend | 11,144 lines of Python across 39 modules in `backend/app/` |
| API surface | 82 blueprint routes across 9 blueprints, plus `GET /` and `GET /healthz` |
| Frontend | 19,323 lines across 82 files — 26 pages, 40 components, 6 hooks, 2 contexts |
| Tests | 291, all passing, hermetic (no database, no network, no native libraries) |
| Version | 1.0.0 |

---

## 2. Why three modalities

None of the three mechanisms is good enough alone. They are in the product
because each one covers the others' failure modes.

**Class photo** costs the students nothing — they sit still and the teacher takes
one wide shot. It marks thirty people in a single action, which is the only
option that genuinely takes zero class time. But it fails on the back row, on
someone whose face is behind a laptop lid, and on anyone who has not enrolled a
face yet. Its recall is good but never perfect, so it *must* have a fallback for
the people it misses.

**Rotating QR** is that fallback. It needs each student to hold a phone, but it
is close to unspoofable within its 30-second window and it does not care where
the student is sitting. It cannot stand alone as the primary mechanism in a room
where phones are discouraged, and it inherently proves only that *a device*
scanned the code — which is why the code has to rotate rather than be static.

**Voice** is the strongest binding of identity to a body: you cannot forward a
voiceprint the way you forward a screenshot. It is also the slowest, because it
is inherently one student at a time, and the noisiest to operate — a crowded room
degrades it. It is the right choice for a viva, a lab, or a small tutorial group;
it would be miserable for a 200-seat lecture.

So the product exposes four *modes*, and a teacher chooses per session:

| Mode | Teacher does | Student does | Good for |
|---|---|---|---|
| `class_photo` | uploads one photo | nothing | large lectures |
| `qr` | projects a rotating code | scans it | any size, phones allowed |
| `voice` | opens the session | records a passphrase | tutorials, labs, vivas |
| `class_photo_qr` | uploads a photo **and** projects a code | scans if missed | the default in practice |

That last row is the one the system is really built around: the photo does the
bulk of the work, and the QR mops up whoever it missed. The
[verification-mode section](#8-verification-modes) explains how a single truth
table drives every "should this student see a check-in button" decision in the
app.

---

## 3. The shape of the system

```
   Browser — React 18 + Vite, :5173
        │
        │  JSON over HTTP; JWT in an Authorization header
        │  (in dev, Vite proxies /api and /healthz to :5000, so it is same-origin
        │   and there is no CORS preflight and no cookie to configure)
        ▼
   Flask API — :5000
   app factory · 9 blueprints · one error envelope · guards on every route
        │
        ├──▶ MongoDB Atlas ····· the source of truth. 11 collections. Every
        │                        tenant-scoped index leads with institution_id.
        │
        ├──▶ ChromaDB (embedded, on-disk) ····· the ONLY place biometric vectors
        │                        live. Two cosine collections, one vector per
        │                        student per modality.
        │
        ├──▶ dlib / face_recognition ····· HOG detection + 128-d encodings
        ├──▶ Resemblyzer (torch) ····· 256-d voice embeddings
        └──▶ SMTP via Flask-Mail ····· invites, password resets, alert emails
```

### Three storage layers, deliberately separated

The split between Mongo and Chroma is the most important structural decision in
the project, and it is not about performance.

**Mongo holds facts about people and classes.** Names, roll numbers, rosters,
sessions, attendance rows, audit entries. It also holds *flags* like
`face_enrolled: true`.

**Chroma holds only vectors.** 128 floats per enrolled face, 256 per enrolled
voice, keyed by the stringified Mongo `_id`. Nothing else in the codebase imports
`chromadb` — `app/vector_store.py` is the single door, and that is stated in its
own module docstring.

**Nothing holds pixels.** No class photo, no enrollment selfie and no voice clip
is ever written to disk or to a database. The one exception is a small cropped
JPEG of a face the system could not confidently identify, which lives on the
review-queue row until a teacher makes a decision, and is deleted the instant
they do. [Section 19](#19-privacy-posture) is the full inventory.

The reason to keep vectors out of Mongo is that it makes the privacy story
*auditable*. "Which code paths can read a biometric vector" has a one-file
answer, and "does this student still have a voiceprint on file" is a single
lookup rather than a schema audit.

### The lifecycle of one request

Worth walking once, because every route follows it.

1. **`create_app()`** (`backend/app/__init__.py`) builds the Flask app from
   `Config`, registers the 9 blueprints, installs the error handlers, and — only
   if `MONGODB_URI` is set and `SKIP_INDEXES` is falsy — calls
   `db.ensure_indexes()` (`app/__init__.py:122`). That gate is what makes the test
   suite able to boot the real application with no database at all.
2. **A guard decorator runs first.** `@any_authenticated`, `@role_required(...)`
   or `@optional_auth` from `app/auth/guards.py`. It reads the JWT, then loads the
   user *document* from Mongo and re-checks role and status on every single
   request. Claims in the token are not trusted for authorisation.
3. **The view scopes its query.** Every Mongo query goes through
   `scope({...})`, which injects `institution_id` from `g`. There is no way to
   write a tenant-scoped query in this codebase that forgets the tenant, because
   the tenant is not a parameter the caller supplies.
4. **Input is validated** by `app/utils/validators.py`, which raises `ApiError`
   with a 400 and a `details` dict naming the offending field.
5. **Work happens in a service**, not in the route. Routes are thin: parse,
   authorise, delegate, serialise. The interesting logic lives in
   `app/services/` and `app/pipelines/`.
6. **The response is serialised** by `app/utils/serialization.py`, which converts
   `ObjectId` to string, renders datetimes as ISO-8601 UTC, and strips
   `password_hash` and `crop_jpeg_b64` from anything that passes through it.
7. **Any `ApiError` becomes the one envelope.** Success shapes vary; failures
   never do:

```json
{ "error": { "code": "not_found", "message": "Subject not found", "details": {} } }
```

Every non-2xx response the API can produce has this shape — including the ones
Flask itself raises, such as a 413 from `MAX_CONTENT_LENGTH` or a 429 from
Flask-Limiter, which are re-wrapped by handlers registered in the factory. The
frontend's `lib/api.js` therefore has exactly one place that understands failure,
and 22 named `ErrorCode` values it can branch on.

---

## 4. Multi-tenancy: the rule underneath everything

One deployment, many institutions. Every collection except `institutions` itself
carries an `institution_id`, and three helpers in `app/auth/guards.py` enforce it.

**`scope(query)`** merges the caller's `institution_id` into any filter:

```python
scope({"status": "active"})
# -> {"status": "active", "institution_id": ObjectId("...")}
```

**`assert_same_institution(doc, what=...)`** is for documents fetched by `_id`,
where you cannot scope the lookup. And here is the decision that matters:

> A document belonging to another institution raises **404, not 403**.

A 403 would confirm that a subject with that id exists somewhere on the server. A
404 is indistinguishable from the id simply not existing. The three cases —
someone else's document, a document with no `institution_id` at all, and `None` —
all produce the identical response, down to the message:

```json
{ "error": { "code": "not_found", "message": "Subject not found", "details": {} } }
```

This is asserted in `backend/tests/test_auth_guards.py` by a parametrised test
over all three cases, precisely because it is the kind of rule that decays the
moment someone "improves" the error message.

**`assert_can_manage_subject` / `assert_can_manage_session`** add the intra-tenant
layer. An admin can manage anything inside their own institution. A teacher can
manage a subject they are listed on (`teacher_ids` is a list, so a colleague can
cover a class) and a session they own — or, falling through, a session on a
subject they co-teach. An unrelated teacher gets a 403 here, not a 404: the
subject's existence is not a secret from a colleague in the same institution, only
the *authority over it* is being refused.

### Why the guard re-reads the user document

`current_user()` hits Mongo on every request rather than trusting the JWT claims.
That is a deliberate cost, and it buys two things:

- **Disabling an account takes effect immediately.** A disabled user is holding a
  perfectly valid, unexpired token; if authorisation came from the claims, they
  would keep working until it lapsed — up to 30 minutes for an access token, and
  14 days if they refreshed.
- **A role change takes effect on the next request**, not on the next login.

Both behaviours have tests. The disabled-account case returns a 401 whose message
says the session is "no longer valid", so the frontend clears its stored token and
routes to the login page rather than looping on a 403.

---

## 5. The data model

Mongo accepts whatever you hand it, which is exactly why every insert in SnapAttend
goes through a factory function in `backend/app/models/schemas.py`. Two things
follow: a new field gets a default on *every* document from day one, and reading
that one file tells you the entire data model without grepping for `insert_one`.

Eleven collections, accessed through eleven named functions in `app/db.py` — there
are no string collection names sprinkled through the routes.

### `institutions`
The tenant root. Holds a `slug` (unique) and a `settings` sub-document:
`attendance_threshold` (75.0), `low_attendance_alerts_enabled` (true) and
`alert_cooldown_days` (7). `owner_user_id` points at the admin who registered.

### `users`
Everyone who can log in — `role` is `admin`, `teacher` or `student`. `email` is
lowercased and unique **globally**, not per tenant, so a person cannot hold two
accounts on one server with the same address. `password_hash` is `None` until an
invite is accepted, which is what makes an invited-but-not-yet-active account
representable without a second table. `status` is `invited`, `active` or
`disabled`.

### `students`
The student *profile*, separate from the login. Holds `roll_number`,
`enrollment_status`, and the biometric bookkeeping: `face_enrolled`,
`voice_enrolled`, `face_sample_count`, `voice_sample_count`, and the two
`*_enrolled_at` timestamps.

It deliberately holds **no vectors**. The embeddings live in Chroma keyed by this
document's stringified `_id`, so the Chroma key is *derivable* rather than stored
— one less field that can drift out of sync.

### `subjects`
`code` is unique per institution. `teacher_ids` is a list, so two teachers can
share a subject and either can cover the other's class.
`attendance_threshold: None` means "inherit the institution setting at read time",
which is why changing the institution default retroactively affects every subject
that never overrode it. `archived` is a boolean, and subjects are archived rather
than deleted — deleting one would orphan its sessions and silently rewrite
historical percentages.

### `enrollments`
Roster membership: one row per `(subject_id, student_id)`, unique. This is a
separate collection rather than an array on `subjects` because the class-photo
pipeline queries it constantly ("who could this face be?"), and an unbounded array
on a hot document is a growth problem waiting to happen. Its `created_at` is
load-bearing — it is the date from which a student's attendance denominator starts
counting (see [section 16](#16-analytics-and-the-denominator-problem)).

### `sessions`
One class meeting. Carries `subject_id`, `teacher_id`, `verification_mode`,
`start_time`, `end_time`, `status` (`active` or `ended`), plus two clusters of
mechanism state:

*Rotating QR:* `qr_current_token`, `qr_current_nonce`, `qr_previous_nonce`,
`qr_token_expiry`. The previous nonce is retained for exactly one rotation so a
scan landing on the boundary still succeeds instead of failing "for no
user-visible reason".

*Class photo:* `photo_review_status` (`none` / `pending` / `complete`),
`photo_processed_at`, and `photo_stats` — a small
`{faces_detected, auto_matched, needs_review}` summary so the sessions list can
show what a photo achieved without re-reading the review queue.

### `attendance_records`
One row per `(session_id, student_id)`, enforced by the unique index
`uq_session_student`. That index *is* the idempotency guarantee: a student who
scans the QR twice, or who is both matched in the photo and scans anyway, cannot
produce two rows.

Fields worth knowing: `method_used` (one of five), `status`, `confidence_score`
(`None` for manual decisions — confidence is meaningless for a human judgement),
`was_manual_override`, `marked_by` (the teacher, for manual and review actions;
`None` for automated ones), and `face_box`.

`face_box` stores *coordinates only, never pixels* — which detected face in the
photo produced this match. A teacher auditing a session can therefore confirm the
match was positional and not a duplicate of another student's face.

### `pending_face_matches`
The review queue: a face the pipeline detected but would not commit to. Holds
`crop_jpeg_b64` (the only persisted face image anywhere in the system),
`crop_discarded`, `face_box`, `best_guess_student_id`, `confidence_score`,
`distance`, a machine-readable `reason`, and the resolution fields `resolved`,
`resolution`, `assigned_student_id`, `resolved_by`, `resolved_at`.

`expires_at` is backed by a TTL index, so an abandoned queue scrubs itself even if
no one ever clicks anything.

### `audit_logs`
`{institution_id, actor_id, action, target_id, target_type, reason,
previous_state, new_state, metadata, timestamp}`. `actor_id` is `None` for system
and cron actions, which is how an alert email sent by the nightly script is
distinguishable from one an admin triggered by hand.

### `invites`
An outstanding email invitation. Stores only the token's SHA-256 in `token_hash`
(unique), so the row is useful for tracking and revocation but useless for forging
a working link. `sent_count` increments on re-send. `user_id` points at the
pre-created `users` row this invite will activate.

There is deliberately **no `expired` status.** Nothing sweeps the collection, so a
lapsed invitation stays `pending` with `expires_at` in the past. Adding `expired`
to the enum would create an admin filter that can only ever return an empty list;
the frontend derives that state client-side instead. A test asserts the absence.

### `alert_log`
One row per low-attendance email actually sent: `student_id`, `subject_id`,
`percentage`, `threshold`, `sent_at`. Its only job is to enforce the cooldown that
stops a nightly cron from emailing the same student every night forever.

### The indexes

`db.ensure_indexes()` is idempotent and runs at startup. It creates 20 indexes,
and three of them are load-bearing enough that the system's behaviour would change
without them.

| Collection | Index | Keys | Notes |
|---|---|---|---|
| `institutions` | `uq_slug` | `slug` | unique |
| `users` | `uq_email` | `email` | unique, global |
| `users` | `ix_inst_role` | `institution_id, role` | |
| `students` | `uq_user` | `user_id` | unique — one profile per login |
| `students` | `ix_inst_status` | `institution_id, enrollment_status` | |
| `subjects` | `uq_inst_code` | `institution_id, code` | unique per tenant |
| `subjects` | `ix_teachers` | `teacher_ids` | multikey — "my subjects" |
| `enrollments` | `uq_subject_student` | `subject_id, student_id` | unique |
| `enrollments` | `ix_student` | `student_id` | "my subjects", student side |
| `sessions` | `ix_inst_status_start` | `institution_id, status, start_time` | |
| `sessions` | `ix_subject_start` | `subject_id, start_time↓` | newest first |
| `attendance_records` | **`uq_session_student`** | `session_id, student_id` | **unique — the idempotency guarantee** |
| `attendance_records` | `ix_inst_student_ts` | `institution_id, student_id, timestamp↓` | |
| `attendance_records` | `ix_subject` | `subject_id` | |
| `pending_face_matches` | `ix_session_resolved` | `session_id, resolved` | the queue query |
| `pending_face_matches` | **`ttl_expires`** | `expires_at`, `expireAfterSeconds=0` | **the privacy backstop** |
| `audit_logs` | `ix_inst_ts` | `institution_id, timestamp↓` | |
| `invites` | `uq_token_hash` | `token_hash` | unique |
| `invites` | `ix_email_status` | `email, status` | |
| `alert_log` | `ix_student_subject_sent` | `student_id, subject_id, sent_at↓` | the cooldown lookup |

Two patterns to notice:

**Every compound tenant index leads with `institution_id`,** because *every*
tenant-scoped query filters on it — `scope()` guarantees that. Leading with
anything else would leave the most selective predicate unindexed.

**Index creation cannot take the app down.** The whole function is wrapped in
`except PyMongoError`, logging a warning and continuing. A replica-set hiccup at
boot should degrade query performance, not refuse to serve traffic.

The third load-bearing index is `uq_session_student`. Attendance marking does not
check-then-write; it *writes and catches `DuplicateKeyError`*, which is the only
way to be correct when two requests race — a student tapping the check-in button
twice, or the class photo landing at the same instant as their scan.

---

## 6. Accounts, and how a request gets authorised

### Getting in

There is exactly one self-service signup: **`POST /api/auth/register-institution`**
creates an institution and its first admin in one call. Everyone else arrives by
invitation, which means there is no route by which a stranger can create an account
inside someone else's institution.

An admin invites staff and students; a teacher can invite students. An invite
pre-creates the `users` row with `status: invited` and `password_hash: None`, then
emails a signed link. Accepting it sets the password and flips the status to
`active`. The pre-created row is what lets an admin see and manage a pending
person in the users list — they exist, they just cannot log in yet.

For classes of thirty, **bulk import** takes a CSV of names and emails and issues
one invite per row, reporting per-row failures rather than aborting the batch.

### Passwords

bcrypt via `app/auth/passwords.py`. `password_hash` is stripped from every
serialised document by `utils/serialization.py`, so it cannot leak through a route
that forgot to project it away.

### JWTs

Flask-JWT-Extended, **headers only** — `JWT_TOKEN_LOCATION = ["headers"]`. No
cookies, so there is no CSRF surface and no `SameSite` behaviour to reason about.
Access tokens last 30 minutes, refresh tokens 14 days.

The frontend keeps them in `localStorage` and `lib/api.js` attaches the access
token to every request. On a 401 it attempts one refresh and replays the original
request; if the refresh also fails it clears storage and routes to `/login`.
Concurrent 401s share a single in-flight refresh rather than each firing their own.

### Roles

Three, and they nest only partially:

- **`student`** — their own dashboard, their own attendance, enrollment, check-in.
- **`teacher`** — their subjects, their sessions, the roster, reports. May invite
  students.
- **`admin`** — everything in their institution: users, roles, settings, audit
  log, privacy report, alert runs.

`Role.STAFF` is `{admin, teacher}` and is what `require_staff` is built on. A test
asserts that `student` is not in it, because a student slipping through would be
able to create sessions for a subject they merely attend.

### The guards, in one table

| Decorator | Admits | Used for |
|---|---|---|
| `@optional_auth` | anyone, signed in or not | the public QR landing endpoint |
| `@any_authenticated` | any active user | anything where the *role* branch is inside the view |
| `@role_required(...)` | only the named roles | admin routes, staff routes |

All three populate `g.actor_id`, `g.institution_id` and `g.actor_role` before the
view body runs, so the audit log never has to re-derive who did something.

---

## 7. Signed tokens

Three things in SnapAttend arrive as a token in a URL: an invitation, a password
reset, and a QR code. All three are `itsdangerous` signatures over a JSON payload,
built in `app/utils/tokens.py`, and none of them requires a lookup to *verify* —
only to check state.

### Salts stop cross-use

```python
SALT_INVITE = "snapattend.invite.v1"
SALT_RESET  = "snapattend.password-reset.v1"
SALT_QR     = "snapattend.qr-session.v1"
```

The salt is the whole reason a password-reset token cannot be replayed as a teacher
invitation, even though both are signed with the same `SECRET_KEY`. Two tests
assert exactly that: feeding a QR token to `read_invite_token`, and a reset token
to `read_qr_token`, both fail as `token_invalid` rather than succeeding.

Expiry and tampering map to distinct codes so the UI can respond usefully:
`SignatureExpired` → 400 `token_expired` ("request a fresh link"), `BadSignature` →
400 `token_invalid` ("this link is not valid"). A payload that verifies but is not
a dict is also `token_invalid` rather than an unhandled `TypeError` downstream.

### Only fingerprints are stored

`token_fingerprint()` is a SHA-256 hex digest, and the `invites` collection stores
that instead of the token. A database leak therefore yields nothing replayable into
a live invite link. Each invite payload also carries `"n": secrets.token_urlsafe(8)`,
so re-inviting the same person twice produces two different tokens and two
different fingerprints — which is what stops the unique index on `token_hash` from
rejecting a legitimate re-send.

### Reset tokens are single-use for free

`make_reset_token` embeds the first 16 hex characters of
`sha256(password_hash)`. When the password changes, so does its hash, so the
embedded fingerprint no longer matches and the outstanding link stops working.

No `used_tokens` table, no cleanup job, no race between two tabs. The invariant is
enforced by arithmetic rather than by bookkeeping. Two tests cover it: the token
matches its own hash, and stops matching after a change.

### QR tokens outlive their nonce on purpose

`read_qr_token` defaults to `max_age = QR_TOKEN_TTL_SECONDS * 2` — sixty seconds
for a code that rotates every thirty.

That asymmetry is deliberate. A scan landing right on a rotation boundary should
fail the *nonce* check, which produces the actionable `qr_rotated` message "This QR
code has refreshed. Scan the code currently on screen." If the signature expired at
the same moment as the nonce, the student would instead get an opaque
expired-signature error for what is a completely routine timing coincidence.

---

## 8. Verification modes

A session's `verification_mode` is one of four values, and four helper functions on
`VerificationMode` derive everything else from it:

| Mode | `includes_photo` | `includes_qr` | `includes_voice` | `student_self_service` |
|---|---|---|---|---|
| `class_photo` | ✅ | ❌ | ❌ | **❌** |
| `qr` | ❌ | ✅ | ❌ | ✅ |
| `voice` | ❌ | ❌ | ✅ | ✅ |
| `class_photo_qr` | ✅ | ✅ | ❌ | ✅ |

That table is the entire mode system. Every "should this student see a check-in
button", "may this method mark this session" and "is there anything for the teacher
to upload" decision in both the backend and the frontend reduces to a lookup in it.
`backend/tests/test_constants.py` writes it out as a parametrised test, and
`modeIncludes*` in `frontend/src/lib/constants.js` reimplements it for the UI.

### The asymmetry in the first row

`class_photo` is the only mode where `student_self_service` is **false**. It is a
teacher-driven bulk action: there is genuinely nothing for a student to do, so the
student's check-in page must say so rather than offering a button that cannot work.
`class_photo_qr` exists precisely to add the student-facing fallback back in.

### Unknown modes answer "no"

All four helpers return `False` for `""`, `None`, and any unrecognised string. They
are called with whatever a session document happens to hold — including one written
by an older version of the app — so the safe answer to "does this mode allow voice
check-in" for an unknown mode is no, not a `KeyError` in the middle of a student's
check-in attempt. Tested for `""`, `None`, `"face"` and `"class_photo_voice"`.

### Five methods, and why `manual` can never be folded in

`AttendanceMethod` has five values: `face_photo`, `face_photo_review`, `qr`,
`voice`, `manual`.

`face_photo` and `face_photo_review` are distinct on purpose. The first is a
confident automated match; the second is a human confirming a face the pipeline
queued for review. Collapsing them would make it impossible for analytics to
report how often the pipeline was confident enough to act alone — which is the
single most useful number for tuning the thresholds.

`manual` is likewise never folded into the method it replaced, because a report has
to be able to say "this row was a teacher override". A test asserts `manual` is
distinct from all four automated methods.

---

## 9. Biometric enrollment

Before a student can be recognised, they enroll — 2 to 5 face photos and 1 to 3
voice clips, from `/enroll` in the browser.

### The write order is load-bearing

`app/services/enrollment.py` does three things per modality, and the order is not
arbitrary:

1. compute the embedding;
2. upsert the vector into Chroma;
3. **then** set `face_enrolled` / `voice_enrolled` on the student document.

> The flag is the *claim*; the vector is the *fact*. So the fact is written first.

Reversed, a Chroma failure would leave a student flagged as enrolled with no vector
behind the flag. Nothing would error — they would simply be marked absent from
every class photo forever, with a UI cheerfully telling them enrollment is
complete. That is the worst class of bug this system could have, so the ordering is
fixed and the reasoning is in the source.

`enrollment_progress` guards the other direction: it reads back from Chroma and
exposes a `drift` boolean per modality, so a flag without a vector surfaces as
"re-enroll this student" rather than as mysteriously failed recognition.

### Face enrollment: what gets rejected, and why

`app/pipelines/face.py::enroll_face_samples` checks each sample independently and
returns an index-tagged rejection reason for every one it refuses:

| Reason | Trigger | Why it is fatal for that sample |
|---|---|---|
| `decode_failed` | not a readable image | — |
| `too_dark` | mean brightness < 25 | the encoding would be dominated by noise |
| `no_face` | detector found nothing | — |
| `multiple_faces` | detector found 2+ | **see below** |
| `face_too_small` | box below `min_face_pixels` (48) | too few pixels for a stable encoding |
| `too_blurry` | Laplacian variance below the floor | a blurred face encodes to a soft average |
| `encode_failed` | dlib could not encode | — |

`multiple_faces` is a *hard* rejection rather than a "use the biggest face"
fallback. Averaging two people's faces would create an embedding that matches
neither of them — a vector that fails silently at match time instead of loudly at
enrollment time.

At least **2** samples must survive. The pipeline then measures pairwise
`consistency` between the accepted encodings and requires it to be **≤ 0.20**: if
two photos of the same person disagree that much, one of them is probably not that
person, and enrolling the average would be worse than enrolling nothing.

Finally the accepted encodings are averaged **in raw space and normalised once** at
the end, rather than normalised individually and then averaged. Normalising first
would weight a low-confidence sample exactly as heavily as a good one.

Enrollment encodes with `num_jitters=3` — three slightly perturbed passes averaged
— because enrollment happens once and can afford to be slow. Class-photo matching
uses `num_jitters=1`, because it happens across thirty faces while a teacher waits.

### Voice enrollment, and the audio-format decision

Browsers' `MediaRecorder` produces WebM/Opus. Decoding that server-side would mean
shipping ffmpeg, which is a large, platform-specific dependency to add for one
format conversion.

So the conversion happens in the browser instead. `frontend/src/lib/audio.js`
decodes the recording with the Web Audio API and re-encodes it as **16 kHz mono
16-bit PCM WAV** before upload. The backend then needs only `soundfile`, which is
pure-wheel on every platform. A verified consequence: posting WebM to the enrollment
endpoint returns a clear rejection naming the supported formats, rather than a 500
from a missing decoder.

`app/pipelines/voice.py` then applies five checks:

| Check | Constant | Behaviour |
|---|---|---|
| Decodable audio | — | rejects with a message naming WAV/FLAC/OGG |
| Not silent | `SILENCE_PEAK_FLOOR = 0.01` | "Check that your microphone is unmuted" |
| Not too long | `MAX_CLIP_SECONDS = 20.0` | **truncated, not rejected** |
| Enough speech | `MIN_VOICED_SECONDS = 1.5` | after VAD trimming |
| Consistency | `ENROLLMENT_CONSISTENCY_MAX = 0.35` | across multiple clips |

Two details there are deliberate. A clip over 20 seconds is **truncated rather than
refused**, because the passphrase is at the start anyway and rejecting a student for
leaving the mic running is pointless friction. And multi-channel input is averaged
across channels rather than taking channel 0, because some laptops record a
near-silent second channel that would halve the perceived level and trip the
silence floor.

The 1.5-second minimum is measured *after* voice-activity detection trims the
silence, so it means 1.5 seconds of actual speech. Verified behaviour on non-speech
input: a 3-second synthetic tone is rejected with "Only 0.0s of speech was detected;
at least 1.5s is needed. Please read the whole phrase clearly." That is the VAD
working, not failing — there is no voiced speech in a sine wave.

The default passphrase is
*"My voice is my attendance signature for this class."*

Resemblyzer's `VoiceEncoder` is loaded once behind a lock and reused — it is a torch
model, and loading it per request would add seconds to every check-in. It runs on
CPU (`device="cpu"`) because attendance is not a throughput problem and a GPU
requirement would make deployment much harder.

### Resetting biometrics deletes, not unflags

`reset_biometrics` removes the vector from Chroma as well as clearing the flags.
Leaving an orphaned vector behind would keep matching a face the student has asked
us to forget — which is both the wrong behaviour and, in most jurisdictions, the
wrong answer to a data-deletion request.

---

## 10. The vector store

`app/vector_store.py` is the only module in the project that imports `chromadb`,
and its docstring says so explicitly. Two collections, both cosine:

- `face_embeddings` — 128 floats per student
- `voice_embeddings` — 256 floats per student

One vector per student per modality, with the document id being the stringified
Mongo `_id`. That makes re-enrollment a plain `upsert` rather than a
delete-then-insert, so there is no window in which a student has no vector.

### Normalisation makes the thresholds transferable

Every vector is L2-normalised before storage **and** before querying. On unit
vectors, `euclidean² = 2 × cosine_distance` exactly.

That identity is the reason the thresholds in this project can be justified rather
than guessed. dlib documents a Euclidean tolerance of 0.6 for `face_recognition`
encodings; on unit vectors that is a cosine distance of 0.18. The project's
`FACE_MATCH_THRESHOLD` of **0.12** is therefore deliberately *stricter* than dlib's
own recommendation — appropriate when a false positive writes an incorrect
attendance record with someone's name on it.

### The empty-roster filter

`_build_where` composes Chroma's metadata filter, and its empty-roster branch is
worth reading twice:

```python
{"student_id": {"$in": ["__none__"]}}
```

An empty roster does not mean "no filter". If it produced an unfiltered query, a
subject with no enrolled students would search *the entire institution* and happily
match a face against someone who is not in the class. So the empty case builds a
filter that provably matches nothing.

Verified against the real Chroma: a query with an empty roster list returns 0 hits,
and a query with the correct roster but a different `institution_id` also returns 0.

### `confidence` is for display only

```python
@property
def confidence(self) -> float:
    """Distance mapped to a 0..1 score for display purposes only.

    This is *not* a calibrated probability — it exists so the UI can show
    "94%" instead of "0.06 cosine distance". Accept/reject decisions are
    always made on ``distance`` against an explicit threshold.
    """
    return round(max(0.0, min(1.0, 1.0 - self.distance)), 4)
```

Every accept/reject in the codebase compares `distance` to a configured threshold.
`confidence` never participates in a decision. It exists because "94%" is a phrase a
teacher can act on and "0.06 cosine distance" is not.

### One small operational detail

`_get_collection` passes `embedding_function=None` deliberately. Chroma's default
would lazily download its bundled ~80 MB ONNX model on first use — pointless here,
since SnapAttend always supplies its own vectors, and a surprising first-request stall
in production.

---

## 11. The class-photo pipeline, end to end

This is the centre of the product. A teacher uploads one photo of the room and
gets back an attendance list plus a short queue of faces the system would not
commit to.

The governing rule, from the top of `app/pipelines/face.py`:

> The system never guesses on a student's attendance record; it escalates.

### The four conditions for an automatic mark

A detected face is auto-marked present only if **all four** hold:

1. the detected box is at least `min_face_pixels` (48) on its shorter side;
2. the nearest roster neighbour is within `match_threshold` (0.12);
3. the runner-up is at least `ambiguity_margin` (0.04) further away than the best;
4. that student has not already been claimed by a *closer* face in the same photo.

Anything else goes to the review queue with a machine-readable reason. There is no
fifth path — a face is either marked or queued.

### Step by step

**1. Decode and downscale.** `app/pipelines/imaging.py` decodes with Pillow and
downscales the longest side to `CLASS_PHOTO_MAX_DIM` (2400 px), recording the scale
factor so face boxes can be reported in original-image coordinates. A 48-megapixel
phone photo is not more accurate than a 2400-px one for this task; it is just slower
and more memory.

**2. Detect faces.** dlib's HOG detector, `upsample=1`. HOG rather than CNN because
CNN detection on a wide classroom shot takes tens of seconds on CPU and the project
targets commodity hardware. `upsample=1` is the compromise that finds most back-row
faces without doubling the cost again.

**3. Suppress overlapping boxes.** `_suppress_overlaps` at `NMS_IOU_THRESHOLD = 0.4`
keeps the largest of any overlapping pair. Then — and this is the part that matters
for humans rather than for accuracy — it **re-sorts the survivors into reading
order** by `(top, left)`.

Detector output order is essentially arbitrary. Reading order means "face 3" is the
third face from the top-left, so when a teacher looks at a review queue and then
looks at the room, the indices correspond to something they can see.

**4. Encode each face.** 128-d encodings with `model="large"` (68-point landmarks)
and `num_jitters=1`. The large landmark model costs more per face but is
noticeably better on the off-axis, partially-turned faces that dominate a candid
classroom photo — which is exactly the population this pipeline has to handle.

**5. Query the roster.** For each encoding, a cosine query against
`face_embeddings`, filtered to the students in *this subject's roster* who have
`face_enrolled: True`. Students without a face vector are excluded from the query
and counted, and the response carries an explicit warning naming how many roster
students "have not enrolled their face yet and cannot be matched from a photo" —
otherwise their absence looks like a recognition failure.

**6. Assign greedily, closest first.** All faces are sorted by their best distance
ascending, and assigned in that order against a `claimed: dict[student_id, face_index]`
map. The consequence is the one you want: when two faces both look like Priya, the
*better* match gets her, and the worse one is queued as ambiguous rather than
silently overwriting the good match.

Greedy-closest-first is not globally optimal the way the Hungarian algorithm would
be, but it has a property that matters more here — it never trades a confident match
away to improve an unconfident one.

**7. Decide, per face.** The review reason is chosen by a fixed precedence:

| Precedence | Reason | Condition |
|---|---|---|
| 1 | `LOW_RESOLUTION` | box below `min_face_pixels` — forced, checked before matching |
| 2 | `NO_MATCH` | no candidate at all, or best distance > `review_ceiling` (0.28) |
| 3 | `LOW_CONFIDENCE` | best distance > `match_threshold` (0.12) but within the ceiling |
| 4 | `AMBIGUOUS` | runner-up within `ambiguity_margin` (0.04) of the best |
| 5 | `AMBIGUOUS` | best candidate already claimed by a closer face |

`LOW_RESOLUTION` is checked first and short-circuits: a 20-pixel face might
coincidentally land within threshold of someone, and reporting that as a confident
match would be worse than admitting the photo does not have the detail.

The distinction between `NO_MATCH` and `LOW_CONFIDENCE` is what makes the queue
usable. `NO_MATCH` means "this is probably a visitor, or someone who has not
enrolled" — the teacher should expect to dismiss it. `LOW_CONFIDENCE` means "this is
probably the person we are suggesting, we are just not certain enough to write it
down" — the teacher should expect to confirm it.

**8. Zero faces is a result, not an error.** A photo the detector finds nothing in
returns `faces_detected: 0` with a warning, HTTP 200. The teacher's next action is to
retake the photo, and an error page is a worse way to tell them that than a summary
saying so.

### Then the five write steps

`app/services/class_photo.py` orders the persistence deliberately:

1. detect and match — **entirely in memory**;
2. write the confident matches as attendance records;
3. write the leftovers to `pending_face_matches`, each with its crop;
4. update the session's `photo_review_status` and `photo_stats`;
5. return the summary.

> The photo bytes go out of scope here and are never persisted.

This is not wrapped in a transaction, and the reasoning is explicit: a failure
part-way through leaves some attendance rows written and some review items missing,
which the teacher can see and fix from the live session view. There is **no
partially-written biometric state to clean up** — the only thing a rollback would
protect is bookkeeping the UI already surfaces.

### The tunable constants, and what moving them does

All of these are environment variables, documented in `backend/.env.example`.

| Setting | Default | Raising it | Lowering it |
|---|---|---|---|
| `FACE_MATCH_THRESHOLD` | 0.12 | more auto-marks, more wrong ones | fewer auto-marks, longer queue |
| `FACE_REVIEW_CEILING` | 0.28 | more speculative suggestions in the queue | more faces reported as `no_match` |
| `FACE_AMBIGUITY_MARGIN` | 0.04 | more faces queued as ambiguous | more confident marks between lookalikes |
| `MIN_FACE_PIXELS` | 48 | back-row faces get queued as low-resolution | tiny faces get matched on too little detail |
| `CLASS_PHOTO_MAX_DIM` | 2400 | slower, more memory, marginal accuracy | faster, small faces start failing |
| `FACE_DETECTION_UPSAMPLE` | 1 | finds smaller faces, much slower | faster, misses the back row |
| `FACE_DETECTION_MODEL` | `hog` | `cnn` is more accurate and far slower | — |

`ABSOLUTE_MIN_FACE_PIXELS = 24` is a floor in code, not configuration:
`MIN_FACE_PIXELS` cannot be lowered below it. Twenty-four pixels is below the point
where a 128-d encoding carries meaningful identity, so allowing it would produce
confident-looking nonsense.

The honest way to tune these is to run a real class photo with a known roster and
count the outcomes, which is what `backend/scripts/test_pipelines.py` exists for.

---

## 12. The review queue

Everything the photo pipeline would not commit to lands here, and this is where the
teacher's authority enters the system.

Each item shows the cropped face, the reason it was queued, and — when there is one
— a best-guess student with a confidence percentage. The teacher has three
resolutions:

| Resolution | Effect |
|---|---|
| **assign** | marks that student present with method `face_photo_review` |
| **dismiss** | not a student, or not identifiable; no attendance change |
| **skip** | leave for later; the item stays unresolved |

### Three details that make it work

**`face_photo_review` is a distinct method from `face_photo`.** A row a human
confirmed is not the same evidence as a row the pipeline was confident about, and
analytics can tell them apart. This is also the number you watch when tuning
thresholds: if `face_photo_review` dominates, the thresholds are too strict for your
cameras.

**Already-present students stay assignable.** `assignable_students` does not filter
out students who already have an attendance row, because the common reason a teacher
is in this queue at all is to fix a mis-attributed automatic match — and fixing it
requires assigning the face to someone who is, wrongly, already marked.

**The crop is destroyed on decision.** `resolve_review_item` always calls
`face_crop_store.discard_crop(pending_id)`, on all three resolutions. The crop has
served its purpose the instant a decision is made. When the last item in a session's
queue is resolved (`remaining == 0`), a sweep discards any crops left on the session
for any reason, and the session's `photo_review_status` flips to `complete`.

### Coverage, so recognition failures are explicable

`embedding_coverage` cross-checks each roster student's Mongo `face_enrolled` flag
against the actual presence of a vector in Chroma. When they disagree, the UI can say
"re-enroll" — the alternative is a student who appears enrolled, is never recognised,
and has no way to find out why.

---

## 13. Rotating-QR check-in

### The threat model, stated first

A QR code encoding the session id is trivially defeated: one student photographs the
projector and sends it to three friends at home, who check in from bed. Any static
code has this property, no matter what it encodes, because the code is the same at
10:00 and at 10:40.

So SnapAttend's QR does not encode a session id. It encodes a **signature over
`(session_id, nonce)`**, and the nonce is replaced every `QR_TOKEN_TTL_SECONDS`
(30 by default). A screenshot is worthless half a minute after it was taken.

### What the code actually contains

```
{FRONTEND_URL}/scan?t={signed_token}
```

A URL, not a bare token, so a phone's built-in camera app can open it directly. That
matters more than it sounds: requiring students to install or open a QR-reader app
would be a bigger adoption obstacle than the whole rest of the feature.

This is also why `FRONTEND_URL` is not a cosmetic setting. It is baked into every
rendered QR code, so a wrong value produces codes that scan to nothing.

The PNG is returned as a **base64 data URL** with error correction level `M` (~15%
damage tolerance, appropriate for a projector at the back of a hall). A data URL
rather than a hosted image because the token changes every 30 seconds: a URL would
need cache-busting on every rotation, and would be fetchable by anyone who guessed
it.

### Rotation is atomic

The teacher's browser polls for the current code. Several polls can arrive at once —
two browser tabs, or a teacher's laptop plus the projector machine. Rotation is
therefore a single conditional `find_one_and_update`:

```python
{"$or": [{"qr_token_expiry": None}, {"qr_token_expiry": {"$lte": now}}]}
```

Exactly one concurrent caller matches and writes the new nonce. The losers do not
issue a rival token — they re-read the document and return whatever the winner
wrote. Without this, two tabs would fight, each invalidating the other's code, and
the projected QR would flicker between two values that both keep failing.

### The grace window

When the nonce rotates, the outgoing value moves to `qr_previous_nonce` and stays
acceptable for one more rotation.

This is not laxity; it is the fix for a real race. A student's phone renders the
code, they aim, they tap — a second or two passes, and the code may rotate in that
gap. Without the grace window a meaningful fraction of honest scans fail, and the
students who experience it have no way to tell they did anything right. With it,
they succeed, and the effective spoofing window grows from 30 seconds to 60 — still
far too short to be useful to someone who is not in the room.

Paired with this: the *signature* stays valid for `QR_TOKEN_TTL_SECONDS * 2`, so a
scan that has genuinely fallen out of even the grace window fails the **nonce**
check with `qr_rotated` ("This QR code has refreshed. Scan the code currently on
screen") rather than as an opaque expired signature.

### The landing page, and the one public endpoint

The student's phone opens `/scan?t=…`. This is the only place in the product where
someone arrives holding a credential *before* they are known to be signed in — the
scan may well be the first thing they do all day.

So `GET /api/public/scan` is the API's single unauthenticated endpoint. It uses
`@optional_auth` (works signed in or not) and `@limiter.limit("60 per minute")`. It
is rate-limited despite being read-only because it is the one unauthenticated route
that performs signature verification and a database lookup, and that is enough work
to be worth abusing.

It returns **bounded information only** — never the roster, never anyone's attendance
state. Enough to render an honest page and nothing more.

The interesting part is that almost every outcome is an HTTP **200 with a `reason`**,
not an error:

| `reason` | Meaning | What the page offers |
|---|---|---|
| `not_signed_in` | valid code, no session | sign in, then return here |
| `staff_account` | a teacher scanned it | "this is a student check-in code" |
| `no_student_profile` | signed in, no student record | contact your administrator |
| `wrong_institution` | valid code, different tenant | cannot check in here |
| `not_enrolled` | not on this subject's roster | ask to be added |
| `already_present` | already marked | shows it, offers nothing to do |

Plus the success branch: `can_check_in: true` with `action: "voice" | "qr"`.

Returning 200 for all of these is what lets the page be *useful* in every case. A
student who is not signed in gets a sign-in prompt that returns them to the scan,
carrying the token — not an error page that loses it. This is also why `/scan` is one
of the five deliberately **unguarded** frontend routes.

The five genuine error codes are separate: `token_invalid` (bad signature), 404 (the
session no longer exists), `session_ended`, `mode_mismatch` (a QR scan on a
voice-only session), `qr_rotated`, and `window_closed`.

`ScanReason` in `frontend/src/lib/constants.js` mirrors those six literals, and
`backend/tests/test_constants.py` keeps them in step by parsing the reason literals
straight out of `routes/public.py` — there is no backend enum to import, because the
values live as literals in the one route that produces them.

---

## 14. Voice check-in

Same shape as QR: the student lands on the session, records the passphrase, and the
clip is compared against their enrolled voiceprint.

The important structural difference is in what the comparison *is*.
`verify_voice(...)` takes `candidate_student_ids`, which is normally a
**single-element list**, because voice check-in is self-service: the student is
already authenticated, so the system is *verifying a claimed identity*, not searching
for one. A 1-to-1 comparison is a far easier problem than 1-to-N, and it is the one
the situation actually presents.

### The accept boundary

Resemblyzer returns 256-d embeddings that are already unit-normalised. Empirically:

- same-speaker pairs land at cosine distance **0.05 – 0.25**;
- different speakers land **well above 0.4**.

`VOICE_MATCH_THRESHOLD` is **0.25** — cosine similarity ≥ 0.75. That sits at the top
of the same-speaker band, which is a deliberately conservative accept boundary: it
prefers to ask a student to record again over accepting a friend's voice.

Verified independently: the encoder loads on CPU and produces 256-d vectors with
norm exactly 1.0000.

### Failure messages are instructions

Every rejection tells the student what to change, not what went wrong internally:

| Situation | Message |
|---|---|
| silent recording | "The recording is silent. Check that your microphone is unmuted and try again." |
| too little speech | "Only 0.0s of speech was detected; at least 1.5s is needed. Please read the whole phrase clearly." |
| wrong format | "Expected WAV/FLAC/OGG — WebM/Opus is not supported server-side (the browser converts to WAV before upload)." |

All three verified by running the pipeline against synthetic input.

---

## 15. Marking: the one decision point

Face, voice, QR and manual all converge on `app/services/attendance.py`. Nothing
else in the codebase writes an attendance record. Four invariants hold there, and
they hold for every method precisely because there is only one implementation.

### Invariant 1 — Idempotent

The unique index `uq_session_student` means one row per student per session, and
`mark_present` does not check-then-write. It writes, catches `DuplicateKeyError`, and
branches three ways:

- **Already present** → no second row, and the original `method_used` and
  `timestamp` are preserved. *The first successful verification is the one that
  happened.* A student matched in the photo and then scanning the QR does not have
  their evidence rewritten to `qr`.
- **A manual override exists** → returns `blocked_by_override=True` and changes
  nothing at all.
- **An automated `absent` row exists** → upgraded to present, because that is new
  information about the same student.

### Invariant 2 — Roster-scoped

You cannot be marked present for a subject you are not enrolled in, whatever the
mechanism said. A face that matches a student from another class is not attendance;
it is a visitor.

### Invariant 3 — Manual wins

> If a teacher marked someone absent for a reason, an algorithm does not get to
> disagree.

`was_manual_override: true` makes a row immune to every automated method. The teacher
can change their own decision; nothing else can.

`set_manual` also clears `confidence_score` and `face_box` — confidence is
meaningless for a human decision, and leaving a stale 0.94 on a row a teacher
corrected would actively mislead whoever reads it later. It records the full
`previous_state` and `new_state` in the audit log, along with the **mandatory
reason**: an override without a justification is not accepted by the API.

### Invariant 4 — Mode-respecting

A method may only mark a session whose mode permits it:

```python
_METHOD_REQUIRES_MODE = {
    AttendanceMethod.FACE_PHOTO:        VerificationMode.includes_photo,
    AttendanceMethod.FACE_PHOTO_REVIEW: VerificationMode.includes_photo,
    AttendanceMethod.QR:               VerificationMode.includes_qr,
    AttendanceMethod.VOICE:            VerificationMode.includes_voice,
}
```

`manual` is deliberately absent — a teacher's override is never blocked by the mode
they picked earlier.

### The time window applies asymmetrically

`_assert_window_open` blocks only self-service methods (`qr`, `voice`). Teacher-driven
paths are exempt, and that is a product decision rather than an oversight: a teacher
legitimately uploads the class photo *after* the lesson, and a manual correction may
happen days later when a student produces a medical note.

A student's scan, by contrast, is evidence of being in the room *now*, so it is only
accepted while the session window is open — otherwise the whole rotating-nonce design
would be pointless.

### One audit entry per batch

`mark_many_present` writes **one** audit entry for a whole class photo, not one per
student (`write_audit=False` on each row). Sixty near-identical log lines would bury
the handful of manual overrides that actually warrant review, which is the only
reason anyone opens the audit log.

### Reading the roster back

`session_roster_view` does three small queries and joins them in Python rather than
using `$lookup`. The sort key is `(status != "present", name.lower())`, so present
students come first and the absentees land in one contiguous alphabetised block at
the bottom — as the source comment puts it, "the teacher's eye goes to who is
missing." Sorting purely by name would scatter the four people who are missing among
the twenty-six who are not.

---

## 16. Analytics, and the denominator problem

The headline number in the product is "what percentage of classes has this student
attended". Getting it right is subtler than it looks, and `app/services/analytics.py`
is 784 lines mostly because of that subtlety.

### The naive formula is wrong

```
percentage = present_count / total_sessions_in_subject      # wrong
```

A student who joins a subject in week six is penalised for the five weeks before they
were on the roster. Their percentage starts near zero and takes months to recover,
and every alert and defaulter report inherits the error.

So the denominator is **sessions that started on or after `enrollments.created_at`** —
the number of classes they could actually have attended. That is the entire reason
`enrollments` is a collection with a timestamp rather than an array of ids on the
subject document.

### Which sessions count at all

`_countable_sessions` applies a second rule:

- an **ended** session always counts — a class where nobody showed up is real data and
  a genuine 0% should be visible;
- an **active** session counts only once something has happened in it.

Without the second clause, a teacher who opens a session five minutes before the
lesson would make the entire class show as absent for those five minutes, every
percentage in the subject would dip, and any alert running in that window would fire
on noise.

`_percentage` treats `total == 0` as `0.0` rather than raising. A brand-new student
with no countable sessions yet has no meaningful percentage, and 0.0 with a session
count of 0 beside it is honest; a `ZeroDivisionError` in a dashboard is not.

### Thresholds resolve in three steps

`effective_threshold` checks, in order:

1. the subject's `attendance_threshold`, if it is not `None`;
2. the institution's `settings.attendance_threshold`;
3. `Config.DEFAULT_ATTENDANCE_THRESHOLD` (75.0).

Resolution happens **at read time**, not at write time, which is why raising the
institution default immediately affects every subject that never set its own — and
why a subject that did set one is unaffected. A lab with a 90% requirement and a
seminar with 60% coexist under one institution default.

### What it computes

| Function | Answers |
|---|---|
| `student_directory` | the staff-facing student list with percentages |
| `subject_report` | every student in one subject, present/total/percentage |
| `subject_trend` | attendance over time for one subject |
| `student_report` | one student across all their subjects |
| `student_history` | one student's individual attendance rows |
| `defaulters` | everyone below their effective threshold |
| `institution_overview` | the admin dashboard aggregate |
| `teacher_overview` | the teacher dashboard aggregate |

### CSV exports

Four exports — `subject_report_csv`, `session_csv`, `student_report_csv`,
`defaulters_csv` — all written with `lineterminator="\r\n"`, and the route prepends a
**UTF-8 BOM**.

Both details are for one reason: Excel on Windows. Without the BOM it interprets the
file as the local codepage and mangles every non-ASCII name; without CRLF some
versions treat the whole file as one row. The `Content-Disposition` header is exposed
through CORS (`expose_headers=["Content-Disposition"]`) so the browser can read the
filename the server chose rather than saving everything as `download`.

---

## 17. Low-attendance alerts

An email that tells a student they are below the threshold *while they can still fix
it* is the feature that makes the percentages worth collecting.

`app/services/alerts.py` is deliberately a plain function rather than a task queue —
there is no Celery, no Redis, no broker. It is invoked two ways:

- `backend/scripts/send_low_attendance_alerts.py`, run from cron or Task Scheduler;
- the admin dashboard's **"Send alerts now"** button, which also offers a dry run.

The same code path serves both, so what an admin previews is what the cron will do.

### Two rules that stop it becoming noise

**`MIN_SESSIONS_BEFORE_ALERT = 4`.** A student with only a couple of recorded classes
is not a defaulter yet — one missed class out of two is 50%, and emailing that is
alarming and useless.

**A cooldown, default 7 days,** enforced by looking up the most recent `alert_log` row
for that `(student, subject)` pair. Without it a nightly cron emails the same student
every night until they attend, which is the fastest possible way to get a feature
muted by its own audience.

### Skip reasons, and one that is subtle

| Skipped when | Why |
|---|---|
| within the cooldown | see above |
| no email on file | nothing to send to |
| account is not `active` | see below |
| account is not `student` | staff have no attendance to warn about |

The account-status check is the subtle one. A disabled or never-activated student's
percentage is *an artefact, not a warning* — they were never able to attend, so the
low number reflects their account state rather than their behaviour. Emailing them
would be both confusing and, for a disabled account, arguably a mistake.

### `dry_run` and `run_all`

`dry_run` computes every recipient, every percentage and every skip reason, and sends
nothing. It is the only safe way to answer "what would happen if I turned this on"
against real data.

`run_all` wraps **each tenant in its own try/except**, so one institution with a
malformed setting cannot stop the other forty from being processed. A cron job that
fails halfway is worse than one that reports partial success, because nobody notices
the silence.

---

## 18. The audit log

Twenty-three actions, each namespaced `subject.verb`:

```
alert.low_attendance_sent      institution.created            subject.deleted
attendance.manual_override     institution.settings_updated    subject.updated
attendance.marked              roster.student_added            user.activated
biometric.enrolled             roster.student_removed          user.disabled
biometric.reset                session.created                 user.enabled
class_photo.crops_discarded    session.ended                   user.invite_revoked
class_photo.processed          subject.created                 user.invited
class_photo.review_resolved                                    user.password_reset
```

The `subject.verb` shape is enforced by a test, and it is not cosmetic:
`humanizeAction` in `frontend/src/lib/format.js` turns an action into a label by
replacing `.` and `_` with spaces, so an action without a separator would render in
the audit log as one run-on word.

Each entry carries `actor_id` (`None` for cron and system actions), `target_id` and
`target_type`, an optional `reason`, and `previous_state` / `new_state`. The state
pair is what makes a manual override reviewable: you can see the student was marked
present, that a teacher changed them to absent, and the reason they gave.

`class_photo.crops_discarded` is in that list for a specific reason — the destruction
of biometric data is itself an auditable event, so "the crops were deleted" leaves a
trace even though the crops do not.

---

## 19. Privacy posture

A system that photographs students and records their voices has to be able to answer
"where are the pixels?" precisely. `app/services/face_crop_store.py` exists to make
that answer short, and its docstring is the complete inventory.

### Everywhere a face image exists

**1. The uploaded class photo — request memory only.**
It is decoded, matched, and goes out of scope when the request ends. *There is
deliberately no code anywhere that persists it.* Not a temp file, not a cache, not an
uploads directory.

**2. Review-queue crops — small base64 JPEGs on `pending_face_matches`.**
The only persisted face images in the system, and only for faces the pipeline could
not identify. Removed by **three** independent mechanisms:

- `discard_crop()` when the teacher resolves the item — on all three resolutions;
- `discard_session_crops()` when a session's queue empties;
- the **TTL index** on `expires_at`, after `FACE_CROP_TTL_HOURS` (24), regardless of
  whether anyone ever looked at the queue.

The TTL is the one that matters, because it is the only one that does not depend on a
human doing something. A teacher who uploads a photo and never opens the queue still
gets the crops deleted within a day.

**3. Enrollment samples — embedded and discarded within the request.**
The 128-d or 256-d vector is kept; the image and the audio are not.

Voice recordings have no equivalent of the crop store. They are never persisted at
all, at any stage.

### Why the crop lives in Mongo rather than on disk

A filesystem cache would need its own sweeper process, and it could orphan files if a
delete failed part-way — a file on disk with no database row pointing at it is
invisible to every report and every deletion request. Keeping the crop *inside* the
row means the TTL index that deletes the row deletes the pixels, atomically, with no
second system to trust.

### Discard keeps the facts, drops the pixels

`discard_crop` uses `$unset` on `crop_jpeg_b64` and sets `crop_discarded: True`. The
row survives — who resolved it, when, to whom, and why — because that is the audit
trail. Only the image is gone.

Belt and braces: `utils/serialization.py` independently blocks `crop_jpeg_b64` from
generic document serialisation, so a route that returns a raw pending-match document
cannot leak a crop by accident.

### The privacy report

`privacy_report()` backs an admin page and returns:

| Field | Meaning |
|---|---|
| `review_items_total` | all review items |
| `crops_retained` | how many still hold an image |
| `unresolved_items` | awaiting a teacher |
| `resolved_but_crop_retained` | **expected to be 0** |
| `crop_ttl_hours` | the configured TTL |
| `class_photos_stored` | hard-coded `0` |
| `enrollment_images_stored` | hard-coded `0` |

`resolved_but_crop_retained` is the interesting one — it is a self-check. Any value
other than zero means the discard-on-resolve path has broken, and the page surfaces it
rather than requiring someone to think of the question.

The last two are hard-coded zero **by design, because there is no code path that
stores one.** They are in the report so an administrator can see the claim stated,
rather than having to take it on trust.

---

## 20. Errors

One envelope, everywhere, for every failure:

```json
{ "error": { "code": "…", "message": "…", "details": {} } }
```

`app/utils/errors.py` defines `ApiError`, and the app factory registers handlers that
wrap Flask's own errors into the same shape — a 404 from an unknown URL, a 413 from
`MAX_CONTENT_LENGTH`, a 429 from Flask-Limiter and an unhandled 500 all come out
looking identical to an error the application raised on purpose.

`message` is written to be shown to a user. `code` is written to be branched on.
`details` carries structured extras — the offending field name for a validation
failure, the library's own explanation for a rejected JWT.

The 22 codes the frontend recognises, grouped by what the UI does with them:

**Generic HTTP shape** — `unauthorized`, `forbidden`, `not_found`, `conflict`,
`unprocessable`, `rate_limited`, `payload_too_large`, `service_unavailable`.

**Tokens** — `token_expired`, `token_invalid`, `token_used`. These drive the "request
a fresh link" affordance on the reset and invite pages instead of a dead end.

**Session and check-in state** — `qr_rotated`, `session_ended`, `window_closed`,
`mode_mismatch`. Each maps to a specific sentence on the scan page; collapsed into a
generic failure, a student would have no idea whether to rescan, wait, or give up.

**Enrollment state** — `not_enrolled`, `voice_not_enrolled`. The difference matters:
the first means "you are not on this roster", the second means "you are, but you have
no voiceprint yet" — and only the second has an action the student can take.

**Account state** — `account_disabled`, `account_not_activated`.

**Review state** — `already_resolved`. Two teachers can open the same queue; the second
one to click gets told the item is already decided rather than silently overwriting.

**Pipeline availability** — `face_pipeline_unavailable`, `voice_pipeline_unavailable`.
These are what a deployment missing dlib or torch returns, and they are distinct from
a generic 500 so the UI can say "face matching is not available on this server"
instead of "something went wrong".

A test in `backend/tests/test_constants.py` greps the entire `app/` tree for
`code="…"` and asserts that **every** code the frontend branches on can actually be
raised. A code the UI handles but the backend never emits is dead code guarding an
unreachable branch — usually a silent failure to handle the case the author thought
they were handling.

---

## 21. The frontend

React 18.3, Vite 5.4, react-router-dom 6.26, axios 1.7. Plain JavaScript `.jsx`
throughout — no TypeScript.

**Four runtime dependencies, and no more.** No component library, no chart library, no
QR-reader package, no icon package. Icons are inline SVG, the two charts are
hand-rolled SVG, and the QR scanner is the phone's own camera app opening a URL. The
constraint keeps the install small and the bundle honest: 533 kB of JS (163 kB
gzipped) for 26 pages.

### Structure

```
src/
  pages/        26  — one per route
  components/   40  — 13 top-level, 2 charts, 3 layout, 21 ui primitives + barrel
  hooks/         6  — useAsync, useCountdown, useDebouncedValue,
                      useDocumentTitle, usePolling, useResource
  contexts/      2  — AuthContext, ToastContext
  lib/           5  — api, audio, camera, constants, format
  styles/index.css
  App.jsx, main.jsx
```

Pages import primitives from the `components/ui/index.js` barrel, so a page's import
block reads as a list of what it uses rather than a wall of paths. Every component is a
default export; all six hooks and both contexts export named *and* default, because
they get imported both ways depending on whether the call site is destructuring.

### Three route tiers, chosen by what they must cope with

`App.jsx` groups routes by their access requirements rather than by role:

**Public.** `/` redirects by role; `/login` and `/register` are wrapped in
`PublicOnlyRoute` so a signed-in user is bounced to their dashboard.

**Deliberately unguarded** — and this is the interesting tier. Five routes are wrapped
in *nothing*: `/forgot-password`, `/reset-password`, `/accept-invite`, `/scan`,
`/enroll`.

They cannot be `PublicOnlyRoute`, because that would send a signed-in student who just
scanned the projected code to their dashboard — **dropping the token they arrived
with**. A student holding a valid QR token must land on the scan page whether or not
they are already logged in. The same reasoning applies to a teacher clicking an invite
link while signed in as someone else.

**Protected.** One *pathless* layout route wrapping `ProtectedRoute` → `AppShell`, so
the shell mounts exactly once for the whole authenticated app. Wrapping each page
individually would remount the sidebar on every navigation, which closes the mobile
drawer mid-tap — a bug you only find on a phone.

Inside it: `/account` for any role; `/student` with `check-in` and `attendance`; the
staff routes behind `RoleRoute roles={STAFF_ROLES}` (`/teacher`, `/subjects`,
`/subjects/:id`, `/sessions`, `/sessions/:id`, `/students`, `/students/:id`,
`/reports`); and `/admin` with `users`, `settings`, `audit`, `privacy`.

The staff routes are **flat, not nested**, because there is only one roster — nesting
`/students` under `/subjects/:id` would imply per-subject student pages that do not
exist. `*` → `NotFound` sits outside the shell, because an unknown path is most often
an expired link from an email, and the visitor may not be signed in.

### Polling, not websockets

The live session view — the teacher's screen during a class, showing who has checked
in — refreshes by polling every `LIVE_POLL_MS = 3000`.

This is a considered choice. Websockets would mean a stateful connection, a second
protocol through whatever proxy sits in front of the app, sticky sessions behind a load
balancer, and reconnection logic on the client. What it buys is sub-second latency for
a screen a teacher glances at every couple of minutes. Three-second polling on a
handful of open sessions is a rounding error in load, and it survives a dropped
connection without any code.

The `usePolling` hook pauses when the tab is hidden, so a forgotten open tab is not
still polling overnight.

### The enum mirror

`frontend/src/lib/constants.js` duplicates the backend's enums by hand, and says so:
*"Keep the two files in step — the backend is the source of truth."*

Nothing enforced that until `backend/tests/test_constants.py`, which parses
`constants.js` as **text** (there is no JS runtime in the Python test environment) and
asserts value-for-value equality for eleven enums, plus the mode labels, the six scan
reasons and the 22 error codes. A rename on one side without the other is a breaking
change that otherwise shows up as a filter quietly matching nothing.

The checks skip cleanly when `frontend/` is absent, so a backend-only deployment can
still run the suite.

### Where the API's sharp edges are absorbed

Several backend behaviours need care at the call site, and the frontend handles them
in one place each rather than everywhere:

- **`lib/api.js`** owns the token refresh, the single in-flight refresh shared by
  concurrent 401s, and the unwrapping of the error envelope into a typed error.
- **`lib/audio.js`** owns the WebM → 16 kHz mono WAV conversion, so no page has to
  know the backend cannot read Opus.
- **`lib/camera.js`** owns `getUserMedia` lifecycle and track cleanup — a camera left
  streaming after navigation leaves the indicator light on, which students notice.
- **`ToastContext`** owns every transient message, so an error is never rendered twice
  by a page and its child.

One rule runs through all of it: **never claim an email was sent when the backend did
not report it.** Where the API cannot distinguish "queued" from "delivered", the UI
says "invitation created" rather than "email sent".

---

## 22. Running it

Full setup, including the dlib ordeal on Windows, is in [README.md](../README.md).
The short version, and the parts that trip people up.

### Backend

```bash
cd backend
python -m venv .venv && source .venv/Scripts/activate   # Windows bash
pip install -r requirements.txt
cp .env.example .env      # then set MONGODB_URI and SECRET_KEY
python run.py             # http://127.0.0.1:5000
```

`run.py` is the development server. Production uses `wsgi.py` with gunicorn (Linux) or
waitress (Windows).

**`SECRET_KEY` must be changed.** It signs the JWTs *and* all three token families. The
default is literally `"dev-only-insecure-secret-change-me"`, and
`Config.missing_required()` reports both an unset `MONGODB_URI` and a `dev-only` key at
startup.

**Two install traps.** First, `dlib` — it is C++, has no official Windows wheel, and the
README has a whole section on it. Second, and much less obvious:

```bash
pip install "setuptools<81"
```

`face_recognition_models` imports `pkg_resources`, which **setuptools 81 removed**. On a
current setuptools, `import face_recognition` dies with
`ModuleNotFoundError: No module named 'pkg_resources'` — a confusing failure that looks
like a broken dlib build but is not. Pinning setuptools below 81 fixes it. This bites
anyone setting the project up today, because pip installs the latest setuptools by
default.

### Frontend

```bash
cd frontend
npm install
npm run dev               # http://localhost:5173
```

**Port 5173 is not negotiable.** `vite.config.js` sets `strictPort: true`, and 5173 is
the value of `FRONTEND_URL` in the backend `.env` — which is baked into every invite
email, every password-reset link, and **every QR code**. Starting the frontend on 5174
because 5173 was busy would produce QR codes that scan to a dead port.

Vite proxies `/api` and `/healthz` to `127.0.0.1:5000`, so the browser sees one origin
in development: no CORS preflight, no cookie configuration.

### Optional scripts

| Script | Purpose |
|---|---|
| `scripts/seed_demo_data.py` | an institution, staff, students, subjects and sessions |
| `scripts/test_pipelines.py` | exercises the real dlib and Resemblyzer paths against a folder of sample media |
| `scripts/send_low_attendance_alerts.py` | the alert cron entry point |
| `scripts/cleanup_face_crops.py` | manual crop sweep; the TTL index does this anyway |

`test_pipelines.py` needs a `backend/samples/` directory of face photos and voice clips.
With none present it exits cleanly saying so, rather than failing.

---

## 23. Verification status and known issues

### The test suite

```bash
cd backend
python -m pytest
```

**291 tests, all passing, in about 2 seconds.**

| File | Tests | Covers |
|---|---|---|
| `test_validators.py` | 82 | every input validator and its error `details` |
| `test_constants.py` | 41 | the enums, and that the frontend mirrors them exactly |
| `test_serialization.py` | 36 | ObjectId/datetime handling, and the field redactions |
| `test_csv_import.py` | 29 | bulk import parsing and per-row failure reporting |
| `test_auth_guards.py` | 28 | auth, roles, and 404-not-403 tenant isolation |
| `test_errors.py` | 25 | the envelope, and Flask's own errors being wrapped |
| `test_tokens.py` | 21 | the three salts, fingerprints, password-bound resets |
| `test_timeutil.py` | 17 | UTC handling and window arithmetic |
| `test_app_factory.py` | 12 | the factory, config overrides, blueprint registration |

The suite is **hermetic**: no MongoDB, no ChromaDB, no dlib, no torch, and no socket
opened. That is possible because of two properties of the application itself.

First, every heavy native import is *lazy* — `face_recognition` inside
`pipelines/face.py:176`, `cv2` in `imaging.py:197`, `resemblyzer` in `voice.py:99`
and `:188`, `librosa` in `voice.py:149`, `chromadb` in `vector_store.py:125`. Only
`numpy` is imported at module level. Second, `create_app` gates index creation behind
`if app.config.get("MONGODB_URI") and not app.config.get("SKIP_INDEXES")`.

So `create_app(TESTING=True, SKIP_INDEXES=True, MONGODB_URI="")` boots the *real*
application on the pure-Python stack plus numpy. An autouse fixture patches
`db.get_client` to raise `AssertionError`, so a test that accidentally reaches for the
database fails loudly instead of hanging on a connection timeout.

`python -m pytest` therefore works on a checkout where dlib has never been built.

### What has actually been executed

Stated plainly, because two earlier drafts of this project's docs claimed the suites had
never been run — that is no longer true:

| Check | Result |
|---|---|
| `python -m pytest` | **291 passed** in 2.08 s |
| `npm run build` | **passes** — 169 modules, 533.22 kB JS / 31.42 kB CSS, 3.95 s |
| `import face_recognition` + HOG detection | works (after `setuptools<81`) |
| `match_class_photo` on a faceless image | correct: `faces_detected: 0`, one warning |
| `enroll_face_samples` on a faceless image | correct: rejected as `no_face` |
| Resemblyzer `VoiceEncoder` on CPU | loads; 256-d output, norm 1.0000 |
| Voice rejection branches | all four correct (silence, non-speech, short, wrong format) |
| Chroma upsert / query / tenant scope | exact self-match; **cross-tenant hits 0**; empty-roster hits 0 |
| QR PNG rendering | valid `data:image/png;base64,…` |

`npm run build` emits one advisory warning that a chunk exceeds 500 kB. That is
expected for a single-bundle SPA of this size and is not an error.

**Not executed:** anything requiring real biometric samples of real people — a genuine
class photo matched against a genuine enrolled roster, and a genuine voice check-in.
Those need `backend/scripts/test_pipelines.py` pointed at a `samples/` directory. The
thresholds in [section 11](#11-the-class-photo-pipeline-end-to-end) are derived from
dlib's documented tolerance and Resemblyzer's published behaviour, not measured on this
deployment's cameras. Tune them against your own hardware before trusting them.

### Known issues

Six real defects, found by reading the code against its own documented contracts. All
six are in `backend/app/`, which is fixed reference material in this checkout, so each
is worked around on the frontend and listed here rather than patched.

**1. `POST /api/attendance/override` returns 500 after succeeding.**
`routes/attendance.py:320` is `return jsonify(result)`, where `MarkResult.record` holds
raw BSON `ObjectId`s and the app registers no custom JSON provider. Flask 3's
`DefaultJSONProvider` raises `TypeError`.

The important part: the Mongo write and the audit entry **commit first**. The override
takes effect and then the response fails, so a naive client retries an operation that
already happened. `SessionLive.jsx:120-135` treats a 500 from this endpoint as
provisional success and re-fetches the roster to confirm. `override_bulk` hand-builds
its response dict and is unaffected.
*Fix:* serialise the result, as every other route does.

**2. `mailer.send()` queues unconditionally.**
It does not check `MAIL_SUPPRESS_SEND`. An alert run on a deployment with no SMTP
configured writes `alert_log` rows — **burning the 7-day cooldown** — and delivers
nothing. The students who most needed the warning are then silent for a week.
`SettingsPage.jsx`'s `AlertRunner` warns before a live run when mail looks
unconfigured.
*Fix:* return a sent/suppressed result and skip the `alert_log` write when suppressed.

**3. `privacy_report()` counts across all institutions.**
It omits the `institution_id` filter, so an admin sees server-wide crop counts. A small
cross-tenant leak — counts only, no identities. `PrivacyPage.jsx` says "on this server"
rather than implying the numbers are the institution's.
*Fix:* pass `institution_id` and scope the counts.

**4. `change_role` audits under the wrong action.**
`routes/admin.py::change_role` writes `institution.settings_updated` instead of a
role-change action. A role escalation is therefore indistinguishable in the audit log
from someone editing the attendance threshold — which is exactly backwards, since the
role change is the one worth reviewing. `AuditPage.jsx` carries a footer note.
*Fix:* add a `user.role_changed` action.

**5. `GET /api/students?q=` searches only within the row limit.**
`routes/students.py:112` applies the limit before filtering, so a search for a student
outside the first page finds nothing — a silent wrong answer, not an error.
`StudentsPage.jsx` requests `limit: 1000` whenever `q` is non-empty. `GET
/api/admin/users` does **not** have this bug; its filter is applied in the query.
*Fix:* filter in the Mongo query rather than after the fetch.

**6. Bulk import cannot report whether mail was sent.**
It returns `emails_sent = len(invited)` regardless of SMTP configuration, so the number
is really "invitations created". The UI says exactly that instead of repeating the
label.
*Fix:* depends on fixing #2 first.

None of the six is a data-loss or privilege-escalation bug. #2 is the one to fix first,
because it fails silently in exactly the situation where someone is relying on it.

### Environment notes

- **`setuptools<81`** is required for `face_recognition` to import at all — see
  [section 22](#22-running-it).
- **`numpy` is pinned to 1.26.4** (`<2.0`) for librosa/numba/chromadb compatibility.
  Unpinning it breaks the voice pipeline.
- **`torch` is deliberately unpinned** so pip resolves a wheel matching the local
  platform and CPU.
- **chromadb 0.5.5 logs `Failed to send telemetry event … capture() takes 1 positional
  argument but 3 were given`** against newer posthog releases. Harmless — chromadb
  catches it, `anonymized_telemetry=False` is already set, and nothing is transmitted.
  It is log noise, not a fault.

---

*Written against SnapAttend 1.0.0.*

