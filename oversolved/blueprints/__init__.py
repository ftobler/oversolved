"""Shared utilities for Flask blueprints."""

from functools import wraps
from typing import Literal
from urllib.parse import urlparse
from flask import g, jsonify, request, current_app
from oversolved.db import (
    Database, PostgreSQLConnection, DocumentStore, create_database,
)
from oversolved.auth import authenticate_token, AuthOk


def api_error(message: str, code: str, status: int = 400):
    """Return a (jsonify(response), status) tuple with the unified error shape."""
    return jsonify({"ok": False, "error": message, "code": code}), status


def _get_database(config):
    """Create a database connection from the Flask app's db config dict."""
    return create_database(config["type"], dsn=config.get("dsn"), path=config.get("path"))


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


def require_json(f):
    """Decorator that requires the request Content-Type to be application/json."""

    @wraps(f)
    def decorated(*args, **kwargs):
        if not request.is_json:
            return api_error("Content-Type must be application/json", "INVALID_CONTENT_TYPE", 400)
        return f(*args, **kwargs)

    return decorated


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
        if not origin and not referer:
            return api_error("Request blocked for security reasons. Please reload the page.", "CSRF_FAILED", 403)
        host_netloc = urlparse(request.url).netloc
        if origin and urlparse(origin).netloc != host_netloc:
            return api_error("Request blocked for security reasons. Please reload the page.", "CSRF_FAILED", 403)
        if referer and urlparse(referer).netloc != host_netloc:
            return api_error("Request blocked for security reasons. Please reload the page.", "CSRF_FAILED", 403)
        return f(*args, **kwargs)
    return decorated


def require_auth(f):
    """Decorator that requires a valid, active session cookie."""

    @wraps(f)
    def decorated(*args, **kwargs):
        token = request.cookies.get("session_token")
        result = authenticate_token(get_db(), token)
        if not isinstance(result, AuthOk):
            return api_error(result.message, "UNAUTHORIZED", 401)
        g.current_user = result.user
        return f(*args, **kwargs)

    return decorated


def require_admin(f):
    """Decorator that requires the current user to be an admin."""

    @wraps(f)
    def decorated_function(*args, **kwargs):
        if not g.current_user.get("is_admin"):
            return api_error("Admin access required", "FORBIDDEN", 403)
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
            if doc_uuid is None:
                return api_error("Document not found", "NOT_FOUND", 404)
            db = get_db()
            doc_store = DocumentStore(db)
            doc = doc_store.retrieve(doc_uuid)
            if doc is None:
                return api_error("Document not found", "NOT_FOUND", 404)
            actual = doc_store.get_permission(doc_uuid, g.current_user["id"])
            if not _permission_at_least(actual, level):
                return api_error("Forbidden", "FORBIDDEN", 403)
            g.document = doc
            g.document_permission = actual
            return f(*args, **kwargs)
        return decorated
    return decorator


def auth_required(
    *,
    admin: bool = False,
    doc: Literal["view", "edit", "owner"] | None = None,
    doc_url_var: str = "uuid",
    json: bool = False,
):
    """Compose the gate stack every authenticated endpoint repeats.

    `@require_auth` + `@require_csrf` sat on 31 of the 32 routes that use this,
    usually followed by some subset of admin / document permission / JSON body.
    Spelling the stack out per route made the ORDER of the checks a per-route
    decision, and the order is what decides which failure a caller sees: a
    request that is both unauthenticated and malformed must answer 401, not 400.

    The wrapping below fixes that order once: session, CSRF, admin, document
    permission, body content type. Decorators apply inner-to-outer, so this
    reads bottom-up relative to the stack it replaces.

    The 32nd route is `users.get_preferences`, which carried `@require_auth`
    alone. Folding it in adds CSRF, which is a provable no-op there: the route is
    GET-only and `require_csrf` exempts GET/HEAD/OPTIONS in its first branch,
    before it looks at anything else.
    """
    if doc is None and doc_url_var != "uuid":
        # A url_var with no level to enforce means the document check silently
        # did not happen -- almost certainly a dropped `doc=` at the call site.
        raise ValueError("doc_url_var is meaningless without doc=")

    def decorator(f):  # type: ignore[misc]
        if json:
            f = require_json(f)
        if doc is not None:
            f = require_doc_permission(doc, url_var=doc_url_var)(f)
        if admin:
            f = require_admin(f)
        f = require_csrf(f)
        f = require_auth(f)
        return f
    return decorator


def validate_password_strength(password: str) -> str | None:
    """Validate password meets minimum requirements. Returns error message or None."""
    if len(password) < 8:
        return "Password must be at least 8 characters long"
    return None
