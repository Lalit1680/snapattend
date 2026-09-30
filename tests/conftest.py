"""Pytest bootstrap: makes the SnapAttend test suite hermetic.

SnapAttend imports several heavy or networked things at *module import time*
(not lazily), which is fine for the app itself but means importing
``src.pipelines.face_pipeline`` or ``src.database.db`` in a test would
otherwise require:

- a working, compiled ``dlib`` (slow/awkward to build in CI containers),
- ``face_recognition_models`` (a large model-data package),
- ``streamlit`` running with real ``st.secrets``,
- a live Supabase project + network access, and
- ``resemblyzer``/``librosa`` (which pull in ``torch``).

None of that should be a precondition for testing the *matching logic* in
``src/pipelines/*.py`` — the functions worth unit-testing are pure once you
hand them numpy arrays. So before any test module imports application code,
this file installs lightweight fake modules into ``sys.modules`` for exactly
the pieces above, but only for the ones that are missing:

- If the real package is already installed (e.g. you *do* have dlib built
  locally), it is used as-is — nothing here shadows a real installation.
- If it's missing, a minimal stand-in is installed so `import` succeeds.
  The stand-ins are intentionally "dumb": they exist so app modules can be
  imported without crashing, not to simulate real face/voice recognition.
  Tests that need specific behaviour (e.g. "this encoding matches this
  student") replace the relevant function directly with
  ``monkeypatch.setattr`` rather than relying on the fakes' internals.

This file makes NO changes to any file under ``src/`` or to ``app.py``.
"""
from __future__ import annotations

import sys
import types

import numpy as np


def _install_fake_module(name: str, **attrs) -> types.ModuleType:
    """Register a fake module in sys.modules, unless the real one is already there."""
    if name in sys.modules:
        return sys.modules[name]
    try:
        # Prefer a real installation if one is importable.
        return __import__(name)
    except ImportError:
        pass
    mod = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(mod, key, value)
    sys.modules[name] = mod
    return mod


# --------------------------------------------------------------------------- #
# streamlit — cache_resource must behave as a plain decorator; st.secrets must
# look like a mapping so src/database/config.py can read it at import time.
# --------------------------------------------------------------------------- #
class _FakeCacheResource:
    def __call__(self, fn):
        return fn

    def clear(self):  # called by face_pipeline.train_classifier()
        pass


class _FakeSessionState(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc

    def __setattr__(self, key, value):
        self[key] = value


def _install_streamlit():
    if "streamlit" in sys.modules:
        return sys.modules["streamlit"]
    try:
        import streamlit  # noqa: F401  (use the real thing if it's installed)
        return sys.modules["streamlit"]
    except ImportError:
        pass

    st = types.ModuleType("streamlit")
    st.cache_resource = _FakeCacheResource()
    st.secrets = {"SUPABASE_URL": "http://example.invalid", "SUPABASE_KEY": "test-key"}
    st.session_state = _FakeSessionState()
    st.error = lambda *a, **k: None
    st.warning = lambda *a, **k: None
    st.info = lambda *a, **k: None
    sys.modules["streamlit"] = st
    return st


_install_streamlit()

# --------------------------------------------------------------------------- #
# dlib / face_recognition_models — only need to be *importable*; the tests
# monkeypatch get_face_embeddings() directly rather than exercising real
# detection, so these stand-ins never need to return anything meaningful.
# --------------------------------------------------------------------------- #
_install_fake_module(
    "dlib",
    get_frontal_face_detector=lambda: (lambda image, upsample=1: []),
    shape_predictor=lambda model_path: object(),
    face_recognition_model_v1=lambda model_path: object(),
)
_install_fake_module(
    "face_recognition_models",
    pose_predictor_model_location=lambda: "",
    face_recognition_model_location=lambda: "",
)

# --------------------------------------------------------------------------- #
# supabase — importing src/database/config.py calls create_client(...) at
# module level. The fake client deliberately raises if a test accidentally
# hits the network path instead of monkeypatching src.database.db directly.
# --------------------------------------------------------------------------- #
class _FakeSupabaseClient:
    def table(self, *_args, **_kwargs):
        raise RuntimeError(
            "A test called into Supabase instead of monkeypatching "
            "src.database.db — mock the db-layer function directly."
        )


_install_fake_module(
    "supabase",
    create_client=lambda url, key: _FakeSupabaseClient(),
    Client=_FakeSupabaseClient,
)

# --------------------------------------------------------------------------- #
# bcrypt — real hashing isn't needed to test the pipelines, just importable.
# --------------------------------------------------------------------------- #
_install_fake_module(
    "bcrypt",
    hashpw=lambda pwd, salt: pwd,
    gensalt=lambda: b"salt",
    checkpw=lambda pwd, hashed: pwd == hashed,
)

# --------------------------------------------------------------------------- #
# resemblyzer / librosa — voice_pipeline.py imports these at module level.
# identify_speaker() (the function this suite actually exercises in depth)
# never calls into either, so the fakes just need to exist.
# --------------------------------------------------------------------------- #
class _FakeVoiceEncoder:
    def embed_utterance(self, wav):
        return np.zeros(256, dtype=float)


_install_fake_module(
    "resemblyzer",
    VoiceEncoder=_FakeVoiceEncoder,
    preprocess_wav=lambda audio: audio,
)
_install_fake_module(
    "librosa",
    load=lambda *a, **k: (np.zeros(16000, dtype=float), 16000),
    effects=types.SimpleNamespace(split=lambda audio, top_db=30: [(0, len(audio))]),
)

# segno — used by the QR-share dialog, not by the pipelines, but harmless to
# stub for completeness in case future tests import that component.
_install_fake_module(
    "segno",
    make=lambda *a, **k: types.SimpleNamespace(save=lambda *a, **k: None),
)
