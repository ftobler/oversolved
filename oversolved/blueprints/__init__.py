"""Shared utilities for Flask blueprints."""

from functools import wraps
from typing import Literal
from flask import g, jsonify, request, current_app
from oversolved.db import (
    Database, DatabaseConnection, SQLiteConnection,
    PostgreSQLConnection, DocumentStore,
)
from oversolved.auth import authenticate_token, AuthOk


def _get_database(config):
    """Create a database connection based on config."""
    db_conn: DatabaseConnection
    if config["type"] == "postgres":
        db_conn = PostgreSQLConnection(config["dsn"])
    elif config["type"] == "sqlite":
        db_conn = SQLiteConnection(config["path"])
    else:
        raise ValueError(f"Unknown database type: {config['type']}")
    return Database(db_conn)


def get_db():
    """Get or create database connection for this request."""
    if "db" not in g:
        pool = current_app.config.get("_DB_POOL")
        if pool is not None:
            raw_conn = pool.getconn()
            raw_conn.autocommit = False
            g._pool_conn = (pool, raw_conn)
            db_conn = PostgreSQLConnection.from_pool(raw_conn)
            g.db = Database(db_conn)
            # Migrations already ran at startup; skip init()
        else:
            g.db = _get_database(current_app.config["_DB_CONFIG"])
            g.db.init()
    return g.db


def require_csrf(f):
    """Decorator that provides CSRF protection via Origin/Referer header check.

    Validates that the Origin or Referer header matches the request host.
    This is the simplest CSRF defense for same-origin SPA applications and
    requires no frontend changes. GET and HEAD requests are exempt.
    Skipped when TESTING is True for test compatibility.
    """
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.method in ("GET", "HEAD", "OPTIONS"):
            return f(*args, **kwargs)
        if current_app.config.get("TESTING"):
            return f(*args, **kwargs)
        origin = request.headers.get("Origin")
        referer = request.headers.get("Referer")
        host = request.host_url.rstrip("/")
        if origin and origin != host:
            return jsonify({"error": "Invalid CSRF token"}), 403
        if referer and not referer.startswith(host):
            return jsonify({"error": "Invalid CSRF token"}), 403
        return f(*args, **kwargs)
    return decorated


def require_auth(f):
    """Decorator that requires a valid, active session cookie."""

    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.cookies.get("session_token")
        result = authenticate_token(get_db(), token)
        if not isinstance(result, AuthOk):
            return jsonify({"error": result.message}), 401
        g.current_user = result.user
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


_PERMISSION_LEVELS = {"view": 0, "edit": 1, "owner": 2}


def _permission_at_least(actual: str | None, required: str) -> bool:
    """Return True if actual permission meets or exceeds required level."""
    if actual is None:
        return False
    return _PERMISSION_LEVELS.get(actual, -1) >= _PERMISSION_LEVELS[required]


def require_doc_permission(
    level: Literal["view", "edit", "owner"],
    url_var: str = "uuid",
):
    """Decorator that loads a document and enforces a minimum permission level.

    Sets g.document and g.document_permission for the decorated view.
    Returns 404 if the document is missing, 403 if permission is insufficient.
    Must be applied after @require_auth.
    """
    def decorator(f):  # type: ignore[misc]
        @wraps(f)
        def decorated(*args, **kwargs):
            doc_uuid = kwargs.get(url_var)
            db = get_db()
            doc_store = DocumentStore(db)
            doc = doc_store.retrieve(doc_uuid)
            if doc is None:
                return jsonify({"error": "Document not found"}), 404
            actual = doc_store.get_permission(doc_uuid, g.current_user["id"])
            if not _permission_at_least(actual, level):
                return jsonify({"error": "Forbidden"}), 403
            g.document = doc
            g.document_permission = actual
            return f(*args, **kwargs)
        return decorated
    return decorator


def validate_password_strength(password: str) -> str | None:
    """Validate password meets minimum requirements. Returns error message or None."""
    if len(password) < 8:
        return "Password must be at least 8 characters long"
    return None
