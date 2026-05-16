"""Flask application for the Oversolved solver API."""

import logging
import os
from pathlib import Path
from flask import Flask, send_from_directory, g
from werkzeug.security import generate_password_hash
from oversolved.db import Database, UserStore
from oversolved.blueprints import _get_database
from oversolved.config import OversolvedConfig
from oversolved.blueprints.auth import auth_bp
from oversolved.blueprints.users import users_bp
from oversolved.blueprints.documents import documents_bp
from oversolved.blueprints.upload_export import upload_export_bp
from oversolved.blueprints.admin import admin_bp
from oversolved.blueprints.docs import docs_bp
from flask_sock import Sock
from oversolved.blueprints.solver_ws import register_solver_ws
from oversolved.migrations import discover_and_register

logger = logging.getLogger(__name__)


def _register_migrations(db: Database) -> None:
    """Register all migrations on a Database instance (backward compat for tests)."""
    discover_and_register(db)


def _ensure_admin_user(db: Database, testing: bool = False) -> None:
    """Create the default admin user if it doesn't exist."""
    admin_password = os.environ.get("OVERSOLVED_ADMIN_PASSWORD")
    if not admin_password:
        admin_password = "admin"
    if admin_password == "admin":
        is_dev = os.environ.get("FLASK_ENV") == "development"
        if not is_dev and not testing:
            raise RuntimeError(
                "Refusing to start with default admin password. "
                "Set OVERSOLVED_ADMIN_PASSWORD environment variable."
            )
        logger.warning("Using default admin password 'admin' — INSECURE for production")
    user_store = UserStore(db)
    admin = user_store.find_by_username("admin")
    if admin:
        user_store.update(admin["id"], is_admin=1)
    else:
        uid = user_store.create(
            "admin", generate_password_hash(admin_password),
            must_change_password=True, email="admin@local.oversolved",
        )
        user_store.update(uid, is_admin=1, must_change_password=1)


def _check_production_config(app: Flask) -> None:
    """Warn about missing production security settings.

    Suppressed in TESTING mode to keep test output clean.
    """
    if app.config.get("TESTING"):
        return
    if not app.config.get("SESSION_COOKIE_SECURE", False):
        logger.warning(
            "SESSION_COOKIE_SECURE is False. Session cookies will NOT have the Secure flag. "
            "Set OVERSOLVED_SESSION_COOKIE_SECURE=true in production (requires HTTPS)."
        )


def create_app(config: dict | None = None) -> Flask:
    """Create and configure the Flask app."""
    app = Flask(__name__)

    app.config.update(
        {
            "DB_TYPE": "postgres",
            "DB_DSN": os.environ.get(
                "OVERSOLVED_DB_DSN",
                "postgresql://oversolved:oversolved@localhost:5432/oversolved",
            ),
            "JSON_SORT_KEYS": False,
            "SESSION_COOKIE_SECURE": os.environ.get("OVERSOLVED_SESSION_COOKIE_SECURE", "false").lower() == "true",
            "MAX_CONTENT_LENGTH": 100 * 1024 * 1024,  # 100 MB
        }
    )

    if config:
        app.config.update(config)

    _check_production_config(app)

    db_config = {
        "type": app.config["DB_TYPE"],
        "dsn": app.config.get("DB_DSN"),
        "path": app.config.get("DB_PATH", ":memory:"),
        "host": app.config.get("DB_HOST"),
        "user": app.config.get("DB_USER"),
        "password": app.config.get("DB_PASSWORD"),
        "name": app.config.get("DB_NAME"),
    }

    # Make db_config accessible to blueprints via get_db()
    app.config["_DB_CONFIG"] = db_config

    if db_config["type"] == "postgres":
        import psycopg2.pool
        pool_min = int(os.environ.get("OVERSOLVED_DB_POOL_MIN", "1"))
        default_pool_max = "1" if app.config.get("TESTING") else "10"
        pool_max = int(os.environ.get("OVERSOLVED_DB_POOL_MAX", default_pool_max))
        _pool = psycopg2.pool.ThreadedConnectionPool(pool_min, pool_max, db_config["dsn"])
        app.config["_DB_POOL"] = _pool

        def _close_pool_safe():
            try:
                _pool.closeall()
            except Exception:
                pass

        import atexit
        atexit.register(_close_pool_safe)

    # Run all pending migrations on startup
    db = _get_database(db_config)
    discover_and_register(db)
    db.init()
    _ensure_admin_user(db, testing=app.config.get("TESTING", False))
    db.close()

    # Build and store structured config; also mirror keys for legacy consumers.
    oversolved_cfg = OversolvedConfig.from_env(instance_path=app.instance_path)
    app.config["OVERSOLVED"] = oversolved_cfg
    app.config.setdefault("UPLOAD_DIR", oversolved_cfg.upload_dir)
    app.config.setdefault("SOLVER_WS_CACHE_MAX_SIZE", oversolved_cfg.solver_ws_cache_max_size)
    app.config.setdefault("WS_AUTH_CHECK_INTERVAL", oversolved_cfg.ws_auth_check_interval)
    app.config.setdefault("SOLVER_DAEMON_HOST", oversolved_cfg.solver_daemon_host)
    app.config.setdefault("SOLVER_DAEMON_PORT", oversolved_cfg.solver_daemon_port)

    # Register blueprints
    app.register_blueprint(auth_bp)
    app.register_blueprint(users_bp)
    app.register_blueprint(documents_bp)
    app.register_blueprint(upload_export_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(docs_bp)

    # Register WebSocket solver
    sock = Sock(app)
    register_solver_ws(sock)

    @app.after_request
    def add_security_headers(response):
        if response.status_code == 101:
            return response
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("X-XSS-Protection", "0")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        response.headers['Content-Security-Policy'] = (
            "default-src 'self'; "
            "script-src 'self'; "
            "style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data: blob:; "
            "connect-src 'self' ws: wss:; "
            "worker-src 'self' blob:; "
        )
        if app.config.get("SESSION_COOKIE_SECURE", False):
            response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
        return response

    # ── Frontend static serving ───────────────────────────────────────────────

    _dist_default = Path(__file__).parent.parent / "frontend" / "dist"
    frontend_dist = Path(config.get("FRONTEND_DIST", _dist_default)) if config else _dist_default

    @app.route("/")
    @app.route("/<path:path>")
    def serve_frontend(path="index.html"):
        if not frontend_dist.exists():
            return "", 404
        if path:
            try:
                requested = (frontend_dist / path).resolve()
                resolved_dist = frontend_dist.resolve()
                if not str(requested).startswith(str(resolved_dist)):
                    return "", 404
            except (OSError, ValueError):
                return "", 404
            if requested.exists():
                return send_from_directory(frontend_dist, path)
        return send_from_directory(frontend_dist, "index.html")

    @app.teardown_appcontext
    def close_db(error):
        pool_info = g.pop("_pool_conn", None)
        db = g.pop("db", None)
        if pool_info is not None:
            _pool, raw_conn = pool_info
            raw_conn.rollback()
            _pool.putconn(raw_conn)
        elif db is not None:
            db.close()

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(debug=True)
