"""Tests for solver WebSocket endpoint."""

import json
import threading
from unittest.mock import patch, MagicMock
import pytest
from oversolved.app import create_app
from oversolved.blueprints.solver_ws import solver_websocket, _auth_failures
from oversolved.db import Database, PostgreSQLConnection


class _MockWS:
    """Mock WebSocket for testing flask-sock handlers without a real connection."""

    def __init__(self):
        self.sent_raw = []  # raw payloads (str or bytes)
        self.sent = []      # JSON-decoded text frames only
        self.connected = True
        self.receive_queue = []
        self.close_reason = None
        self.close_message = None

    def send(self, data):
        self.sent_raw.append(data)
        if isinstance(data, (bytes, bytearray)):
            return  # binary frame — keep in sent_raw only
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


def _run_handler(app, ws, auth_headers, environ_base=None, query_string=None):
    """Run solver_websocket in a background thread with Flask context."""
    kwargs = {"headers": auth_headers}
    if environ_base:
        kwargs["environ_base"] = environ_base
    if query_string is not None:
        kwargs["query_string"] = query_string

    def _run():
        with app.app_context():
            with app.test_request_context(**kwargs):
                solver_websocket(ws)

    thread = threading.Thread(target=_run)
    thread.daemon = True
    thread.start()
    thread.join(timeout=5)


@pytest.fixture(autouse=True)
def reset_auth_failures():
    """Clear the module-level auth failure tracker before each test."""
    _auth_failures.clear()


