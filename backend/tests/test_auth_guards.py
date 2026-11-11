"""Route guards: authentication, role gates and tenant isolation.

The security model lives in ``app/auth/guards.py``, and two of its rules are the
kind that fail silently when they break:

* a **disabled account keeps a technically-valid token** until it expires, so the
  refusal has to happen at lookup time on every request;
* a cross-tenant document must come back **404, not 403** — a 403 confirms that
  another institution's record exists.

Both are asserted below. These stay hermetic by patching the single collection
accessor each test needs, which is the escape hatch ``conftest.forbid_mongo``
documents; no other test in the suite touches a document at all.
"""
from __future__ import annotations

from datetime import timedelta

import pytest
from bson import ObjectId
from flask import g, request
from flask_jwt_extended import create_access_token

from app import db
from app.auth.guards import (
    any_authenticated,
    as_object_ids,
    assert_can_manage_session,
    assert_can_manage_subject,
    assert_same_institution,
    current_role,
    current_user_optional,
    is_authenticated,
    optional_auth,
    role_required,
    scope,
)
from app.models.constants import Role, UserStatus
from app.utils.errors import ApiError

INSTITUTION = ObjectId("64f0a1b2c3d4e5f600000001")
OTHER_INSTITUTION = ObjectId("64f0a1b2c3d4e5f600000002")
USER_ID = ObjectId("64f0a1b2c3d4e5f6000000aa")
SUBJECT_ID = ObjectId("64f0a1b2c3d4e5f6000000bb")
STRANGER_ID = ObjectId("64f0a1b2c3d4e5f6000000cc")


def _user(role=Role.TEACHER, *, status=UserStatus.ACTIVE, institution_id=INSTITUTION):
    return {
        "_id": USER_ID,
        "name": "Ann Lee",
        "email": "ann@x.edu",
        "role": role,
        "status": status,
        "institution_id": institution_id,
    }


class _OneDocument:
    """The narrowest possible stand-in for a collection accessor."""

    def __init__(self, doc):
        self.doc = doc

    def find_one(self, *_args, **_kwargs):
        return self.doc


@pytest.fixture
def guarded_app(app):
    """An app with one route per guard, so each can be exercised over HTTP.

    Registered here rather than in ``app/`` because these exist only to be
    guarded — the real routes all do something as well, which would make a failure
    ambiguous between the guard and the work behind it.
    """

    @app.get("/api/_open")
    @optional_auth
    def _open():
        user = current_user_optional()
        return {"authenticated": is_authenticated(), "email": (user or {}).get("email")}

    @app.get("/api/_any")
    @any_authenticated
    def _any():
        return {
            "role": current_role(),
            "actor_id": str(g.actor_id),
            "institution_id": str(g.institution_id),
            "actor_role": g.actor_role,
        }

    @app.get("/api/_admin_only")
    @role_required(Role.ADMIN)
    def _admin_only():
        return {"ok": True}

    @app.get("/api/_scoped")
    @any_authenticated
    def _scoped():
        return {k: str(v) for k, v in scope({"status": "active"}).items()}

    @app.get("/api/_subject_tenant")
    @any_authenticated
    def _subject_tenant():
        docs = {
            "mine": {"_id": SUBJECT_ID, "institution_id": INSTITUTION},
            "theirs": {"_id": SUBJECT_ID, "institution_id": OTHER_INSTITUTION},
            "unscoped": {"_id": SUBJECT_ID},
            "missing": None,
        }
        assert_same_institution(docs[request.args["doc"]], what="subject")
        return {"ok": True}

    @app.get("/api/_manage_subject")
    @any_authenticated
    def _manage_subject():
        assigned = request.args.get("assigned") == "yes"
        assert_can_manage_subject(
            {
                "_id": SUBJECT_ID,
                "institution_id": INSTITUTION,
                "teacher_ids": [USER_ID] if assigned else [STRANGER_ID],
            }
        )
        return {"ok": True}

    @app.get("/api/_manage_session")
    @any_authenticated
    def _manage_session():
        owner = USER_ID if request.args.get("owner") == "me" else STRANGER_ID
        assert_can_manage_session(
            {
                "_id": ObjectId("64f0a1b2c3d4e5f6000000dd"),
                "institution_id": INSTITUTION,
                "subject_id": SUBJECT_ID,
                "teacher_id": owner,
            }
        )
        return {"ok": True}

    return app


@pytest.fixture
def sign_in(guarded_app, monkeypatch):
    """Return auth headers for a user document, patching only ``db.users``.

    Everything the guards read comes from this document rather than the token's
    claims — that is deliberate in ``guards.py`` so a role change or a disabled
    account takes effect on the next request instead of on the next login.
    """

    def _sign_in(**kwargs):
        doc = _user(**kwargs)
        monkeypatch.setattr(db, "users", lambda: _OneDocument(doc))
        with guarded_app.app_context():
            token = create_access_token(identity=doc)
        return {"Authorization": f"Bearer {token}"}

    return _sign_in


