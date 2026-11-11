"""The factory, the two meta routes, and the framework-level error envelope.

What is worth pinning here is not that Flask works but that the *contracts the
frontend was written against* hold: every route lives under ``/api`` (the Vite
proxy forwards only that prefix), the JWT never travels in a cookie, and a 404
or a 405 comes back in the same envelope as a deliberate ``ApiError``.
"""
from __future__ import annotations

from app import __version__
from app.routes import BLUEPRINTS

#: Endpoints that are app-level rather than blueprint-owned, so exempt from the
#: "/api prefix" rule below.
META_ENDPOINTS = {"index", "healthz", "static"}


def test_version_matches_the_documented_release():
    assert __version__ == "1.0.0"


def test_factory_boots_with_no_database_and_no_native_deps(app):
    # The gate at app/__init__.py:122 is what makes this suite possible; if it
    # ever stops honouring SKIP_INDEXES, every test here starts dialling Atlas.
    assert app.config["TESTING"] is True
    assert app.config["SKIP_INDEXES"] is True
    assert app.config["_MISSING_SETTINGS"] is not None


def test_every_blueprint_is_registered(app):
    assert set(app.blueprints) == {bp.name for bp in BLUEPRINTS}
    assert len(BLUEPRINTS) == 9


def test_all_blueprint_routes_live_under_api(app):
    """`vite.config.js` proxies `/api` and `/healthz` and nothing else."""
    stray = [
        rule.rule
        for rule in app.url_map.iter_rules()
        if rule.endpoint not in META_ENDPOINTS and not rule.rule.startswith("/api/")
    ]
    assert stray == []


def test_index_names_the_service_and_points_at_health(client):
    body = client.get("/").get_json()
    assert body["name"] == "SnapAttend API"
    assert body["version"] == __version__
    assert body["health"] == "/healthz"


def test_upload_cap_agrees_with_the_megabyte_figure_the_ui_quotes(app):
    # The frontend tells students "photos up to N MB"; it reads N, Flask enforces
    # bytes. Asserting the relation rather than 16 keeps a tuned .env passing.
    assert app.config["MAX_CONTENT_LENGTH"] == app.config["MAX_UPLOAD_MB"] * 1024 * 1024


def test_jwt_travels_in_headers_only(app):
    # No cookie means no CSRF surface, which is why CORS is configured with
    # supports_credentials=False. The two settings have to stay consistent.
    assert app.config["JWT_TOKEN_LOCATION"] == ["headers"]


def test_unknown_api_path_returns_the_standard_envelope(client):
    response = client.get("/api/does-not-exist")
    assert response.status_code == 404
    error = response.get_json()["error"]
    assert set(error) == {"code", "message", "details"}
    assert error["code"] == "not_found"


def test_wrong_method_returns_the_standard_envelope(client):
    response = client.post("/healthz")
    assert response.status_code == 405
    # 405 is absent from `_default_code`'s map, so it falls through to "error".
    # The frontend only needs *a* code; this records which one it gets.
    assert response.get_json()["error"]["code"] == "error"


def _stub_dependencies(monkeypatch, *, mongo_ok: bool):
    """Answer for the three things /healthz probes, without any of them.

    Patched on the modules the closure in ``_register_meta_routes`` looks them up
    on, so the attribute lookup at call time finds these.
    """
    from app import db, vector_store
    from app.services import face_crop_store

    monkeypatch.setattr(db, "ping", lambda: mongo_ok)
    monkeypatch.setattr(
        vector_store, "stats", lambda: {"faces": 0, "voices": 0, "persist_dir": "/tmp"}
    )
    monkeypatch.setattr(face_crop_store, "privacy_report", lambda: {"crops_retained": 0})


def test_healthz_is_a_real_readiness_probe(client, monkeypatch):
    """503 when a dependency is down — the point of not always saying OK."""
    _stub_dependencies(monkeypatch, mongo_ok=False)

    response = client.get("/healthz")
    assert response.status_code == 503
    body = response.get_json()
    assert body["status"] == "degraded"
    assert body["checks"]["mongodb"]["ok"] is False
    assert isinstance(body["missing_settings"], list)


def test_healthz_reports_ok_when_everything_answers(client, monkeypatch):
    _stub_dependencies(monkeypatch, mongo_ok=True)

    response = client.get("/healthz")
    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "ok"
    assert body["version"] == __version__
    # Every probe reports itself; the frontend's health panel renders them all.
    assert set(body["checks"]) == {"mongodb", "chroma", "mail", "face_crops"}


def test_healthz_survives_a_dependency_that_raises(client, monkeypatch):
    """A broken probe must degrade the report, not 500 the probe itself."""
    from app import db

    def _explode():
        raise RuntimeError("MONGODB_URI is not set")

    _stub_dependencies(monkeypatch, mongo_ok=True)
    monkeypatch.setattr(db, "ping", _explode)

    response = client.get("/healthz")
    assert response.status_code == 503
    mongodb = response.get_json()["checks"]["mongodb"]
    assert mongodb["ok"] is False
    assert "MONGODB_URI" in mongodb["error"]