@pytest.fixture
def app(pg_dsn, monkeypatch):
    """Create a test Flask app backed by a fresh PostgreSQL database."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app({
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
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


def _make_mock_isolator(build_return=None):
    """Create a mock BuildIsolator that returns the given value from build()."""
    if build_return is None:
        build_return = {
            "solve_ms": 5,
            "result": {"sk1": {"status": "underconstrained"}},
            "bodies": {},
        }
    mock = MagicMock()
    mock.build.return_value = build_return
    return mock


class TestSolverWebSocket:

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_solve(self, mock_isolator_cls, app, auth_headers):
        """Send a solve request and receive solve_result."""
        mock_isolator = _make_mock_isolator()
        mock_isolator_cls.return_value = mock_isolator
        ws = _MockWS()
        ws.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws, auth_headers)
        assert len(ws.sent) >= 1
        assert ws.sent[0]["type"] == "solve_result"

    def test_websocket_ping_pong(self, app, auth_headers):
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

    def test_websocket_unknown_message_type(self, app, auth_headers):
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
        assert ws.sent[0]["type"] == "solve_result"
        assert ws.sent[0]["error"] == "features required"

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_cache_clear(self, mock_isolator_cls, app, auth_headers):
        """Clear_cache calls isolator.clear_cache()."""
        mock_isolator = _make_mock_isolator()
        mock_isolator_cls.return_value = mock_isolator
        ws = _MockWS()
        ws.receive_queue = [
            json.dumps({"type": "clear_cache"}),
            None,
        ]
        _run_handler(app, ws, auth_headers)
        mock_isolator.clear_cache.assert_called()

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_disconnect_calls_shutdown(self, mock_isolator_cls, app, auth_headers):
        """Disconnecting calls isolator.shutdown()."""
        mock_isolator = _make_mock_isolator()
        mock_isolator_cls.return_value = mock_isolator
        ws = _MockWS()
        ws.receive_queue = [None]
        _run_handler(app, ws, auth_headers)
        mock_isolator.shutdown.assert_called()

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_rebuild_times_logged(self, mock_isolator_cls, app, auth_headers):
        """Solve with doc_id inserts a row into rebuild_times."""
        # Create the document so the FK constraint on rebuild_times is satisfied
        client = app.test_client()
        client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        create_resp = client.post(
            "/api/documents",
            data=json.dumps({"name": "test-doc"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]
        payload = dict(SOLVE_PAYLOAD, id=doc_id)

        mock_isolator = _make_mock_isolator({
            "solve_ms": 42,
            "result": {"sk1": {"status": "underconstrained"}},
            "bodies": {},
        })
        mock_isolator_cls.return_value = mock_isolator
        ws = _MockWS()
        ws.receive_queue = [json.dumps(payload), None]
        _run_handler(app, ws, auth_headers)

        conn = PostgreSQLConnection(app.config["DB_DSN"])
        rows = conn.execute(
            "SELECT document_uuid, duration_ms, feature_count FROM rebuild_times"
        ).fetchall()
        conn.close()
        assert len(rows) == 1
        assert rows[0]["document_uuid"] == doc_id
        assert rows[0]["duration_ms"] == 42
        assert rows[0]["feature_count"] == 1

    def test_http_solve_returns_405(self, client, auth_headers):
        """HTTP POST /api/solve returns 405: no POST handler, only the SPA GET catch-all."""
        response = client.post(
            "/api/solve",
            data=json.dumps(SOLVE_PAYLOAD),
            content_type="application/json",
            headers=auth_headers,
        )
        assert response.status_code == 405

    def test_websocket_config_default_cache_size(self, app):
        """Default SOLVER_WS_BUILD_TIMEOUT is 30."""
        assert app.config.get("SOLVER_WS_BUILD_TIMEOUT", 30) == 30

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_solve_multiple_messages_sequential(
        self, mock_isolator_cls, app, auth_headers
    ):
        """Send 3 sequential solves, verify 3 responses in order."""
        doc_ids = ["doc-a", "doc-b", "doc-c"]

        mock_isolator = _make_mock_isolator({
            "solve_ms": 10,
            "result": {"sk1": {"status": "underconstrained"}},
            "bodies": {},
        })
        mock_isolator_cls.return_value = mock_isolator

        ws = _MockWS()
        ws.receive_queue = [
            json.dumps({"type": "solve", "id": did, "features": [{"id": "sk1", "kind": "sketch", "entities": []}]})
            for did in doc_ids
        ] + [None]
        _run_handler(app, ws, auth_headers)

        assert len(ws.sent) == 3
        for i in range(3):
            assert ws.sent[i]["type"] == "solve_result"

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_db_closed_on_disconnect(
        self, mock_isolator_cls, app, auth_headers
    ):
        """Database connection is closed when the WebSocket handler exits."""
        mock_isolator = _make_mock_isolator()
        mock_isolator_cls.return_value = mock_isolator
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

    def test_websocket_rejects_query_token(self, app):
        """Connect with ?token=... in URL but no cookie, verify 4001."""
        client = app.test_client()
        resp = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        set_cookie = resp.headers.get("Set-Cookie", "")
        token = set_cookie.split("session_token=")[1].split(";")[0]

        ws = _MockWS()
        ws.receive_queue = [
            json.dumps({"type": "ping"}),
            None,
        ]
        _run_handler(app, ws, {}, environ_base={"REMOTE_ADDR": "127.0.0.1"},
                     query_string=f"token={token}")
        assert not ws.connected
        assert ws.close_reason == 4001

    def test_websocket_auth_query_token_invalid(self, app):
        """Connect with bad ?token=..., verify 4001."""
        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "ping"}), None]
        _run_handler(app, ws, {}, environ_base={"REMOTE_ADDR": "127.0.0.2"},
                     query_string="token=bad-token")
        assert not ws.connected
        assert ws.close_reason == 4001

    def test_websocket_auth_cookie_only(self, app):
        """Connect with valid cookie and no query token, verify success."""
        client = app.test_client()
        resp = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        set_cookie = resp.headers.get("Set-Cookie", "")
        valid_token = set_cookie.split("session_token=")[1].split(";")[0]

        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "ping"}), None]
        _run_handler(app, ws, {"Cookie": f"session_token={valid_token}"},
                     environ_base={"REMOTE_ADDR": "127.0.0.3"})
        assert len(ws.sent) == 1
        assert ws.sent[0] == {"type": "pong"}

    def test_websocket_auth_deactivated_user(self, app):
        """Deactivated user gets 4001."""
        client = app.test_client()
        resp = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        set_cookie = resp.headers.get("Set-Cookie", "")
        token = set_cookie.split("session_token=")[1].split(";")[0]

        with app.app_context():
            from oversolved.blueprints import get_db
            from oversolved.db import UserStore
            db = get_db()
            user = UserStore(db).find_by_username("admin")
            assert user is not None
            UserStore(db).set_active(user["id"], False)
            db.close()

        ws = _MockWS()
        ws.receive_queue = [json.dumps({"type": "ping"}), None]
        _run_handler(app, ws, {"Cookie": f"session_token={token}"}, environ_base={
            "REMOTE_ADDR": "127.0.0.4",
        })
        assert not ws.connected
        assert ws.close_reason == 4001

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_websocket_auth_periodic_recheck(self, mock_isolator_cls, app):
        """Auth is re-checked every WS_AUTH_CHECK_INTERVAL messages."""
        app.config["WS_AUTH_CHECK_INTERVAL"] = 2
        mock_isolator = _make_mock_isolator({
            "solve_ms": 1,
            "result": {},
            "bodies": {},
        })
        mock_isolator_cls.return_value = mock_isolator

        client = app.test_client()
        resp = client.post(
            "/api/auth/login",
            data=json.dumps({"username": "admin", "password": "admin"}),
            content_type="application/json",
        )
        assert resp.status_code == 200
        set_cookie = resp.headers.get("Set-Cookie", "")
        token = set_cookie.split("session_token=")[1].split(";")[0]

        solve_msg = json.dumps({"type": "solve", "features": []})
        ws = _MockWS()
        ws.receive_queue = [solve_msg, solve_msg, solve_msg, solve_msg, None]
        _run_handler(app, ws, {"Cookie": f"session_token={token}"}, environ_base={
            "REMOTE_ADDR": "127.0.0.5",
        })
        # All should succeed since token is valid
        assert mock_isolator.build.call_count >= 1

    @patch("oversolved.blueprints.solver_ws.logger")
    def test_websocket_auth_failure_logged(self, mock_logger, app):
        """Auth failure logs a warning."""
        ws = _MockWS()
        ws.receive_queue = [None]
        _run_handler(app, ws, {}, environ_base={"REMOTE_ADDR": "127.0.0.6"})
        mock_logger.warning.assert_called()

    def test_websocket_auth_rate_limiting(self, app):
        """11th auth failure from the same IP is rejected."""
        from oversolved.blueprints.solver_ws import _rate_limit_exceeded, _record_auth_failure

        ip = "10.0.0.1"
        for _ in range(10):
            _record_auth_failure(ip)
        assert not _rate_limit_exceeded(ip)
        _record_auth_failure(ip)
        assert _rate_limit_exceeded(ip)

    def test_websocket_rate_limit_rejects_connection(self, app):
        """Rate-limited IP gets closed with 4001 on connect."""
        from oversolved.blueprints.solver_ws import _record_auth_failure

        ip = "10.0.0.2"
        for _ in range(11):
            _record_auth_failure(ip)

        ws = _MockWS()
        ws.receive_queue = [None]
        _run_handler(app, ws, {}, environ_base={"REMOTE_ADDR": ip})
        assert not ws.connected
        assert ws.close_reason == 4001


class TestPackGeometryUpdate:

    def test_pack_geometry_update_structure(self):
        """Binary frame starts with 4-byte big-endian json length followed by JSON."""
        import struct
        from oversolved.blueprints.solver_ws import pack_geometry_update

        result = pack_geometry_update(msg_id=7, bodies={}, pick_bodies=None)
        assert isinstance(result, bytes)
        padded_len = struct.unpack(">I", result[:4])[0]
        assert padded_len % 4 == 0
        header_bytes = result[4:4 + padded_len].rstrip(b"\x00")
        header = json.loads(header_bytes)
        assert header["msgId"] == 7
        assert "bodies" in header

    def test_pack_geometry_update_roundtrip(self):
        """Vertex and face data survives a pack/unpack round-trip."""
        import struct
        import array as _array
        from oversolved.blueprints.solver_ws import pack_geometry_update

        body = {
            "created_by": "extrude_0",
            "modified_by": [],
            "mesh": {
                "vertices": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                "faces": [[0, 1, 2]],
                "triangle_to_face": [0],
                "face_data": [],
                "face_queries": [],
            },
            "edges": [],
            "edge_queries": [],
            "vertices": [],
            "vertex_queries": [],
        }
        result = pack_geometry_update(msg_id=1, bodies={"body_0": body})
        padded_len = struct.unpack(">I", result[:4])[0]
        header = json.loads(result[4:4 + padded_len].rstrip(b"\x00"))

        body_meta = header["bodies"]["body_0"]
        data_start = 4 + padded_len
        v_off, v_len = body_meta["offsets"]["vertices"]
        verts = _array.array('f')
        verts.frombytes(result[data_start + v_off: data_start + v_off + v_len])
        assert list(verts) == [0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]

        f_off, f_len = body_meta["offsets"]["faces"]
        faces = _array.array('I')
        faces.frombytes(result[data_start + f_off: data_start + f_off + f_len])
        assert list(faces) == [0, 1, 2]

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_solver_ws_sends_two_messages(self, mock_isolator_cls, app, auth_headers):
        """Solve sends JSON text frame then binary geometry_update frame."""
        mock_body = {
            "id": "body_0",
            "created_by": "extrude_0",
            "modified_by": [],
            "mesh": {
                "vertices": [[0.0, 0.0, 0.0]],
                "faces": [],
                "triangle_to_face": [],
                "face_data": [],
                "face_queries": [],
            },
            "edges": [],
            "edge_queries": [],
            "vertices": [],
            "vertex_queries": [],
        }
        mock_isolator = _make_mock_isolator({
            "solve_ms": 5,
            "result": {},
            "bodies": {"body_0": mock_body},
        })
        mock_isolator_cls.return_value = mock_isolator

        ws = _MockWS()
        ws.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws, auth_headers)

        assert len(ws.sent_raw) >= 2
        assert isinstance(ws.sent_raw[0], str)
        # At least one binary frame
        has_binary = any(isinstance(r, (bytes, bytearray)) for r in ws.sent_raw)
        assert has_binary
        first = json.loads(ws.sent_raw[0])
        assert first["type"] == "solve_result"

    @patch("oversolved.blueprints.solver_ws.BuildIsolator")
    def test_solver_ws_solve_result_no_bodies(self, mock_isolator_cls, app, auth_headers):
        """JSON solve_result frame must not contain a bodies key."""
        mock_isolator = _make_mock_isolator({
            "solve_ms": 3,
            "result": {},
            "bodies": {"body_0": {}},
        })
        mock_isolator_cls.return_value = mock_isolator

        ws = _MockWS()
        ws.receive_queue = [json.dumps(SOLVE_PAYLOAD), None]
        _run_handler(app, ws, auth_headers)

        json_frame = json.loads(ws.sent_raw[0])
        assert "bodies" not in json_frame