def _error(response):
    return response.get_json()["error"]


# --------------------------------------------------------------------------- #
# Rejections that never reach the database
# --------------------------------------------------------------------------- #
def test_no_token_is_a_401_in_our_envelope(guarded_app):
    response = guarded_app.test_client().get("/api/_any")

    assert response.status_code == 401
    error = _error(response)
    assert error["code"] == "unauthorized"
    assert error["message"] == "Authentication required"
    # The library's own explanation is passed through so a misconfigured client
    # gets something actionable instead of a bare 401.
    assert isinstance(error["details"]["reason"], str) and error["details"]["reason"]


def test_a_garbage_token_is_a_401_not_a_500(guarded_app):
    response = guarded_app.test_client().get(
        "/api/_any", headers={"Authorization": "Bearer not.a.real.token"}
    )

    assert response.status_code == 401
    assert _error(response)["message"] == "Invalid authentication token"


def test_an_expired_token_says_so_by_code(guarded_app):
    with guarded_app.app_context():
        stale = create_access_token(identity=str(USER_ID), expires_delta=timedelta(seconds=-1))

    response = guarded_app.test_client().get(
        "/api/_any", headers={"Authorization": f"Bearer {stale}"}
    )

    assert response.status_code == 401
    # `ScanPage`, `ResetPassword` and `AcceptInvite` all branch on this exact code
    # to offer "scan the code showing now" or "request a fresh link" instead of a
    # generic failure. A plain "unauthorized" here would collapse all three into
    # the same dead end.
    assert _error(response)["code"] == "token_expired"


def test_an_identity_that_is_not_an_objectid_is_refused(guarded_app):
    """No database call: ``_load_user`` bails at ``ObjectId(...)``.

    Which is why ``forbid_mongo`` does not have to be worked around here — a token
    forged with a junk subject cannot cost a query.
    """
    with guarded_app.app_context():
        forged = create_access_token(identity="not-an-objectid")

    response = guarded_app.test_client().get(
        "/api/_any", headers={"Authorization": f"Bearer {forged}"}
    )

    assert response.status_code == 401
    assert "no longer valid" in _error(response)["message"]


# --------------------------------------------------------------------------- #
# The account lifecycle, checked on every request
# --------------------------------------------------------------------------- #
def test_a_disabled_account_is_refused_despite_a_valid_token(guarded_app, sign_in):
    headers = sign_in(status=UserStatus.DISABLED)
    response = guarded_app.test_client().get("/api/_any", headers=headers)

    # The token is perfectly valid and unexpired. Disabling an account has to take
    # effect now, not whenever it happens to lapse.
    assert response.status_code == 401
    assert "no longer valid" in _error(response)["message"]


def test_a_deleted_user_is_refused(guarded_app, monkeypatch):
    with guarded_app.app_context():
        token = create_access_token(identity=str(USER_ID))
    monkeypatch.setattr(db, "users", lambda: _OneDocument(None))

    response = guarded_app.test_client().get(
        "/api/_any", headers={"Authorization": f"Bearer {token}"}
    )
    assert response.status_code == 401


# --------------------------------------------------------------------------- #
# Role gates
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("role", Role.ALL)
def test_any_authenticated_admits_every_role(guarded_app, sign_in, role):
    response = guarded_app.test_client().get("/api/_any", headers=sign_in(role=role))

    assert response.status_code == 200
    body = response.get_json()
    assert body["role"] == role
    # `g` is populated for the audit log before the view body runs.
    assert body["actor_id"] == str(USER_ID)
    assert body["institution_id"] == str(INSTITUTION)
    assert body["actor_role"] == role


@pytest.mark.parametrize("role", [Role.TEACHER, Role.STUDENT])
def test_a_role_gate_forbids_everyone_else(guarded_app, sign_in, role):
    response = guarded_app.test_client().get("/api/_admin_only", headers=sign_in(role=role))

    assert response.status_code == 403
    error = _error(response)
    assert error["code"] == "forbidden"
    # The message names the roles, so a support ticket does not need a code read.
    assert "admin" in error["message"]


def test_the_role_gate_reads_the_document_not_the_token_claim(guarded_app, sign_in, monkeypatch):
    """Promoting someone takes effect on their next request.

    The token was minted while they were a teacher; the stored document now says
    admin, and that is what the gate honours.
    """
    headers = sign_in(role=Role.TEACHER)
    monkeypatch.setattr(db, "users", lambda: _OneDocument(_user(role=Role.ADMIN)))

    assert guarded_app.test_client().get("/api/_admin_only", headers=headers).status_code == 200


def test_an_admin_reaches_an_admin_route(guarded_app, sign_in):
    response = guarded_app.test_client().get("/api/_admin_only", headers=sign_in(role=Role.ADMIN))
    assert response.status_code == 200


