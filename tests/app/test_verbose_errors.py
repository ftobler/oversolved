"""Tests for verbose error message reduction."""

import json
import pytest
import threading
from unittest.mock import patch, MagicMock
from oversolved.app import create_app
from oversolved.blueprints.solver_ws import solver_websocket, _auth_failures
from PIL import Image
from io import BytesIO


class _MockWS:
    def __init__(self):
        self.sent_raw = []
        self.sent = []
        self.connected = True
        self.receive_queue = []
        self.close_reason = None
        self.close_message = None

    def send(self, data):
        self.sent_raw.append(data)
        if isinstance(data, (bytes, bytearray)):
            return
        self.sent.append(json.loads(data))

    def receive(self, timeout=None):
        if self.receive_queue:
            return self.receive_queue.pop(0)
        if not self.connected:
            return None
        return None

    def close(self, reason=None, message=None):
        self.connected = False
        self.close_reason = reason
        self.close_message = message


def _run_ws(app, ws, environ_base):
    def _run():
        with app.app_context():
            with app.test_request_context(headers={}, environ_base=environ_base):
                solver_websocket(ws)
    thread = threading.Thread(target=_run)
    thread.daemon = True
    thread.start()
    thread.join(timeout=5)


@pytest.fixture(autouse=True)
def reset():
    _auth_failures.clear()
    yield


@pytest.fixture
def app(pg_dsn, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    return create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})


@pytest.fixture
def authed_client(app):
    """Return a test client that is already logged in as admin."""
    client = app.test_client()
    client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    return client


@pytest.fixture
def auth_env(app):
    """Return environ_base dict with session cookie for API calls."""
    client = app.test_client()
    resp = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    token = resp.headers.get("Set-Cookie", "").split("session_token=")[1].split(";")[0]
    return {"HTTP_COOKIE": f"session_token={token}"}


class TestVerboseWsErrors:

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_ws_invalid_json_vague(self, mock_isolator_cls, app, auth_env):
        mock_isolator_cls.return_value = MagicMock()
        ws = _MockWS()
        ws.receive_queue = ["not json", None]
        _run_ws(app, ws, auth_env)
        assert any(s.get("error") == "Invalid JSON" for s in ws.sent)

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_ws_unknown_type_vague(self, mock_isolator_cls, app, auth_env):
        mock_isolator_cls.return_value = MagicMock()
        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "unknown_xyz"}), None]
        _run_ws(app, ws, auth_env)
        assert any(s.get("error") == "Unknown message type" for s in ws.sent)
        assert not any("unknown_xyz" in str(s) for s in ws.sent)

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_ws_missing_fields_vague(self, mock_isolator_cls, app, auth_env):
        mock_isolator_cls.return_value = MagicMock()
        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "solve"}), None]
        _run_ws(app, ws, auth_env)
        assert any(s.get("type") == "solve_result" and s.get("error") == "features required" for s in ws.sent)


class TestVerboseUploadErrors:

    def test_upload_unsupported_extension_vague(self, authed_client):
        data = {"file": (BytesIO(b"test"), "malware.exe")}
        resp = authed_client.post("/api/upload", data=data)
        assert resp.status_code == 400
        data_resp = resp.get_json()
        assert data_resp["ok"] is False
        assert data_resp["error"] == "Unsupported file type"


class TestVerbosePreviewErrors:

    def test_preview_size_limit_vague(self, authed_client):
        img = Image.new("RGB", (600, 600), color="red")
        buf = BytesIO()
        img.save(buf, format="PNG")
        b64 = __import__("base64").b64encode(buf.getvalue()).decode()
        resp = authed_client.put(
            "/api/documents/doc_uuid",
            data=json.dumps({"content": "test", "preview_image": b64}),
            content_type="application/json",
        )
        assert resp.status_code == 400
        data_resp = resp.get_json()
        assert data_resp["ok"] is False
        assert data_resp["error"] == "Invalid image"
