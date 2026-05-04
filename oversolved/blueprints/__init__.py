"""Shared utilities for Flask blueprints."""

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
