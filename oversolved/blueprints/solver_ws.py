"""WebSocket solver endpoint — thread-sticky, per-session cache, request/response model."""

import array as _array
import json
import logging
import struct
import threading
from time import time
from flask import request, current_app, g
from flask_sock import Sock
from oversolved.blueprints import get_db
from oversolved.db import SessionStore, UserStore
from oversolved.kernel.build_isolated import BuildIsolator

logger = logging.getLogger(__name__)


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


def _float32_bytes(values):
    return _array.array('f', values).tobytes()


def _uint32_bytes(values):
    return _array.array('I', values).tobytes()


def _pack_body_section(body, body_offset, header_bodies, binary_chunks):
    """Pack one body into binary chunks and write its header metadata."""
    mesh = body.get("mesh", {}) or {}
    raw_verts = mesh.get("vertices", []) or []
    raw_faces = mesh.get("faces", []) or []
    raw_tri2face = mesh.get("triangle_to_face", []) or []

    flat_verts = [coord for v in raw_verts for coord in v]
    flat_faces = [idx for f in raw_faces for idx in f]

    verts_bytes = _float32_bytes(flat_verts)
    faces_bytes = _uint32_bytes(flat_faces)
    tri2face_bytes = _uint32_bytes(raw_tri2face)

    v_len = len(verts_bytes)
    f_len = len(faces_bytes)
    t_len = len(tri2face_bytes)

    header_bodies[body.get("id", "")] = {
        "created_by": body.get("created_by"),
        "modified_by": body.get("modified_by", []),
        "face_data": mesh.get("face_data", []),
        "face_queries": mesh.get("face_queries", []),
        "edges": body.get("edges", []),
        "edge_queries": body.get("edge_queries", []),
        "brep_vertex_queries": body.get("vertex_queries", []),
        "vertices": body.get("vertices", []),
        "offsets": {
            "vertices": [body_offset, v_len],
            "faces": [body_offset + v_len, f_len],
            "tri2face": [body_offset + v_len + f_len, t_len],
        },
        "counts": {
            "vertices": len(raw_verts),
            "faces": len(raw_faces),
            "tri2face": len(raw_tri2face),
        },
    }

    binary_chunks.extend([verts_bytes, faces_bytes, tri2face_bytes])
    return body_offset + v_len + f_len + t_len


def pack_geometry_update(msg_id, bodies, pick_bodies=None):
    """Pack geometry data into a binary WebSocket frame.

    Layout: [4B padded_json_len][JSON header (padded to 4B alignment)][binary data]
    Offsets in the header are relative to the start of the binary data section.
    Returns bytes suitable for ws.send().
    """
    header = {"msgId": msg_id, "bodies": {}, "pick_bodies": {}}
    binary_chunks = []
    body_offset = 0

    for body_id, body in (bodies or {}).items():
        body_with_id = {**body, "id": body_id}
        body_offset = _pack_body_section(
            body_with_id, body_offset, header["bodies"], binary_chunks
        )

    for body_id, body in (pick_bodies or {}).items():
        body_with_id = {**body, "id": body_id}
        body_offset = _pack_body_section(
            body_with_id, body_offset, header["pick_bodies"], binary_chunks
        )

    header_bytes = json.dumps(header, separators=(",", ":")).encode("utf-8")
    padded_len = ((len(header_bytes) + 3) // 4) * 4
    header_bytes = header_bytes.ljust(padded_len, b"\x00")

    return struct.pack(">I", padded_len) + header_bytes + b"".join(binary_chunks)


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
    isolator = BuildIsolator(timeout=build_timeout)
    db = get_db()

    try:
        msg_count = 0
        while ws.connected:
            message = ws.receive()
            if message is None:
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


def _handle_solve(data, isolator, db, ws):
    """Handle a solve request. Sends solve_result (JSON) then geometry_update (binary)."""
    features = data.get("features")
    msg_id = data.get("msgId")

    if features is None:
        ws.send(json.dumps({"type": "solve_result", "msgId": msg_id, "error": "features required"}))
        return

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
        db.execute(
            """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
               VALUES (?, ?, ?)""",
            (doc_id, round(duration_ms), feature_count),
        )
        db.commit()

    bodies = build_result.pop("bodies", {})
    pick_bodies = build_result.pop("pick_bodies", None)

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

    geometry_bytes = pack_geometry_update(
        msg_id=msg_id,
        bodies=bodies,
        pick_bodies=pick_bodies,
    )
    ws.send(geometry_bytes)


def register_solver_ws(sock: Sock):
    """Register the solver WebSocket handler."""
    sock.route("/api/solver-ws")(solver_websocket)
