# SnapAttend

Automated classroom attendance for institutions, built around the honest constraint
that **no single capture method works for every classroom**. A back-row student is a
28-pixel face; a shared laptop makes a QR code trivially forwardable; a corridor of
noise ruins a voice sample. So SnapAttend offers three methods, lets a teacher pick per
session, and makes the failure cases visible instead of guessing:

| Method | How it works | Where it earns its place |
| --- | --- | --- |
| **Class photo** | One wide shot; dlib finds every face and matches each against the subject's enrolled roster | Zero student effort, marks 30 people in one action |
| **Rotating QR** | A code on the projector that changes every 30 seconds; students scan and are marked | Works when the camera cannot see the room; the rotation is what stops a screenshot being shared |
| **Voice** | A student speaks a per-institution passphrase; 1:1 verification against their enrolled voiceprint | The fallback when a student is masked, in shadow, or the photo missed them |

Ambiguous face matches are never silently marked. They go to a **review queue** with
the crop and the system's best guess, and a human decides. A teacher's manual
override always wins, and always records who did it and why.

---

## Contents

- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Backend setup](#backend-setup)
- [Installing dlib (the hard part on Windows)](#installing-dlib-the-hard-part-on-windows)
- [Frontend setup](#frontend-setup)
- [Your first ten minutes](#your-first-ten-minutes)
- [Scheduled jobs](#scheduled-jobs)
- [Privacy and retention](#privacy-and-retention)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [Further reading](#further-reading)

---

## Architecture

```
  Browser (React + Vite, :5173)
        |
        |  JSON over HTTP, JWT in an Authorization header
        |  (dev: Vite proxies /api and /healthz to :5000, so it is same-origin)
        v
  Flask API (:5000)  --- app factory, 9 blueprints, one error envelope
        |
        +--> MongoDB Atlas ........ source of truth: institutions, users, students,
        |                           subjects, sessions, attendance, audit, invites
        |
        +--> ChromaDB (embedded) .. face + voice embeddings, cosine distance over
        |                           L2-normalised vectors. Persistent local dir,
        |                           no server process.
        |
        +--> dlib / face_recognition ...... face detection + 128-d encodings
        +--> Resemblyzer / librosa ........ 256-d speaker embeddings
        +--> SMTP ......................... invites, resets, low-attendance alerts
```

**Two stores, on purpose.** Mongo answers "who is enrolled in what, and who was
present"; Chroma answers "which of these faces is this face". Neither is good at the
other's job, and keeping the boundary sharp means a Chroma rebuild never risks the
attendance record.

**Multi-tenant throughout.** Every document carries an `institution_id`, every query
filters on it, and a cross-tenant lookup returns **404 rather than 403** — a 403
would confirm that the resource exists.

**No websockets.** The live session console polls `GET /api/sessions/<id>/live`
every three seconds. That endpoint is deliberately exempt from rate limiting. A
classroom has one teacher watching one screen for forty minutes; a polling loop is
the correct amount of machinery for that, and it survives a flaky network in a way a
dropped socket does not.

---

## Prerequisites

| | Version | Notes |
| --- | --- | --- |
| Python | **3.11 or 3.12** | 3.13 has no prebuilt wheels for parts of this stack yet |
| Node.js | **20 LTS or newer** | frontend only; the API runs without it |
| MongoDB | **Atlas free tier is enough** | or a local `mongod`; the URI is all that changes |
| Disk | ~4 GB | Resemblyzer pulls in PyTorch, which is most of it |
| C++ toolchain | see below | needed to build dlib unless you find a wheel |

A webcam and a microphone are needed to exercise enrollment and capture, but every
other screen works without them.

---

## Backend setup

```bash
cd backend
python -m venv .venv
```

Activate it — `.venv\Scripts\activate` on Windows (PowerShell/cmd),
`source .venv/bin/activate` on macOS/Linux, `source .venv/Scripts/activate` in Git
Bash on Windows.

Then, in this order:

```bash
pip install --upgrade pip wheel
```

```bash
pip install -r requirements.txt
```

If that fails, it will almost certainly be on `dlib` — jump to the next section and
come back.

Now the configuration:

```bash
cp .env.example .env
```

`backend/.env.example` documents every variable. The four you must set before the
app is useful:

```ini
SECRET_KEY=<long random string>
JWT_SECRET_KEY=<a different long random string>
MONGODB_URI=mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
FRONTEND_URL=http://localhost:5173
```

Generate the secrets with:

```bash
python -c "import secrets; print(secrets.token_urlsafe(48))"
```

`SECRET_KEY` signs invite links, password-reset links and QR tokens
(`itsdangerous`); `JWT_SECRET_KEY` signs access and refresh tokens. Keep them
separate so rotating one does not invalidate the other.

**Email is optional.** With SMTP unconfigured, the app does not fail — it logs the
message to the console *and* returns the invite or reset link in the API response, so
the UI can show you a copyable link instead. That is why an invite screen sometimes
shows a URL and sometimes says "email sent": the link only appears when there is no
mail server to send it.

Start it:

```bash
python run.py
```

Then confirm all four dependencies are actually reachable:

```bash
curl http://127.0.0.1:5000/healthz
```

`/healthz` returns **200 with `"status": "ok"`** only when Mongo, Chroma, mail and
the face-crop retention check all pass, and **503 with `"status": "degraded"`**
otherwise, with a per-dependency reason. It is a real readiness probe, not a page
that always says OK — so read it before assuming a problem is in your code.

For production, use a real WSGI server against `wsgi:app` rather than `run.py`:

```bash
gunicorn -w 4 -b 0.0.0.0:5000 wsgi:app
```

```bash
waitress-serve --port=5000 wsgi:app
```

`run.py` passes `threaded=True` for local use, which matters more than it looks: a
class-photo upload occupies a worker for several seconds of dlib work, and on the
default single-threaded server every dashboard poll behind it would block.

---

## Installing dlib (the hard part on Windows)

`face-recognition` depends on `dlib`, which is C++ and has no official Windows
wheels. You have three options, in descending order of how much of your afternoon
they cost.

**1. A prebuilt wheel.** Fastest by far. Find a `dlib` wheel built for your exact
Python version and architecture (`cp311`/`cp312`, `win_amd64`) — the community
publishes these — then:

```bash
pip install path\to\dlib-19.24.x-cp312-cp312-win_amd64.whl
```

Check `python -V` first; a `cp311` wheel will not install on 3.12.

**2. Build it.** Install *Visual Studio Build Tools* with the **"Desktop development
with C++"** workload (this brings MSVC and the Windows SDK), then:

```bash
pip install cmake
```

```bash
pip install dlib
```

Expect five to fifteen minutes of compilation and a lot of warnings. Warnings are
fine; errors mentioning `cl.exe` or `CMAKE_CXX_COMPILER` mean the workload is
missing.

**3. Conda.** `conda install -c conda-forge dlib` sidesteps the toolchain entirely
if you already work in conda.

On macOS: `brew install cmake` then `pip install dlib`. On Debian/Ubuntu:
`sudo apt install build-essential cmake python3-dev`.

Once dlib is in, re-run `pip install -r requirements.txt` to pick up the rest.

**Then, if `import face_recognition` still fails.** This one is not a dlib problem at
all, and the error is misleading:

```
ModuleNotFoundError: No module named 'pkg_resources'
```

raised from inside `face_recognition_models/__init__.py`. That package imports
`pkg_resources`, which **setuptools removed in version 81**. Since pip installs the
newest setuptools into a fresh venv, a correctly-built dlib will still fail to import
today. The fix:

```bash
pip install "setuptools<81"
```

Verify with `python -c "import face_recognition; print('ok')"` — a deprecation warning
about `pkg_resources` is expected and harmless.

**Two pins worth knowing about.** `numpy` is held below 2.0 because librosa, numba
and chromadb are not all ready for it — if you upgrade numpy you will get import
errors far from the actual cause. And `torch` is deliberately *unpinned* so pip
resolves a wheel matching your platform and CPU/GPU instead of fighting a version we
guessed.

Verify the pipelines independently of Flask and Mongo:

```bash
python scripts/test_pipelines.py --help
```

Point it at a folder of sample faces and voice clips and it exercises the real dlib
and Resemblyzer code paths against an in-memory index. It exits non-zero on failure,
so it doubles as a smoke test after changing a threshold.

### Running the tests

```bash
cd backend
python -m pytest
```

The suite in `backend/tests/` is **hermetic**: it opens no socket, so it needs no
MongoDB, no ChromaDB and none of the heavy native wheels. That is possible because
every expensive import in the app is lazy — `face_recognition`, `cv2`, `resemblyzer`,
`librosa` and `chromadb` are imported inside the functions that use them — and because
`create_app` skips index creation when `SKIP_INDEXES` is set. `tests/conftest.py`
builds every app with `TESTING=True, SKIP_INDEXES=True, MONGODB_URI=""` and installs
an autouse fixture that turns an accidental database call into an immediate failure
rather than an eight-second Atlas timeout.

So it runs on a fresh checkout before dlib has ever been built. What it covers:

| File | Covers |
| --- | --- |
| `test_app_factory.py` | blueprint registration, every route living under `/api/`, `/` and `/healthz`, the upload cap, headers-only JWT |
| `test_errors.py` | the single error envelope, status→code mapping, and that a 500 does not leak the exception message in production |
| `test_auth_guards.py` | 401 shapes, disabled accounts refused on every request, role gates reading the document not the token, and cross-tenant reads returning **404 not 403** |
| `test_validators.py` | every `clean_*`, byte-counted passwords, the mandatory override reason, slugs |
| `test_csv_import.py` | bulk import: headers, BOMs, encodings, duplicates, partial success |
| `test_serialization.py` | BSON→JSON, and that `password_hash` / `token_hash` / `crop_jpeg_b64` are dropped flat, nested, and inside lists |
| `test_tokens.py` | invite / reset / QR tokens, expiry, and cross-salt replay |
| `test_timeutil.py` | UTC handling, so a naive datetime can never reach a comparison |
| `test_constants.py` | the domain enums — including a check that `frontend/src/lib/constants.js` mirrors them exactly, and that every `ErrorCode` the UI branches on is one the backend can actually raise |

What it deliberately does **not** cover: the recognition pipelines (that is
`scripts/test_pipelines.py`, which needs the native stack and real samples) and any
route whose body performs a database write. Those need a real MongoDB and belong in a
separate integration suite.

> **Verified:** `python -m pytest` reports **291 passed** in about 2 seconds
> (Python 3.12, pytest 8.3.2). Two tests in `test_tokens.py` were flaky on first
> execution — they slept 1.1 s and asked for `max_age=1`, but `itsdangerous` embeds
> whole seconds and raises only on `age > max_age`, so the computed age was 1 *or* 2
> depending purely on where in the second the token happened to be signed. Both now
> use `max_age=-1`, which is overdue for any signing time, needs no sleep, and covers
> the same branch.

---

## Frontend setup

```bash
cd frontend
npm install
```

```bash
npm run dev
```

That serves `http://localhost:5173`.

**Port 5173 is not a preference.** It is the value of `FRONTEND_URL` in
`backend/.env`, and the backend bakes that origin into every invite email, every
password-reset link and every QR code it generates. Serving the UI on a different
port means those links point somewhere that is not running. `vite.config.js` sets
`strictPort: true` so Vite fails loudly rather than quietly sliding to 5174 and
breaking every emailed link.

The dev server proxies `/api` and `/healthz` to `http://127.0.0.1:5000`, which makes
local development same-origin: no CORS, no preflights, no `VITE_API_URL` to set.

For a deployed build you *do* need to point the bundle at the API:

```bash
cp .env.example .env.local     # then set VITE_API_URL=https://api.example.com
npm run build
```

and add that frontend origin to `CORS_ORIGINS` in the backend `.env` — otherwise the
browser will refuse the responses. `npm run preview` serves the built bundle on 5173
to check it before shipping.

Only `VITE_`-prefixed variables reach the browser. Nothing sensitive belongs in any
of them; the bundle is public.

> **Verified:** `npm install` and `npm run build` both succeed (Node 24.20.0, Vite
> 5.4.21) — 169 modules transformed, `dist/assets/index-*.js` 533.22 kB (162.96 kB
> gzipped) and `dist/assets/index-*.css` 31.42 kB (6.69 kB gzipped), built in 3.95 s.
> The one warning is Vite's advisory that a chunk exceeds 500 kB, which is expected for
> a single-bundle SPA of this size and is not an error.

---

## Your first ten minutes

Both servers running, then:

1. **Register an institution** at `http://localhost:5173/register`. This is the only
   self-service signup in the product; it creates the tenant and makes you its admin.
   Everyone else arrives by invitation.
2. **Invite a teacher** from *People*. With SMTP off, copy the invite link the screen
   shows you and open it in a private window — that is the `/accept-invite` flow.
3. **Create a subject** and set its attendance threshold (or leave it inheriting the
   institution default of 75%).
4. **Add students.** *Students → Import* takes a CSV of `name,email`; download the
   template from that screen. Run it with **dry-run first** — it reports exactly which
   rows would be created, matched or rejected without writing anything. Import
   straight into a subject's roster to skip a step.
5. **Enroll biometrics as a student.** Open a student's invite link, set a password,
   and the wizard takes 2–5 face frames and a voice passphrase recording. This is the
   part that needs a real webcam and microphone.
6. **Start a session** on the subject, choose a verification mode, and try it:
   - *Class photo* — upload a group shot and watch the roster fill in, with anything
     ambiguous landing in the review queue.
   - *QR* — project the code and scan it with a phone; it rotates every 30 seconds.
   - *Voice* — have a student record the passphrase from their portal.
7. **End the session** and export the CSV. Then look at *Reports* for the defaulter
   list and the trend chart.

Short on time or without a webcam? Seed four weeks of plausible history instead:

```bash
python scripts/seed_demo_data.py
```

It fills three subjects with realistic attendance so the dashboards, the trend chart
and the defaulter list have something to render. It deliberately does **not**
fabricate biometrics — writing `face_enrolled: true` with no matching vector in
Chroma would produce a database that lies, promising matches the photo pipeline
cannot deliver. Seeded students are left un-enrolled; enroll one or two by hand to
exercise that path. `--reset` wipes and recreates, matching only the demo
institution's slug, so other tenants in the same database are untouched.

---

## Scheduled jobs

Two plain scripts, driven by the operating system's scheduler. There is no broker and
no worker pool, because nothing here needs one.

**Low-attendance alerts** — one email per flagged student per cooldown window:

```bash
python scripts/send_low_attendance_alerts.py --dry-run
```

Always run `--dry-run` first: it performs the entire calculation and prints who
*would* be emailed without sending anything or writing the cooldown log. The
threshold, the cooldown (default 7 days) and the minimum session count before a
student can be flagged are institution settings, editable from *Admin → Settings*.

Daily at 07:00 via cron:

```
0 7 * * * cd /srv/snapattend/backend && /srv/snapattend/venv/bin/python scripts/send_low_attendance_alerts.py >> /var/log/snapattend-alerts.log 2>&1
```

On Windows, Task Scheduler → Basic Task → *Start a program*, with the program set to
your venv's `python.exe`, arguments `scripts\send_low_attendance_alerts.py`, and
"Start in" set to the `backend` directory.

**Face-crop retention backstop:**

```bash
python scripts/cleanup_face_crops.py --report
```

Review-queue crops carry an `expires_at` and the collection has a TTL index, so
MongoDB already deletes them about once a minute, and ending a session deletes that
session's crops immediately. This script exists for the deployment where the TTL
index failed to create — `/healthz` will say so — and for the operator who wants to
prove the retention rule is holding right now. `--report` prints the numbers and
deletes nothing.

---

## Privacy and retention

The design commitment is that **no raw biometric file is ever persisted**:

- **Class photos** are never written to disk. The uploaded bytes are decoded in
  memory, faces are detected and encoded, and the image is discarded when the request
  ends.
- **Enrollment frames and voice clips** are discarded the moment their embedding is
  computed. What remains is a 128-dimensional face vector or a 256-dimensional
  speaker vector — neither of which reconstructs the original.
- **Review-queue crops** are the one exception, and are deliberately narrow: a small
  crop of a single unmatched face, stored so a teacher can see who they are
  identifying. It is deleted when the queue item is resolved, when the session ends,
  or 24 hours after upload, whichever comes first.
- **Voice audio** is converted to 16 kHz mono WAV *in the browser* and never stored
  server-side.

`GET /api/admin/privacy` returns the live counts behind those claims plus the
guarantees as text, and *Admin → Privacy* renders it. That endpoint exists so the
promise is auditable rather than merely documented.

Every consequential action — an override, a role change, a biometric reset, a
disabled account — is written to an append-only audit log with the actor, the target
and the reason. **Overrides require a reason**; the API rejects a blank one, because
an override with no explanation is indistinguishable from a mistake six weeks later.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `pip install` dies on dlib | no C++ toolchain | [see above](#installing-dlib-the-hard-part-on-windows) |
| `ImportError` from numba/librosa | numpy 2.x got installed | `pip install "numpy<2"` and reinstall librosa |
| `/healthz` says mongodb not ok | `MONGODB_URI` wrong, or Atlas IP allowlist | add your IP in Atlas → Network Access |
| `pymongo` cannot resolve `mongodb+srv://` | `dnspython` missing | it is in `requirements.txt`; reinstall |
| Invite email never arrives | SMTP unconfigured (by design) | the API returns the link — the UI shows it. For Gmail use an app password, not your login password |
| Invite link 404s in the browser | frontend not on 5173, or `FRONTEND_URL` differs | align `FRONTEND_URL` with where the UI actually runs |
| Camera or microphone blocked | `getUserMedia` requires a secure origin | use `localhost` (which counts as secure) or real HTTPS — a phone hitting the dev server by LAN IP will fail |
| Voice check-in rejected as too short | under 1.5 s of *voiced* audio | say the whole passphrase; the UI warns before uploading |
| Class photo finds no faces | too small, too dark, or faces under 48 px | move closer, or raise `FACE_DETECTION_UPSAMPLE`; `cnn` detection is better on angled faces but needs a GPU |
| Everyone lands in the review queue | thresholds too tight for your enrollment data | loosen `FACE_MATCH_THRESHOLD` toward `FACE_REVIEW_CEILING` and re-test with `scripts/test_pipelines.py` |
| A student matches as someone else | ambiguous faces with too-loose margins | raise `FACE_AMBIGUITY_MARGIN`; re-enroll with better-lit frames |
| 429 responses while testing | rate limits are real (login 10/min, photo 30/hr, voice 10/min, enrollment 20/hr) | wait it out; the response says how long |
| CORS error in the browser console | deployed build talking cross-origin | add the frontend origin to `CORS_ORIGINS` |
| Vite starts on 5174 | port 5173 already in use | free it — `strictPort` should prevent this, and a different port breaks emailed links |

---

## Project layout

```
backend/
  app/
    __init__.py       create_app() factory, /healthz, /
    config.py         every env var, with defaults
    auth/             JWT callbacks, role guards, tenant isolation
    models/           collection accessors, constants (the enums)
    pipelines/        face.py, voice.py, qr.py — the biometric work
    routes/           9 blueprints, one per URL prefix
    services/         mailer, invites, alerts, attendance, face_crop_store
    utils/            error envelope, validation, csv
  scripts/            seed, cron jobs, standalone pipeline test
  tests/              10 files, hermetic — no Mongo, no Chroma, no dlib
  pytest.ini          testpaths, --strict-markers
  run.py              dev server
  wsgi.py             gunicorn / waitress entry point
frontend/
  src/
    lib/              api client, constants, formatters, camera, audio
    context/          auth, toasts
    hooks/            data loading, polling, countdown
    components/       ui primitives, layout, charts, domain widgets
    pages/            one file per route
    styles/index.css  the whole design system
docs/
  frontend-architecture.md   the frontend contract
  api-reference.md           every endpoint, with parameters
```

---

## Further reading

- **[docs/project-explained.md](docs/project-explained.md)** — the whole project in
  detail: how each pipeline actually works, why every threshold is the number it is,
  the full data model, and an honest list of what has and has not been verified.
  Start here if you want to understand the system rather than call it.
- **[docs/api-reference.md](docs/api-reference.md)** — every endpoint, its
  parameters, its roles and its response shape.
- **[docs/frontend-architecture.md](docs/frontend-architecture.md)** — design tokens,
  class names, component props, the route table, and the twelve API semantics the UI
  has to get right.
- **`backend/.env.example`** — the authoritative list of configuration, with the
  reasoning behind each threshold.
