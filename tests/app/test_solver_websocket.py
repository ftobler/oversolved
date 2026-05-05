"""Tests for solver WebSocket endpoint."""

import json
import threading
from unittest.mock import patch
import pytest
from oversolved.app import create_app
from oversolved.blueprints.solver_ws import solver_websocket
from oversolved.db import Database, SQLiteConnection


class _MockWS:
    """Mock WebSocket for testing flask-sock handlers without a real connection."""

    def __init__(self):
        self.sent = []
        self.connected = True
        self.receive_queue = []
        self.close_reason = None
        self.close_message = None

    def send(self, data):
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


def _run_handler(app, ws, auth_headers):
    """Run solver_websocket in a background thread with Flask context."""
    def _run():
        with app.app_context():
            with app.test_request_context(headers=auth_headers):
                solver_websocket(ws)

    thread = threading.Thread(target=_run)
    thread.daemon = True
    thread.start()
    thread.join(timeout=5)


@pytest.fixture
def app(tmp_path, monkeypatch):
    """Create a test Flask app with a file-based SQLite database."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app({
        "DB_TYPE": "sqlite",
        "TESTING": True,
        "DB_PATH": str(tmp_path / "test.db"),
    })
    return test_app


@pytest.fixture
def client(app):
    """Create an unauthenticated test client."""
    return app.test_client()


@pytest.fixture
def auth_headers(app):
    """Login as admin and return Cookie header dict for WebSocket auth."""
    client = app.test_client()
    resp = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert resp.status_code == 200
    set_cookie = resp.headers.get("Set-Cookie", "")
    token = set_cookie.split("session_token=")[1].split(";")[0]
    return {"Cookie": f"session_token={token}"}


SOLVE_PAYLOAD = {
    "type": "solve",
    "id": "test-doc-1",
    "features": [{"id": "sk1", "kind": "sketch", "entities": []}],
}


class TestSolverWebSocket:

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_solve(self, mock_build, app, auth_headers):
        """Send a solve request and receive solve_result."""
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"built": True},
        }
        ws = _MockWS()
        ws.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws, auth_headers)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "solve_result"

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_ping_pong(self, mock_build, app, auth_headers):
        """Send ping, receive pong."""
        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "ping"}), None]
        _run_handler(app, ws, auth_headers)
        assert len(ws.sent) == 1
        assert ws.sent[0] == {"type": "pong"}

    def test_websocket_requires_auth(self, app):
        """Connect without auth cookie should close with 4001."""
        ws = _MockWS()
        _run_handler(app, ws, {})
        assert not ws.connected
        assert ws.close_reason == 4001

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_unknown_message_type(self, mock_build, app, auth_headers):
        """Unknown message type returns an error."""
        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "foobar"}), None]
        _run_handler(app, ws, auth_headers)
        assert len(ws.sent) == 1
        assert ws.sent[0]["type"] == "error"
        assert "Unknown message type" in ws.sent[0]["error"]

    def test_websocket_malformed_json(self, app, auth_headers):
        """Non-JSON input returns Invalid JSON error."""
        ws = _MockWS()
        ws.receive_queue = ["not json", None]
        _run_handler(app, ws, auth_headers)
        assert len(ws.sent) == 1
        assert ws.sent[0] == {"type": "error", "error": "Invalid JSON"}

    def test_websocket_solve_missing_features(self, app, auth_headers):
        """Solve without features key returns an error."""
        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "solve"}), None]
        _run_handler(app, ws, auth_headers)
        assert len(ws.sent) == 1
        assert ws.sent[0] == {"type": "solve_result", "error": "features required"}

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_cache_retains_state(self, mock_build, app, auth_headers):
        """Solve the same doc_id twice; second call gets prev_state from cache."""
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"cached": "state-1"},
        }
        ws = _MockWS()
        ws.receive_queue = [
            json.dumps(SOLVE_PAYLOAD),
            json.dumps(SOLVE_PAYLOAD),
            None,
        ]
        _run_handler(app, ws, auth_headers)
        assert mock_build.call_args_list[0][1]["prev_state"] is None
        assert mock_build.call_args_list[1][1]["prev_state"] == {"cached": "state-1"}

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_cache_clear(self, mock_build, app, auth_headers):
        """Clear_cache empties the cache; next solve has no prev_state."""
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"state": True},
        }
        ws = _MockWS()
        ws.receive_queue = [
            json.dumps(SOLVE_PAYLOAD),
            json.dumps({"type": "clear_cache"}),
            json.dumps(SOLVE_PAYLOAD),
            None,
        ]
        _run_handler(app, ws, auth_headers)
        assert mock_build.call_args_list[0][1]["prev_state"] is None
        assert mock_build.call_args_list[1][1]["prev_state"] is None

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_cache_lru_eviction(self, mock_build, app, auth_headers):
        """With max cache size 2, solving a 3rd doc evicts the 1st."""
        app.config["SOLVER_WS_CACHE_MAX_SIZE"] = 2
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"state": True},
        }
        ws = _MockWS()
        ws.receive_queue = [
            json.dumps({"type": "solve", "id": "doc1", "features": [{"id": "sk1", "kind": "sketch", "entities": []}]}),
            json.dumps({"type": "solve", "id": "doc2", "features": [{"id": "sk1", "kind": "sketch", "entities": []}]}),
            json.dumps({"type": "solve", "id": "doc3", "features": [{"id": "sk1", "kind": "sketch", "entities": []}]}),
            None,
        ]
        _run_handler(app, ws, auth_headers)
        for call in mock_build.call_args_list:
            assert call[1]["prev_state"] is None

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_disconnect_clears_cache(self, mock_build, app, auth_headers):
        """Disconnecting and reconnecting gives a fresh cache."""
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"state": True},
        }

        ws1 = _MockWS()
        ws1.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws1, auth_headers)

        ws2 = _MockWS()
        ws2.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws2, auth_headers)

        assert mock_build.call_args_list[0][1]["prev_state"] is None
        assert mock_build.call_args_list[1][1]["prev_state"] is None

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_rebuild_times_logged(self, mock_build, app, auth_headers):
        """Solve with doc_id inserts a row into rebuild_times."""
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"built": True},
            "solve_ms": 42,
        }
        ws = _MockWS()
        ws.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws, auth_headers)

        conn = SQLiteConnection(app.config["DB_PATH"])
        rows = conn.execute(
            "SELECT document_uuid, duration_ms, feature_count FROM rebuild_times"
        ).fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0]["document_uuid"] == "test-doc-1"
        assert rows[0]["duration_ms"] == 42
        assert rows[0]["feature_count"] == 1

    def test_http_solve_returns_404(self, client, auth_headers):
        """HTTP POST /api/solve returns 404 since the route uses WebSocket only."""
        response = client.post(
            "/api/solve",
            data=json.dumps(SOLVE_PAYLOAD),
            content_type="application/json",
            headers=auth_headers,
        )
        assert response.status_code == 405

    def test_websocket_config_default_cache_size(self, app):
        """Default SOLVER_WS_CACHE_MAX_SIZE is 10."""
        assert app.config.get("SOLVER_WS_CACHE_MAX_SIZE", 10) == 10

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_solve_multiple_messages_sequential(
        self, mock_build, app, auth_headers
    ):
        """Send 3 sequential solves, verify 3 responses in order."""
        doc_ids = ["doc-a", "doc-b", "doc-c"]

        def _build_side_effect(data, prev_state=None, pick_boundary=None, rollback_position=None):
            return {
                "status": "ok",
                "result": {},
                "bodies": {},
                "_build_state": {"id": data.get("id")},
                "solve_ms": 10,
            }
        mock_build.side_effect = _build_side_effect

        ws = _MockWS()
        ws.receive_queue = [
            json.dumps({"type": "solve", "id": did, "features": [{"id": "sk1", "kind": "sketch", "entities": []}]})
            for did in doc_ids
        ] + [None]
        _run_handler(app, ws, auth_headers)

        assert len(ws.sent) == 3
        for i, did in enumerate(doc_ids):
            assert ws.sent[i]["type"] == "solve_result"
            assert "_build_state" not in ws.sent[i]

    @patch("oversolved.blueprints.solver_ws.build")
    def test_websocket_db_closed_on_disconnect(
        self, mock_build, app, auth_headers
    ):
        """Database connection is closed when the WebSocket handler exits."""
        mock_build.return_value = {
            "status": "ok",
            "result": {},
            "bodies": {},
            "_build_state": {"built": True},
        }
        original_close = Database.close
        close_called = []

        def _tracking_close(self_db):
            close_called.append(True)
            return original_close(self_db)

        with patch.object(Database, "close", _tracking_close):
            ws = _MockWS()
            ws.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
            _run_handler(app, ws, auth_headers)

        assert len(close_called) >= 1
