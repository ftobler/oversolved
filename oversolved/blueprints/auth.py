"""Authentication routes."""

from flask import Blueprint, jsonify, request, make_response, current_app
from werkzeug.security import check_password_hash, generate_password_hash
from oversolved.db import UserStore, SessionStore, _now
from oversolved.blueprints import get_db, require_csrf, require_json, api_error
from oversolved.rate_limit import RateLimiter

auth_bp = Blueprint("auth", __name__, url_prefix="/api/auth")

_dummy_hash: str | None = None


def _get_dummy_hash() -> str:
    """Dummy bcrypt hash for timing-equalization on unknown users.

    Computed on first use, not at import: generate_password_hash is ~250ms and
    would otherwise run on every process/test startup whether login is hit or not.
    """
    global _dummy_hash
    if _dummy_hash is None:
        _dummy_hash = generate_password_hash("dummy")
    return _dummy_hash


# ─── Rate limiting for login ───

_LOGIN_RATE_LIMIT = 10
_LOGIN_RATE_WINDOW = 60

_login_limiter = RateLimiter(window_s=_LOGIN_RATE_WINDOW, max_events=_LOGIN_RATE_LIMIT)


def _login_rate_limit_exceeded(ip: str) -> bool:
    return _login_limiter.is_exceeded(ip)


def _record_login_failure(ip: str) -> None:
    _login_limiter.record(ip)


def _clear_login_failures(ip: str) -> None:
    _login_limiter.clear(ip)


def _user_response(user: dict) -> dict:
    """Public-facing user fields shared by the login and me responses."""
    return {
        "id": user["id"],
        "username": user["username"],
        "email": user.get("email") or "",
        "must_change_password": user["must_change_password"],
        "is_admin": user["is_admin"],
        "is_active": user["is_active"],
        "last_login_at": user.get("last_login_at"),
    }


@auth_bp.route("/login", methods=["POST"])
@require_json
def login():
    client_ip = request.remote_addr or "unknown"
    if _login_rate_limit_exceeded(client_ip):
        return api_error("Too many login attempts", "RATE_LIMITED", 429)

    data = request.get_json()
    credential = (data.get("credential") or data.get("username") or "").strip()
    password = data.get("password") or ""
    if not credential or not password:
        return api_error("Credential and password required", "BAD_REQUEST", 400)
    db = get_db()
    user_store = UserStore(db)
    user = (
        user_store.find_by_username(credential)
        or user_store.find_by_email(credential)
    )
    if user is None:
        check_password_hash(_get_dummy_hash(), password)
        _record_login_failure(client_ip)
        return api_error("Invalid credentials", "INVALID_CREDENTIALS", 401)
    if not check_password_hash(user["password_hash"], password):
        _record_login_failure(client_ip)
        return api_error("Invalid credentials", "INVALID_CREDENTIALS", 401)

    _clear_login_failures(client_ip)
    if not user["is_active"]:
        return api_error("Account is deactivated", "FORBIDDEN", 403)
    user_store.update(user["id"], last_login_at=_now())
    token = SessionStore(db).create(user["id"])
    response = make_response(jsonify({"user": _user_response(user)}))
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
        return api_error("Not authenticated", "UNAUTHORIZED", 401)
    db = get_db()
    session = SessionStore(db).find(token)
    if session is None:
        return api_error("Invalid or expired session", "UNAUTHORIZED", 401)
    user = UserStore(db).find_by_id(session["user_id"])
    if user is None:
        return api_error("User not found", "USER_NOT_FOUND", 401)
    return jsonify({"user": _user_response(user)})
