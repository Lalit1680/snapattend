"""ChromaDB vector store — the *only* place biometric vectors live.

Design notes
------------
* **Embedded persistent mode.** ``chromadb.PersistentClient`` writes to
  ``CHROMA_PERSIST_DIR``; there is no separate server process to run.
* **Two collections**, ``face_embeddings`` and ``voice_embeddings``, both using
  cosine distance. Every entry carries ``student_id`` + ``institution_id``
  metadata so queries can be scoped to a class roster rather than searched
  across the whole deployment.
* **One vector per student per modality.** The student's Mongo ``_id`` (as a
  string) is used directly as the Chroma document ID, so enrollment is a plain
  ``upsert`` and re-enrollment overwrites rather than accumulating duplicates.
* **Vectors are L2-normalised before storage and before querying.** Chroma's
  cosine distance is ``1 - cos(a, b)``. Once both vectors are unit-length the
  relationship to Euclidean distance is exact::

      euclidean^2 = 2 * cosine_distance

  which is what lets us translate the well-known dlib tolerance (Euclidean
  0.6) into the cosine thresholds in ``config.py``. Keeping normalisation in
  one place means the thresholds mean the same thing everywhere.

Nothing else in the codebase should import ``chromadb`` directly.
"""
from __future__ import annotations

import logging
import math
import threading
from dataclasses import dataclass
from typing import Iterable, Optional, Sequence

from .config import Config

log = logging.getLogger(__name__)

FACE_COLLECTION = "face_embeddings"
VOICE_COLLECTION = "voice_embeddings"

_client = None
_client_lock = threading.Lock()


# --------------------------------------------------------------------------- #
# Results
# --------------------------------------------------------------------------- #
@dataclass(frozen=True)
class VectorMatch:
    """A single nearest-neighbour hit."""

    student_id: str
    institution_id: str
    distance: float

    @property
    def euclidean(self) -> float:
        """Equivalent Euclidean distance between the unit-normalised vectors.

        Handy for sanity-checking face thresholds against dlib's documented
        0.6 tolerance without having to think in cosine space.
        """
        return math.sqrt(max(0.0, 2.0 * self.distance))

    @property
    def confidence(self) -> float:
        """Distance mapped to a 0..1 score for display purposes only.

        This is *not* a calibrated probability — it exists so the UI can show
        "94%" instead of "0.06 cosine distance". Accept/reject decisions are
        always made on ``distance`` against an explicit threshold.
        """
        return round(max(0.0, min(1.0, 1.0 - self.distance)), 4)


# --------------------------------------------------------------------------- #
# Vector helpers
# --------------------------------------------------------------------------- #
def l2_normalize(vector: Sequence[float]) -> list[float]:
    """Return ``vector`` scaled to unit length.

    A zero vector is returned unchanged (rather than producing NaNs); callers
    validate embedding quality upstream, this is just a safety net.
    """
    norm = math.sqrt(sum(float(v) * float(v) for v in vector))
    if norm == 0.0 or not math.isfinite(norm):
        log.warning("Refusing to normalise a zero/non-finite vector")
        return [float(v) for v in vector]
    return [float(v) / norm for v in vector]


def _build_where(institution_id: str, student_ids: Optional[Iterable[str]]) -> dict:
    """Compose a Chroma metadata filter.

    Chroma accepts a bare ``{"key": value}`` for a single condition but wants an
    explicit ``$and`` for several; building it that way keeps us compatible
    across Chroma releases instead of relying on implicit AND behaviour.
    """
    clauses: list[dict] = [{"institution_id": str(institution_id)}]
    if student_ids is not None:
        ids = sorted({str(s) for s in student_ids})
        if not ids:
            # Empty roster: return a filter that provably matches nothing so we
            # never accidentally widen the search to the whole institution.
            return {"student_id": {"$in": ["__none__"]}}
        clauses.append({"student_id": {"$in": ids}})
    if len(clauses) == 1:
        return clauses[0]
    return {"$and": clauses}


# --------------------------------------------------------------------------- #
# Client / collection access
# --------------------------------------------------------------------------- #
def _get_client():
    """Return the process-wide Chroma client, creating it on first use.

    Guarded by a lock because the first call creates/migrates the on-disk store
    and two threads racing into that is asking for trouble.
    """
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                import chromadb  # imported lazily: ~1s import cost
                from chromadb.config import Settings

                persist_dir = Config.CHROMA_PERSIST_DIR
                log.info("Opening ChromaDB persistent store at %s", persist_dir)
                _client = chromadb.PersistentClient(
                    path=persist_dir,
                    settings=Settings(anonymized_telemetry=False, allow_reset=True),
                )
    return _client


def _get_collection(name: str):
    """Get/create a cosine-distance collection.

    ``embedding_function=None`` is deliberate: we always supply pre-computed
    vectors, and leaving the default in place would make Chroma lazily download
    its bundled ONNX sentence-transformer model on first use — a pointless
    ~80MB download for a store that never embeds text.
    """
    return _get_client().get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},
        embedding_function=None,
    )


