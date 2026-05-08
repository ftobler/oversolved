"""Authentication routes."""

import threading
from datetime import datetime, timezone
from time import time
from flask import Blueprint, jsonify, request, make_response, current_app
from werkzeug.security import check_password_hash
from oversolved.db import UserStore, SessionStore
from oversolved.blueprints import get_db, require_csrf

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

# ─── Rate limiting for login ───

_login_failures: dict[str, list[float]] = {}
_login_failures_lock = threading.Lock()
_LOGIN_RATE_LIMIT = 10
_LOGIN_RATE_WINDOW = 60


def _login_rate_limit_exceeded(ip: str) -> bool:
    now = time()
    with _login_failures_lock:
        failures = _login_failures.get(ip, [])
        failures[:] = [t for t in failures if now - t < _LOGIN_RATE_WINDOW]
        if not failures:
            _login_failures.pop(ip, None)
        return len(failures) >= _LOGIN_RATE_LIMIT


def _record_login_failure(ip: str):
    now = time()
    with _login_failures_lock:
        failures = _login_failures.get(ip)
        if failures is None:
            _login_failures[ip] = [now]
        else:
            failures.append(now)


def _clear_login_failures(ip: str):
    with _login_failures_lock:
        _login_failures.pop(ip, None)


@auth_bp.route("/login", methods=["POST"])
def login():
    client_ip = request.remote_addr or "unknown"
    if _login_rate_limit_exceeded(client_ip):
        return jsonify({"error": "Too many login attempts"}), 429

    if not request.is_json:
        return jsonify({"error": "Content-Type must be application/json"}), 400
    data = request.get_json()
    credential = (data.get("credential") or data.get("username") or "").strip()
    password = data.get("password") or ""
    if not credential or not password:
        return jsonify({"error": "Credential and password required"}), 400
    db = get_db()
    user_store = UserStore(db)
    user = (
        user_store.find_by_username(credential)
        or user_store.find_by_email(credential)
    )
    if user is None or not check_password_hash(user["password_hash"], password):
        _record_login_failure(client_ip)
        return jsonify({"error": "Invalid credentials"}), 401

    _clear_login_failures(client_ip)
    if not user["is_active"]:
        return jsonify({"error": "Account is deactivated"}), 403
    user_store.update(user["id"], last_login_at=datetime.now(timezone.utc).isoformat())
    token = SessionStore(db).create(user["id"])
    response = make_response(
        jsonify(
            {
                "user": {
                    "id": user["id"],
                    "username": user["username"],
                    "email": user.get("email"),
                    "must_change_password": user["must_change_password"],
                    "is_admin": user["is_admin"],
                    "is_active": user["is_active"],
                    "last_login_at": user.get("last_login_at"),
                }
            }
        )
    )
    secure = current_app.config.get("SESSION_COOKIE_SECURE", False)
    response.set_cookie(
        "session_token",
        token,
        httponly=True,
        samesite="Lax",
        secure=secure,
        max_age=60 * 60 * 24 * 30,
    )
    return response


@auth_bp.route("/logout", methods=["POST"])
@require_csrf
def logout():
    token = request.cookies.get("session_token")
    if token:
        SessionStore(get_db()).delete(token)
    response = make_response(jsonify({"status": "logged_out"}))
    response.delete_cookie("session_token")
    return response


@auth_bp.route("/me", methods=["GET"])
def me():
    token = request.cookies.get("session_token")
    if not token:
        return jsonify({"error": "Not authenticated"}), 401
    db = get_db()
    session = SessionStore(db).find(token)
    if session is None:
        return jsonify({"error": "Invalid or expired session"}), 401
    user = UserStore(db).find_by_id(session["user_id"])
    if user is None:
        return jsonify({"error": "User not found"}), 401
    return jsonify(
        {
            "user": {
                "id": user["id"],
                "username": user["username"],
                "email": user.get("email") or "",
                "must_change_password": user["must_change_password"],
                "is_admin": user["is_admin"],
                "is_active": user["is_active"],
                "last_login_at": user.get("last_login_at"),
            }
        }
    )
