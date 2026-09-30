# SnapAttend — Roadmap / What I'd Add Next

This is intentionally a list of *intentions*, not implemented features —
kept in its own file so `architecture.md` never has to say "sort of" about
what exists today. Useful as an answer to "what would you improve" without
claiming any of it is built.

## Near-term (would take a weekend each)

- **Class-scoped face matching.** `get_trained_model()` currently trains on
  every student in the database, and student login matches against everyone
  too. Scoping the classifier (or a vector index — see below) to "students
  enrolled in this subject" would cut both the false-match rate and the
  training cost as the school grows.
- **A vector index instead of retraining an SVM per run.** Once there are a
  few hundred students, refitting `sklearn.svm.SVC` on every attendance run
  stops being free. A local index (FAISS, or something like ChromaDB if an
  extra service is acceptable) turns "who does this face belong to" into an
  indexed nearest-neighbour lookup instead of a full retrain.
- **A confidence/ambiguity band instead of one hard threshold.** Right now
  `predict_attendance` marks someone present or not based on a single
  Euclidean cutoff (0.6). Adding a second, tighter threshold for "confident
  auto-mark" and a wider one for "flag for teacher review" would catch the
  cases in between instead of silently guessing.

## Medium-term

- **Real auth tokens.** Teacher identity currently lives in
  `st.session_state`, which is tied to one Streamlit session — it isn't a
  portable credential and doesn't support "log in from a second device."
  Issuing a signed JWT (even just for a future API layer) would be the
  natural next step.
- **A thin REST API in front of the pipelines.** Splitting `src/pipelines/`
  and `src/database/` behind a small Flask/FastAPI layer would let a real
  frontend (or a mobile app) use the same matching logic Streamlit uses now,
  and would be the prerequisite for auth tokens to mean anything.
- **Attendance analytics.** A per-subject percentage that accounts for
  students who joined a subject late, a configurable "at risk" threshold, and
  a CSV export — the current "Attendance Records" tab only shows raw
  per-session counts.

## Longer-term / larger scope

- **Multi-tenancy.** One Supabase project currently serves every teacher and
  student in the deployment. Scoping every table and query by an
  `institution_id` (with cross-tenant lookups returning 404, not a leaked
  403) would be required before this could serve more than one school.
- **Notifications.** Email invites, password resets, and low-attendance
  alerts — none of these exist today; there's no outbound email at all.
- **An audit trail for manual corrections.** There's currently no way to
  override an attendance record from the UI at all, so there's nothing to
  audit yet — but if manual override is ever added, logging who changed a
  record and why should ship in the same change, not after.

## Already added, separately from this list

- A pytest suite for the face/voice matching logic (`tests/`).
- A Dockerfile and a GitHub Actions CI workflow.
- This architecture write-up.

These are documented in the project's top-level `README.md` rather than
here, since they're done, not planned.
