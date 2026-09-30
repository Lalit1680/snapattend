"""Unit tests for the SnapAttend matching logic.

Scope, on purpose: these tests cover ``src/pipelines/face_pipeline.py`` and
``src/pipelines/voice_pipeline.py`` only — the two modules whose core job
(deciding "is this the same person") is pure numpy/sklearn logic once you
hand them embeddings. They do not touch Streamlit UI code, Supabase, or the
screens; that code is thin enough to be reviewed by hand, and testing it
would mean testing Streamlit itself.

Every test that needs data from the database monkeypatches the specific
``get_all_students`` (or similar) function that the pipeline module already
imported — never the real Supabase-backed implementation in
``src/database/db.py``, which is left completely unchanged.

Run from the project root:

    pip install -r requirements.txt pytest
    pytest

(``conftest.py`` in this folder makes the run hermetic: if dlib/streamlit/
Supabase aren't installed or configured, lightweight stand-ins are used
instead — see that file for exactly what is faked and why.)
"""
from __future__ import annotations

import numpy as np
import pytest

from src.pipelines import face_pipeline, voice_pipeline


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #
def _student(student_id, embedding):
    """Shape a fake row the way src/database/db.get_all_students() returns it."""
    return {"student_id": student_id, "name": f"Student {student_id}", "face_embedding": embedding}


@pytest.fixture(autouse=True)
def _clear_streamlit_cache():
    """get_trained_model()/load_dlib_models() are @st.cache_resource'd. The
    fake cache_resource in conftest.py is a no-op decorator, so nothing is
    actually memoised between tests — this fixture just documents that and
    gives future tests a place to add real cache-clearing if the fakes ever
    get smarter."""
    yield


# --------------------------------------------------------------------------- #
# face_pipeline.get_trained_model()
# --------------------------------------------------------------------------- #
class TestGetTrainedModel:
    def test_returns_none_when_no_students_enrolled(self, monkeypatch):
        monkeypatch.setattr(face_pipeline, "get_all_students", lambda: [])
        assert face_pipeline.get_trained_model() is None

    def test_returns_falsy_when_no_student_has_an_embedding(self, monkeypatch):
        students = [_student(1, None), _student(2, None)]
        monkeypatch.setattr(face_pipeline, "get_all_students", lambda: students)
        # Current behaviour: 0 rather than None when nobody has an embedding.
        # Documented here so a future refactor that changes this is a
        # deliberate decision, not an accidental regression.
        assert not face_pipeline.get_trained_model()

    def test_trains_on_enrolled_students_with_embeddings(self, monkeypatch):
        students = [
            _student(1, [0.0, 0.0, 0.0, 0.0]),
            _student(2, [5.0, 5.0, 5.0, 5.0]),
        ]
        monkeypatch.setattr(face_pipeline, "get_all_students", lambda: students)
        model_data = face_pipeline.get_trained_model()
        assert model_data is not None
        assert sorted(model_data["y"]) == [1, 2]
        assert len(model_data["X"]) == 2


# --------------------------------------------------------------------------- #
# face_pipeline.predict_attendance()
#
# get_face_embeddings() is monkeypatched directly in every test below — it's
# the one function that would otherwise need a real dlib detector, and
# swapping it out is exactly the seam the module already provides.
# --------------------------------------------------------------------------- #
class TestPredictAttendance:
    def test_no_faces_in_photo_returns_empty_result(self, monkeypatch):
        monkeypatch.setattr(face_pipeline, "get_face_embeddings", lambda img: [])
        monkeypatch.setattr(face_pipeline, "get_all_students", lambda: [_student(1, [0, 0])])
        detected, all_students, num_faces = face_pipeline.predict_attendance(np.zeros((10, 10, 3)))
        assert detected == {}
        assert num_faces == 0

    def test_marks_present_when_encoding_matches_enrolled_student(self, monkeypatch):
        known_embedding = [0.1, 0.2, 0.3, 0.4]
        students = [
            _student(1, known_embedding),
            _student(2, [9.0, 9.0, 9.0, 9.0]),
        ]
        monkeypatch.setattr(face_pipeline, "get_all_students", lambda: students)
        # Simulate the camera capturing exactly student 1's stored embedding.
        monkeypatch.setattr(
            face_pipeline, "get_face_embeddings", lambda img: [np.array(known_embedding)]
        )
        detected, all_students, num_faces = face_pipeline.predict_attendance(np.zeros((10, 10, 3)))
        assert num_faces == 1
        assert detected.get(1) is True

    def test_does_not_mark_present_when_encoding_is_far_from_everyone(self, monkeypatch):
        students = [
            _student(1, [0.0, 0.0, 0.0, 0.0]),
            _student(2, [1.0, 1.0, 1.0, 1.0]),
        ]
        monkeypatch.setattr(face_pipeline, "get_all_students", lambda: students)
        # A face nowhere near either enrolled student.
        far_encoding = np.array([50.0, 50.0, 50.0, 50.0])
        monkeypatch.setattr(face_pipeline, "get_face_embeddings", lambda img: [far_encoding])
        detected, all_students, num_faces = face_pipeline.predict_attendance(np.zeros((10, 10, 3)))
        # This is the behaviour worth knowing cold for an interview: even
        # though the SVM must output *some* label for a 2-class problem, the
        # Euclidean-distance check against that label's own stored embedding
        # (resemblance_threshold = 0.6) is what actually gates presence, so a
        # bad match is rejected rather than silently marked.
        assert detected == {}


# --------------------------------------------------------------------------- #
# voice_pipeline.identify_speaker() — pure numpy, no mocking needed beyond
# the module-level fakes conftest.py installs so the import succeeds.
# --------------------------------------------------------------------------- #
class TestIdentifySpeaker:
    def _unit(self, vec):
        arr = np.array(vec, dtype=float)
        return (arr / np.linalg.norm(arr)).tolist()

    def test_matches_the_closest_candidate_above_threshold(self):
        target = self._unit([1.0, 0.0, 0.0])
        candidates = {
            "sid-close": self._unit([0.98, 0.02, 0.0]),
            "sid-far": self._unit([0.0, 1.0, 0.0]),
        }
        sid, score = voice_pipeline.identify_speaker(target, candidates, threshold=0.65)
        assert sid == "sid-close"
        assert score >= 0.65

    def test_returns_none_when_best_score_is_below_threshold(self):
        target = self._unit([1.0, 0.0, 0.0])
        candidates = {"sid-a": self._unit([0.0, 1.0, 0.0])}
        sid, score = voice_pipeline.identify_speaker(target, candidates, threshold=0.65)
        assert sid is None
        assert score < 0.65

    def test_handles_no_candidates(self):
        sid, score = voice_pipeline.identify_speaker([1.0, 0.0, 0.0], {}, threshold=0.65)
        assert sid is None
        assert score == 0.0

    def test_handles_none_embedding(self):
        sid, score = voice_pipeline.identify_speaker(None, {"a": [1.0]}, threshold=0.65)
        assert sid is None
        assert score == 0.0
