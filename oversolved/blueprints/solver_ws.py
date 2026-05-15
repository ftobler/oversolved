"""WebSocket solver endpoint — thread-sticky, per-session cache, request/response model."""

import base64
import json
import logging
import os
import threading
from pathlib import Path
from time import time
from flask import request, current_app, g
from flask_sock import Sock
from oversolved.blueprints import get_db
from oversolved.db import SessionStore, UserStore
from oversolved.kernel.build_isolated import BuildIsolator
from oversolved.kernel.geometry_pack import pack_geometry_update  # noqa: F401 re-export

logger = logging.getLogger(__name__)


PING_INTERVAL = 30  # seconds — max time between any message from client
MAX_MESSAGE_SIZE = 10 * 1024 * 1024  # 10 MB


# ─── Rate limiting for WS auth failures ───

_auth_failures: dict[str, list[float]] = {}
_auth_failures_lock = threading.Lock()


def _rate_limit_exceeded(ip: str) -> bool:
    """Check if an IP has exceeded the auth failure threshold."""
    now = time()
    with _auth_failures_lock:
        failures = _auth_failures.get(ip, [])
        failures[:] = [t for t in failures if now - t < 60]
        if not failures:
            _auth_failures.pop(ip, None)
        return len(failures) > 10


def _record_auth_failure(ip: str):
    """Record an auth failure for an IP."""
    now = time()
    with _auth_failures_lock:
        failures = _auth_failures.get(ip)
        if failures is None:
            _auth_failures[ip] = [now]
        else:
            failures.append(now)


def _check_auth(ws) -> bool:
    """Check authentication on WS connect/re-validate. Returns True if authenticated."""
    client_ip = request.remote_addr or "unknown"

    token = request.cookies.get("session_token")
    if not token:
        logger.warning("WS auth failed: no session token (client: %s)", client_ip)
        ws.close(4001, "Not authenticated")
        return False

    db = get_db()
    session = SessionStore(db).find(token)
    if session is None:
        logger.warning("WS auth failed: invalid/expired session (client: %s)", client_ip)
        ws.close(4001, "Invalid or expired session")
        return False

    user = UserStore(db).find_by_id(session["user_id"])
    if user is None:
        logger.warning("WS auth failed: user not found (client: %s)", client_ip)
        ws.close(4001, "User not found")
        return False

    if not user.get("is_active", True):
        logger.warning("WS auth failed: account deactivated (user_id=%s)", session.get("user_id"))
        ws.close(4001, "Account deactivated")
        return False

    g.current_user = user
    return True


def solver_websocket(ws):
    """Persistent WebSocket for solver sessions."""
    client_ip = request.remote_addr or "unknown"

    if _rate_limit_exceeded(client_ip):
        logger.warning("WS auth rate limit exceeded (client: %s)", client_ip)
        ws.close(4001, "Rate limited")
        return

    if not _check_auth(ws):
        _record_auth_failure(client_ip)
        return

    build_timeout = current_app.config.get("SOLVER_WS_BUILD_TIMEOUT", 30)
    auth_check_interval = current_app.config.get("WS_AUTH_CHECK_INTERVAL", 50)
    solver_host = current_app.config.get("SOLVER_DAEMON_HOST", "127.0.0.1")
    solver_port = current_app.config.get("SOLVER_DAEMON_PORT", 9100)
    isolator = BuildIsolator(host=solver_host, port=solver_port, timeout=build_timeout)
    db = get_db()

    try:
        msg_count = 0
        while ws.connected:
            try:
                message = ws.receive(timeout=PING_INTERVAL)
            except Exception:
                logger.warning("Connection idle timeout, closing solver WebSocket")
                break
            if message is None:
                break

            if isinstance(message, str) and len(message.encode('utf-8')) > MAX_MESSAGE_SIZE:
                logger.warning("Rejected oversized message: %d bytes", len(message.encode('utf-8')))
                ws.close(1009, "Message too large")
                break

            msg_count += 1
            if auth_check_interval > 0 and msg_count % auth_check_interval == 0:
                if not _check_auth(ws):
                    return

            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                ws.send(json.dumps({"type": "error", "error": "Invalid JSON"}))
                continue

            msg_type = data.get("type")

            if msg_type == "solve":
                _handle_solve(data, isolator, db, ws)

            elif msg_type == "clear_cache":
                isolator.clear_cache()
                ws.send(json.dumps({"type": "cache_cleared"}))

            elif msg_type == "ping":
                ws.send(json.dumps({"type": "pong"}))

            else:
                ws.send(json.dumps({"type": "error", "error": "Unknown message type"}))

    except Exception:
        logger.exception("WebSocket error")
    finally:
        isolator.shutdown()
        db.close()


def _resolve_import_files(data):
    """Resolve file_id to base64-encoded file_data for import_step features.

    The solver must never read from the filesystem, so the Flask app layer
    reads each uploaded STEP file and inlines its content into the feature.
    """
    upload_dir = Path(current_app.config["UPLOAD_DIR"]).resolve()
    features = data.get("features", []) or []
    for feature in features:
        if feature.get("kind") != "import_step":
            continue
        file_id = feature.get("file_id", "")
        if not file_id:
            continue
        file_path = (upload_dir / file_id).resolve()
        if not str(file_path).startswith(str(upload_dir)):
            logger.warning("Path traversal attempt: %r", file_id)
            raise ValueError(f"invalid file_id: {file_id!r}")
        if not file_path.is_file():
            raise ValueError(f"file not found: {file_id!r}")
        with open(file_path, "rb") as f:
            feature["file_data"] = base64.b64encode(f.read()).decode("ascii")
        del feature["file_id"]


def _handle_solve(data, isolator, db, ws):
    """Handle a solve request. Sends solve_result (JSON) then geometry_update (binary)."""
    features = data.get("features")
    msg_id = data.get("msgId")

    if features is None:
        ws.send(json.dumps({"type": "solve_result", "msgId": msg_id, "error": "features required"}))
        return

    _resolve_import_files(data)

    doc_id = data.get("id")
    rollback_position = data.get("rollback_position")
    pick_boundary = data.get("pick_boundary")

    build_result = isolator.build(
        data,
        doc_id=doc_id,
        pick_boundary=pick_boundary,
        rollback_position=rollback_position,
    )

    duration_ms = build_result.get("solve_ms")
    if duration_ms is not None and duration_ms > 0 and doc_id:
        feature_count = len(features) if features else 0
        try:
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, round(duration_ms), feature_count),
            )
            db.commit()
        except Exception:
            db.rollback()

    geometry_bytes = build_result.pop("_geometry_bytes", None)

    result = build_result.get("result", {})
    error_msg = result.get("_error") if isinstance(result, dict) else None
    if error_msg:
        ws.send(json.dumps({
            "type": "solve_result",
            "msgId": msg_id,
            "solve_ms": build_result.get("solve_ms", 0),
            "error": error_msg,
        }))
        return

    ws.send(json.dumps({
        "type": "solve_result",
        "msgId": msg_id,
        "solve_ms": build_result.get("solve_ms"),
        "result": result,
    }))

    if geometry_bytes:
        ws.send(geometry_bytes)


def register_solver_ws(sock: Sock):
    """Register the solver WebSocket handler."""
    sock.route("/api/solver-ws")(solver_websocket)