# --------------------------------------------------------------------------- #
# Optional auth: the public QR landing page
# --------------------------------------------------------------------------- #
def test_an_optional_route_is_anonymous_without_a_token(guarded_app):
    response = guarded_app.test_client().get("/api/_open")

    assert response.status_code == 200
    assert response.get_json() == {"authenticated": False, "email": None}


def test_an_optional_route_treats_a_broken_token_as_anonymous(guarded_app):
    # Someone landing on a QR link with a stale token in localStorage must still
    # see the "sign in to continue" prompt rather than an error page.
    response = guarded_app.test_client().get(
        "/api/_open", headers={"Authorization": "Bearer not.a.real.token"}
    )

    assert response.status_code == 200
    assert response.get_json()["authenticated"] is False


def test_an_optional_route_recognises_a_signed_in_student(guarded_app, sign_in):
    response = guarded_app.test_client().get("/api/_open", headers=sign_in(role=Role.STUDENT))

    assert response.status_code == 200
    assert response.get_json() == {"authenticated": True, "email": "ann@x.edu"}


# --------------------------------------------------------------------------- #
# Tenant isolation
# --------------------------------------------------------------------------- #
def test_scope_pins_the_callers_institution(guarded_app, sign_in):
    response = guarded_app.test_client().get("/api/_scoped", headers=sign_in())

    assert response.get_json() == {"status": "active", "institution_id": str(INSTITUTION)}


def test_a_document_in_my_institution_passes(guarded_app, sign_in):
    response = guarded_app.test_client().get("/api/_subject_tenant?doc=mine", headers=sign_in())
    assert response.status_code == 200


@pytest.mark.parametrize("which", ["theirs", "unscoped", "missing"])
def test_anything_not_mine_is_404_never_403(guarded_app, sign_in, which):
    """404 for all three cases, and that uniformity is the point.

    A 403 on ``theirs`` would confirm that another institution holds a subject with
    that id, which is a small leak on its own. Indistinguishable from ``missing`` is
    the only safe answer.
    """
    response = guarded_app.test_client().get(
        f"/api/_subject_tenant?doc={which}", headers=sign_in()
    )

    assert response.status_code == 404
    assert _error(response)["code"] == "not_found"
    assert _error(response)["message"] == "Subject not found"


def test_a_teacher_manages_only_their_own_subjects(guarded_app, sign_in):
    client = guarded_app.test_client()
    headers = sign_in(role=Role.TEACHER)

    assert client.get("/api/_manage_subject?assigned=yes", headers=headers).status_code == 200
    denied = client.get("/api/_manage_subject?assigned=no", headers=headers)
    assert denied.status_code == 403
    assert "not assigned to teach" in _error(denied)["message"]


def test_an_admin_manages_any_subject_in_their_institution(guarded_app, sign_in):
    headers = sign_in(role=Role.ADMIN)
    response = guarded_app.test_client().get("/api/_manage_subject?assigned=no", headers=headers)

    assert response.status_code == 200


def test_the_session_teacher_can_manage_their_own_session(guarded_app, sign_in):
    response = guarded_app.test_client().get("/api/_manage_session?owner=me", headers=sign_in())

    # Returns before the subject is even fetched, which is why `db.subjects` is not
    # patched here -- `forbid_mongo` would fire if that path were taken.
    assert response.status_code == 200


def test_a_co_teacher_on_the_subject_can_manage_someone_elses_session(
    guarded_app, sign_in, monkeypatch
):
    """Ownership falls through from the session to the subject roster.

    A teacher who shares the subject can cover a colleague's class, which is the
    whole reason ``teacher_ids`` is a list.
    """
    headers = sign_in(role=Role.TEACHER)
    subject = {"_id": SUBJECT_ID, "institution_id": INSTITUTION, "teacher_ids": [USER_ID]}
    monkeypatch.setattr(db, "subjects", lambda: _OneDocument(subject))

    response = guarded_app.test_client().get("/api/_manage_session?owner=other", headers=headers)
    assert response.status_code == 200


def test_an_unrelated_teacher_cannot_manage_the_session(guarded_app, sign_in, monkeypatch):
    headers = sign_in(role=Role.TEACHER)
    subject = {"_id": SUBJECT_ID, "institution_id": INSTITUTION, "teacher_ids": [STRANGER_ID]}
    monkeypatch.setattr(db, "subjects", lambda: _OneDocument(subject))

    response = guarded_app.test_client().get("/api/_manage_session?owner=other", headers=headers)
    assert response.status_code == 403
    assert "not assigned to this session" in _error(response)["message"]


# --------------------------------------------------------------------------- #
# Id coercion
# --------------------------------------------------------------------------- #
def test_as_object_ids_accepts_both_forms():
    ident = ObjectId("64f0a1b2c3d4e5f601234567")
    assert as_object_ids([ident, str(ident)]) == [ident, ident]


def test_as_object_ids_rejects_garbage_as_a_400():
    with pytest.raises(ApiError) as caught:
        as_object_ids(["not-an-id"])
    assert caught.value.status == 400

