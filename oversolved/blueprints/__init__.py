"""Shared utilities for Flask blueprints."""

import secrets
from functools import wraps
from flask import g, jsonify, request, current_app
from oversolved.db import Database, SQLiteConnection, MariaDBConnection, SessionStore, UserStore


def _get_database(config):
    """Create a database connection based on config."""
    if config["type"] == "sqlite":
        db_conn = SQLiteConnection(config["path"])
    elif config["type"] == "mariadb":
        db_conn = MariaDBConnection(
            host=config["host"],
            user=config["user"],
            password=config["password"],
            database=config["name"],
        )
    else:
        raise ValueError(f"Unknown database type: {config['type']}")
    return Database(db_conn)


def get_db():
    """Get or create database connection for this request."""
    if "db" not in g:
        g.db = _get_database(current_app.config["_DB_CONFIG"])
        g.db.init()
    return g.db


def _set_csrf_token(response):
    """Set a non-httponly XSRF-TOKEN cookie for JS access."""
    token = secrets.token_hex(16)
    secure = current_app.config.get("SESSION_COOKIE_SECURE", False)
    response.set_cookie(
        "XSRF-TOKEN",
        token,
        httponly=False,
        samesite="Lax",
        secure=secure,
        max_age=60 * 60 * 24 * 30,
    )
    return response


def require_csrf(f):
    """Decorator that requires a valid CSRF token for state-changing requests.

    Uses the double-submit cookie pattern: validates X-XSRF-TOKEN header
    matches the XSRF-TOKEN cookie. GET and HEAD requests are exempt.
    Skipped when TESTING is True for test compatibility.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return f(*args, **kwargs)
        if current_app.config.get("TESTING"):
            return f(*args, **kwargs)
        csrf_cookie = request.cookies.get("XSRF-TOKEN")
        csrf_header = request.headers.get("X-XSRF-TOKEN")
        if not csrf_cookie or not csrf_header or csrf_cookie != csrf_header:
            return jsonify({"error": "Invalid CSRF token"}), 403
        return f(*args, **kwargs)
    return decorated


def require_auth(f):
    """Decorator that requires a valid session cookie."""

    @wraps(f)
    def decorated(*args, **kwargs):
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
        g.current_user = user
        return f(*args, **kwargs)

    return decorated


def require_admin(f):
    """Decorator that requires the current user to be an admin."""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not g.current_user.get("is_admin"):
            return jsonify({"error": "Admin access required"}), 403
        return f(*args, **kwargs)

    return decorated_function


def validate_password_strength(password: str) -> str | None:
    """Validate password meets minimum requirements. Returns error message or None."""
    if len(password) < 8:
        return "Password must be at least 8 characters long"
    return None
