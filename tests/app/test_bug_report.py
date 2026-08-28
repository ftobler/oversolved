"""Tests for the bug-report endpoint's reach: who may submit and how often.

The reporter lives on a header button shown to every visitor, so the endpoint
has to accept the same audience the button is offered to. These pins exist
because it did not: it carried the admin gate it had back when the reporter was
a tab of the admin-only F2 debug drawer.
"""

import json
import pytest
from oversolved.app import create_app
from oversolved.blueprints.admin import _bug_report_limiter, _BUG_REPORT_RATE_LIMIT


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    return create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})


@pytest.fixture
def reports_dir(tmp_path, monkeypatch):
    """Redirect written reports into tmp_path instead of the repository root."""
    monkeypatch.setattr(
        "oversolved.blueprints.admin.Path",
        lambda *_: tmp_path / "depth1" / "depth2" / "depth3",
    )
    return tmp_path / "bugreports"


@pytest.fixture(autouse=True)
def fresh_limiter():
    """The limiter is module state shared by the whole test process."""
    _bug_report_limiter.clear("127.0.0.1")
    _bug_report_limiter.clear("unknown")
    yield
    _bug_report_limiter.clear("127.0.0.1")
    _bug_report_limiter.clear("unknown")


def _submit(client, title):
    return client.post(
        "/api/bug-report",
        data=json.dumps({"title": title, "description": "it broke"}),
        content_type="application/json",
    )


class TestBugReportReach:
    def test_guest_can_submit(self, app, reports_dir):
        """A signed-out visitor sees the button, so the button has to work."""
        response = _submit(app.test_client(), "guest hit a bug")
        assert response.status_code == 201
        payload = json.loads(response.data)
        assert (reports_dir / payload["filename"]).exists()

    def test_guest_report_is_labelled_guest(self, app, reports_dir):
        response = _submit(app.test_client(), "anonymous")
        body = (reports_dir / json.loads(response.data)["filename"]).read_text()
        assert "*Reported by guest (not signed in)*" in body

    def test_regular_user_can_submit(self, app, reports_dir):
        admin = app.test_client()
        admin.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        admin.post(
            "/api/admin/users",
            data=json.dumps({
                "username": "reporter", "password": "reporter123",
                "email": "reporter@example.com",
            }),
            content_type="application/json",
        )
        user = app.test_client()
        user.post(
            "/api/auth/login",
            data=json.dumps({"username": "reporter", "password": "reporter123"}),
            content_type="application/json",
        )

        response = _submit(user, "non admin hit a bug")
        assert response.status_code == 201
        body = (reports_dir / json.loads(response.data)["filename"]).read_text()
        assert "*Reported by reporter <reporter@example.com>*" in body


class TestBugReportRateLimit:
    def test_burst_beyond_the_limit_is_refused(self, app, reports_dir):
        client = app.test_client()
        for i in range(_BUG_REPORT_RATE_LIMIT):
            assert _submit(client, f"report {i}").status_code == 201
        refused = _submit(client, "one too many")
        assert refused.status_code == 429
        assert json.loads(refused.data)["code"] == "RATE_LIMITED"

    def test_rejected_bodies_do_not_consume_the_budget(self, app, reports_dir):
        """A 400 writes no file, so it must not lock a real reporter out."""
        client = app.test_client()
        for _ in range(_BUG_REPORT_RATE_LIMIT * 2):
            assert _submit(client, "   ").status_code == 400
        assert _submit(client, "a real one").status_code == 201