def face_collection():
    return _get_collection(FACE_COLLECTION)


def voice_collection():
    return _get_collection(VOICE_COLLECTION)


# --------------------------------------------------------------------------- #
# Writes
# --------------------------------------------------------------------------- #
def _upsert(collection, student_id: str, institution_id: str, embedding: Sequence[float]) -> None:
    collection.upsert(
        ids=[str(student_id)],
        embeddings=[l2_normalize(embedding)],
        metadatas=[{"student_id": str(student_id), "institution_id": str(institution_id)}],
    )


def upsert_face_embedding(student_id: str, institution_id: str, embedding: Sequence[float]) -> None:
    _upsert(face_collection(), student_id, institution_id, embedding)
    log.info("Upserted face embedding for student %s", student_id)


def upsert_voice_embedding(student_id: str, institution_id: str, embedding: Sequence[float]) -> None:
    _upsert(voice_collection(), student_id, institution_id, embedding)
    log.info("Upserted voice embedding for student %s", student_id)


def delete_student_embeddings(student_id: str, *, face: bool = True, voice: bool = True) -> None:
    """Remove a student's vectors. Used on re-enrollment resets and offboarding."""
    sid = str(student_id)
    if face:
        try:
            face_collection().delete(ids=[sid])
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("Failed deleting face vector for %s: %s", sid, exc)
    if voice:
        try:
            voice_collection().delete(ids=[sid])
        except Exception as exc:  # pragma: no cover - defensive
            log.warning("Failed deleting voice vector for %s: %s", sid, exc)


# --------------------------------------------------------------------------- #
# Queries
# --------------------------------------------------------------------------- #
def _query(
    collection,
    embedding: Sequence[float],
    institution_id: str,
    student_ids: Optional[Iterable[str]],
    n_results: int,
) -> list[VectorMatch]:
    total = collection.count()
    if total == 0:
        return []

    result = collection.query(
        query_embeddings=[l2_normalize(embedding)],
        n_results=max(1, min(n_results, total)),
        where=_build_where(institution_id, student_ids),
        include=["metadatas", "distances"],
    )

    # Chroma returns one list per query embedding; we always send exactly one.
    ids = (result.get("ids") or [[]])[0]
    distances = (result.get("distances") or [[]])[0]
    metadatas = (result.get("metadatas") or [[]])[0]

    matches: list[VectorMatch] = []
    for idx, doc_id in enumerate(ids):
        meta = metadatas[idx] if idx < len(metadatas) and metadatas[idx] else {}
        matches.append(
            VectorMatch(
                student_id=str(meta.get("student_id") or doc_id),
                institution_id=str(meta.get("institution_id") or institution_id),
                distance=float(distances[idx]) if idx < len(distances) else 2.0,
            )
        )
    matches.sort(key=lambda m: m.distance)
    return matches


def query_face(
    embedding: Sequence[float],
    institution_id: str,
    student_ids: Optional[Iterable[str]] = None,
    n_results: int = 3,
) -> list[VectorMatch]:
    """Nearest face vectors, scoped to ``student_ids`` (a class roster).

    Returning the top-N rather than just the best hit lets the caller reason
    about *ambiguity*: if the two closest students are nearly equidistant, the
    match is unsafe to auto-accept even when the best distance looks good.
    """
    return _query(face_collection(), embedding, institution_id, student_ids, n_results)


def query_voice(
    embedding: Sequence[float],
    institution_id: str,
    student_ids: Optional[Iterable[str]] = None,
    n_results: int = 3,
) -> list[VectorMatch]:
    return _query(voice_collection(), embedding, institution_id, student_ids, n_results)


# --------------------------------------------------------------------------- #
# Introspection / maintenance
# --------------------------------------------------------------------------- #
def has_embedding(collection_name: str, student_id: str) -> bool:
    try:
        got = _get_collection(collection_name).get(ids=[str(student_id)], include=[])
        return bool((got or {}).get("ids"))
    except Exception as exc:  # pragma: no cover - defensive
        log.warning("has_embedding(%s, %s) failed: %s", collection_name, student_id, exc)
        return False


def stats() -> dict:
    """Collection sizes — surfaced on the admin dashboard and /healthz."""
    try:
        return {
            FACE_COLLECTION: face_collection().count(),
            VOICE_COLLECTION: voice_collection().count(),
            "persist_dir": Config.CHROMA_PERSIST_DIR,
        }
    except Exception as exc:  # pragma: no cover - defensive
        return {"error": str(exc), "persist_dir": Config.CHROMA_PERSIST_DIR}


def reset() -> None:
    """Drop both collections. Test-support only — never called from routes."""
    client = _get_client()
    for name in (FACE_COLLECTION, VOICE_COLLECTION):
        try:
            client.delete_collection(name)
        except Exception:
            pass
