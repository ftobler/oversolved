"""WebSocket solver endpoint — thread-sticky, per-session cache, request/response model."""

import json
import logging
from flask import request, current_app, g
from flask_sock import Sock
from oversolved.blueprints import get_db
from oversolved.db import SessionStore, UserStore
from oversolved.kernel.builder import build
from oversolved.kernel.types3d import BuildState

logger = logging.getLogger(__name__)


def _check_auth(ws) -> bool:
    """Check authentication on WS connect. Returns True if authenticated."""
    token = request.cookies.get("session_token")
    if not token:
        ws.close(4001, "Not authenticated")
        return False
    db = get_db()
    session = SessionStore(db).find(token)
    if session is None:
        ws.close(4001, "Invalid or expired session")
        return False
    user = UserStore(db).find_by_id(session["user_id"])
    if user is None:
        ws.close(4001, "User not found")
        return False
    g.current_user = user
    return True


def solver_websocket(ws):
    """Persistent WebSocket for solver sessions."""
    if not _check_auth(ws):
        return

    max_cache_size = current_app.config.get("SOLVER_WS_CACHE_MAX_SIZE", 10)
    session_cache: dict[str, BuildState] = {}
    db = get_db()

    try:
        while ws.connected:
            message = ws.receive()
            if message is None:
                break

            try:
                data = json.loads(message)
            except json.JSONDecodeError:
                ws.send(json.dumps({"type": "error", "error": "Invalid JSON"}))
                continue

            msg_type = data.get("type")

            if msg_type == "solve":
                msg_id = data.get("msgId")
                result = _handle_solve(data, session_cache, max_cache_size, db)
                if msg_id is not None:
                    result["msgId"] = msg_id
                ws.send(json.dumps({"type": "solve_result", **result}))

            elif msg_type == "clear_cache":
                session_cache.clear()
                ws.send(json.dumps({"type": "cache_cleared"}))

            elif msg_type == "ping":
                ws.send(json.dumps({"type": "pong"}))

            else:
                ws.send(json.dumps({"type": "error", "error": f"Unknown message type: {msg_type}"}))

    except Exception:
        logger.exception("WebSocket error")
    finally:
        session_cache.clear()
        db.close()


def _handle_solve(data, session_cache, max_cache_size, db):
    """Handle a solve request. Sequential — no concurrent solves on this WS."""
    features = data.get("features")
    if features is None:
        return {"error": "features required"}

    doc_id = data.get("id")
    rollback_position = data.get("rollback_position")
    pick_boundary = data.get("pick_boundary")

    prev_state = None
    if doc_id and doc_id in session_cache:
        prev_state = session_cache[doc_id]

    build_result = build(
        data,
        prev_state=prev_state,
        pick_boundary=pick_boundary,
        rollback_position=rollback_position,
    )

    new_state = build_result.pop("_build_state")
    if doc_id:
        if doc_id not in session_cache and len(session_cache) >= max_cache_size:
            session_cache.pop(next(iter(session_cache)))
        session_cache[doc_id] = new_state

    duration_ms = build_result.get("solve_ms")
    if duration_ms is not None and doc_id:
        feature_count = len(features)
        db.execute(
            """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
               VALUES (?, ?, ?)""",
            (doc_id, round(duration_ms), feature_count),
        )
        db.commit()

    build_result.pop("_body_shapes", None)
    return build_result


def register_solver_ws(sock: Sock):
    """Register the solver WebSocket handler."""
    sock.route("/api/solver-ws")(solver_websocket)
