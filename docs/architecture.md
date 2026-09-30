# SnapAttend — Architecture

This documents what the codebase actually does today. Nothing here describes
a plan or a wish — see [`roadmap.md`](roadmap.md) for that. Every claim below
was checked against the source in `app.py` and `src/`.

## 1. What it is

SnapAttend is a single-tenant classroom attendance app. A teacher creates
subjects, students enroll in them, and attendance is taken either by:

- **Face recognition** — the teacher uploads one or more class photos; every
  face found is matched against the enrolled roster.
- **Voice** — a student is identified by comparing a recorded phrase against
  their stored voiceprint.

Both mechanisms write rows into a single `attendance_logs` table.

## 2. The shape of the system

```
  Browser
     |  (Streamlit's own websocket protocol — no separate frontend build)
     v
  app.py  --- one Python process, st.session_state holds all UI/auth state
     |
     +--> src/screens/*.py ..... the three top-level views (home, teacher, student)
     +--> src/components/*.py .. dialogs and shared widgets used by the screens
     +--> src/pipelines/*.py ... face + voice matching (see below)
     +--> src/database/*.py .... the only code that talks to Supabase
                |
                v
          Supabase (managed Postgres)
```

There is no REST API layer: Streamlit renders server-side and pushes UI
updates to the browser directly, so "frontend" and "backend" are the same
process. That is a deliberate simplification for a classroom project, not an
oversight — see `roadmap.md` for what splitting it would take.

## 3. Data model (Supabase / Postgres)

Inferred from `src/database/db.py`, which is the only file that issues
queries:

| Table | Purpose |
|---|---|
| `teachers` | `username`, `password` (bcrypt hash), `name` |
| `students` | `name`, `face_embedding` (JSON array), `voice_embedding` (JSON array, optional) |
| `subjects` | `subject_code`, `name`, `section`, `teacher_id` |
| `subject_students` | join table: which students are enrolled in which subject |
| `attendance_logs` | `student_id`, `subject_id`, `timestamp`, `is_present` |

Notably, **embeddings live directly on the `students` row** as JSON, not in a
separate vector store. That's simple and fine at classroom scale; it's also
why matching has to re-train a classifier from the whole table on every run
rather than doing an indexed lookup (see Section 5).

## 4. Auth model

- **Teachers** register/log in with a username + password. Passwords are
  hashed with `bcrypt` (`src/database/db.py: hash_pass` / `check_pass`) —
  real hashing, not plaintext. Session identity is held in
  `st.session_state['teacher_data']`, which only exists for the lifetime of
  that browser tab's Streamlit session.
- **Students** never set a password. Logging in *is* the face-recognition
  step: a student looks at the camera, the system tries to recognize them
  against **every** student in the database (not scoped to a class), and if
  it succeeds it logs them in as that student. If no match is found, they're
  offered registration on the spot (`src/screens/student_screen.py`).

This means face recognition is doing double duty: it's both the attendance
mechanism *and* the student authentication mechanism, using the same global,
un-scoped match. Worth being able to say out loud in an interview — see the
comparison PDF you already have for suggested talking points.

## 5. The face pipeline (`src/pipelines/face_pipeline.py`)

1. `get_face_embeddings(image)` runs dlib's frontal-face detector and its
   ResNet-based encoder, producing one 128-dimension vector per detected
   face.
2. `get_trained_model()` pulls every student with a stored `face_embedding`
   and fits a **linear SVM** (`sklearn.svm.SVC`) to classify an embedding
   into a `student_id`. This is retrained from scratch on every attendance
   run (cached per Streamlit session via `st.cache_resource`).
3. `predict_attendance(image)` runs both of the above, then — this is the
   part worth knowing cold — **doesn't just trust the SVM's label**. For
   whichever student the SVM predicts, it separately computes the Euclidean
   distance between the new encoding and that student's *actual* stored
   embedding, and only marks them present if that distance is at or below
   `0.6` (dlib's own documented tolerance for "same person"). A confident SVM
   guess that's still too far from the claimed student's real embedding is
   rejected, not accepted. This is a legitimate second line of defense
   against misclassification, even though it's a single global threshold
   rather than the ambiguity-margin/review-queue design a larger system
   might use.

## 6. The voice pipeline (`src/pipelines/voice_pipeline.py`)

1. `get_voice_embedding(audio_bytes)` loads audio via `librosa`, runs
   Resemblyzer's `VoiceEncoder`, and returns a 256-d embedding.
2. `identify_speaker(embedding, candidates, threshold=0.65)` is a plain
   nearest-neighbour search by cosine similarity (dot product of
   already-unit-length vectors) against every candidate passed in — it takes
   whatever dict of `{student_id: embedding}` it's given, so scoping it to a
   class roster rather than the whole school is a caller-side decision, not
   a pipeline-side one.
3. `process_bulk_audio(...)` splits one recording into speech segments
   (`librosa.effects.split`) and runs `identify_speaker` per segment, which
   is what lets a teacher run one "roll call" recording instead of one
   recording per student.

## 7. What's already correct here

Two things worth stating plainly, because they're easy to undersell in an
interview: passwords are properly hashed (not plaintext, not reversible
encoding), and the face-matching pipeline already has a real two-stage check
(SVM label + distance-to-claimed-embedding) rather than trusting a single
classifier output. Both are the kind of detail that shows you understand
*why* the code does what it does, not just that it works.
