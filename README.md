# SnapAttend

AI-powered classroom attendance. A teacher takes attendance either by
uploading a class photo (face recognition, dlib + a linear SVM) or by
recording a student's voice (Resemblyzer speaker embeddings). Built as a
single-page [Streamlit](https://streamlit.io) app backed by
[Supabase](https://supabase.com) (managed Postgres).

For how it actually works under the hood, see
[`docs/architecture.md`](docs/architecture.md). For what's intentionally
*not* built yet, see [`docs/roadmap.md`](docs/roadmap.md).

## Scope

This is a single-tenant, classroom-scale project: one deployment serves one
shared pool of teachers and students, matching is done against the whole
student table rather than per-class or per-institution, and there's no
separate API layer — Streamlit is the whole app. That's a deliberate choice
to keep the focus on the ML pipeline and the data model rather than on
infrastructure; see `docs/roadmap.md` for what scaling it up would involve.

## Setup

**Prerequisites:** Python 3.11 or 3.12, and a Supabase project.

```bash
git clone https://github.com/Lalit1680/snapattend.git
cd snapattend
pip install -r requirements.txt
```

Copy the secrets template and fill in your own Supabase project's values
(**Project Settings → API** in the Supabase dashboard):

```bash
cp .streamlit/secrets.toml.example .streamlit/secrets.toml
# then edit .streamlit/secrets.toml
```

Run it:

```bash
streamlit run app.py
```

### Database schema

The app expects five tables in Supabase: `teachers`, `students`, `subjects`,
`subject_students`, and `attendance_logs`. See
[`docs/architecture.md`](docs/architecture.md#3-data-model-supabase--postgres)
for each table's columns — the schema is inferred from `src/database/db.py`
rather than shipped as a migration file, since none exists in this repo.

## Running with Docker

```bash
docker build -t snapattend .
docker run -p 8501:8501 -v "$(pwd)/.streamlit:/app/.streamlit:ro" snapattend
```

Then open http://localhost:8501.

## Running the tests

```bash
pip install pytest
pytest
```

`tests/` covers the face- and voice-matching logic in `src/pipelines/`
(threshold behaviour, the SVM training path, speaker identification). It
does not require a live Supabase project or a working `dlib` build —
`tests/conftest.py` explains how that's achieved and exactly what's stubbed
out to make that possible.

## CI

Every push runs the test suite via GitHub Actions
(`.github/workflows/ci.yml`) — install dependencies, run `pytest`.

## Project layout

```
app.py                          entry point — routes to a screen based on session state
src/
  screens/                      the three top-level views: home, teacher, student
  components/                   dialogs and shared widgets used by the screens
  pipelines/
    face_pipeline.py            dlib detection + encoding, SVM matching
    voice_pipeline.py           Resemblyzer embeddings, cosine-similarity matching
  database/
    config.py                   Supabase client, reads st.secrets
    db.py                       every query the app makes
  ui/
    base_layout.py              shared page styling
tests/                          pytest suite for src/pipelines/ (see above)
docs/
  architecture.md               how the app actually works today
  roadmap.md                    what's intentionally not built yet
Dockerfile
.github/workflows/ci.yml
.streamlit/secrets.toml.example
```

## Privacy note

Face and voice embeddings are biometric data. This project stores them
directly on each student's row in Supabase; there's no separate consent flow
or retention policy implemented. Treat any real deployment of this
accordingly.
