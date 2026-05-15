"""Flask application for the Oversolved solver API."""

import logging
import os
from pathlib import Path
from flask import Flask, send_from_directory, g
from werkzeug.security import generate_password_hash
from oversolved.db import Database, UserStore
from oversolved.blueprints import _get_database
from oversolved.blueprints.auth import auth_bp
from oversolved.blueprints.users import users_bp
from oversolved.blueprints.documents import documents_bp
from oversolved.blueprints.upload_export import upload_export_bp
from oversolved.blueprints.admin import admin_bp
from oversolved.blueprints.docs import docs_bp
from flask_sock import Sock
from oversolved.blueprints.solver_ws import register_solver_ws

logger = logging.getLogger(__name__)


def _register_migrations(db: Database) -> None:
    """Register all database migrations. Idempotent - only registers once per Database instance."""
    if db._migrations_registered:
        return
    db._migrations_registered = True

    def migration_001_initial_schema(database: Database):
        database.execute("""
            CREATE TABLE users (
                id SERIAL PRIMARY KEY,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (NOW()::text)
            )
        """)
        database.execute("""
            CREATE TABLE sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        database.execute("""
            CREATE TABLE documents (
                uuid TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                content TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (NOW()::text),
                updated_at TEXT NOT NULL DEFAULT (NOW()::text),
                FOREIGN KEY (owner_id) REFERENCES users(id)
            )
        """)

    db.register_migration(1, "initial_schema", migration_001_initial_schema)

    def migration_002_add_preview_image(database: Database):
        database.execute("ALTER TABLE documents ADD COLUMN preview_image BYTEA")

    db.register_migration(2, "add_preview_image", migration_002_add_preview_image)

    def migration_003_add_shares(database: Database):
        database.execute("""
            CREATE TABLE document_shares (
                id SERIAL PRIMARY KEY,
                document_uuid TEXT NOT NULL,
                shared_with_user_id INTEGER NULL,
                permission TEXT NOT NULL DEFAULT 'view',
                created_at TEXT NOT NULL DEFAULT (NOW()::text),
                FOREIGN KEY (document_uuid) REFERENCES documents(uuid) ON DELETE CASCADE,
                FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
                UNIQUE(document_uuid, shared_with_user_id)
            )
        """)
        database.execute("ALTER TABLE documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")

    db.register_migration(3, "add_shares", migration_003_add_shares)

    def migration_004_add_user_management_fields(database: Database):
        database.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        database.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")

    db.register_migration(4, "add_user_management_fields", migration_004_add_user_management_fields)

    def migration_005_add_last_login(database: Database):
        database.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")

    db.register_migration(5, "add_last_login", migration_005_add_last_login)

    def _column_exists(database: Database, table: str, column: str) -> bool:
        from oversolved.db import PostgreSQLConnection
        if isinstance(database.conn, PostgreSQLConnection):
            cursor = database.execute(
                "SELECT column_name FROM information_schema.columns "
                "WHERE table_name = ? AND column_name = ? AND table_schema = 'public'",
                (table, column),
            )
            return cursor.fetchone() is not None
        cursor = database.execute(f"PRAGMA table_info({table})")
        return any(row[1] == column for row in cursor.fetchall())

    def migration_006_user_oauth_prep(database: Database):
        if not _column_exists(database, "users", "email"):
            database.execute("ALTER TABLE users ADD COLUMN email TEXT")
        if not _column_exists(database, "users", "nickname"):
            database.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
        if not _column_exists(database, "users", "external_id"):
            database.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
        if not _column_exists(database, "users", "provider"):
            database.execute("ALTER TABLE users ADD COLUMN provider TEXT")
        if not _column_exists(database, "users", "provider_data"):
            database.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
        if not _column_exists(database, "users", "updated_at"):
            database.execute("ALTER TABLE users ADD COLUMN updated_at TEXT")
        database.execute(
            "UPDATE users SET updated_at = NOW()::text WHERE updated_at IS NULL"
        )
        database.execute(
            "UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL"
        )
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"
        )
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)"
        )
        database.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS "
            "idx_users_external_id_provider ON users(external_id, provider)"
        )

    db.register_migration(6, "user_oauth_prep", migration_006_user_oauth_prep)

    def migration_007_user_sort_preference(database: Database):
        if not _column_exists(database, "users", "document_sort_preference"):
            database.execute(
                "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
            )

    db.register_migration(7, "user_sort_preference", migration_007_user_sort_preference)

    def migration_008_organizations(_database: Database):
        pass

    db.register_migration(8, "organizations", migration_008_organizations)

    def migration_009_documents_org_id(_database: Database):
        pass

    db.register_migration(9, "documents_org_id", migration_009_documents_org_id)

    def migration_010_document_trash(database: Database):
        if not _column_exists(database, "documents", "deleted_at"):
            database.execute("ALTER TABLE documents ADD COLUMN deleted_at TEXT")
        database.execute("CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at)")

    db.register_migration(10, "document_trash", migration_010_document_trash)

    def migration_011_periodic_tasks(database: Database):
        database.execute("""
            CREATE TABLE IF NOT EXISTS periodic_tasks (
                id SERIAL PRIMARY KEY,
                task_key TEXT UNIQUE NOT NULL,
                last_run_at TEXT,
                last_run_status TEXT
            )
        """)

    db.register_migration(11, "periodic_tasks", migration_011_periodic_tasks)

    def migration_012_accounts_table(database: Database):
        database.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id SERIAL PRIMARY KEY,
                handle TEXT UNIQUE NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (NOW()::text)
            )
        """)
        database.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts(handle)
        """)
        database.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_type, owner_id)
        """)

        cursor = database.execute("SELECT id, username FROM users WHERE username IS NOT NULL")
        for row in cursor.fetchall():
            uid, username = row[0], row[1]
            database.execute(
                """INSERT INTO accounts (handle, owner_type, owner_id)
                   VALUES (?, ?, ?) ON CONFLICT DO NOTHING""",
                (username, "user", uid),
            )

    db.register_migration(12, "accounts_table", migration_012_accounts_table)

    def migration_013_remove_nickname(database: Database):
        if _column_exists(database, "users", "nickname"):
            database.execute("DROP INDEX IF EXISTS idx_users_nickname")
            database.execute("ALTER TABLE users DROP COLUMN nickname")

    db.register_migration(13, "remove_nickname", migration_013_remove_nickname)

    def migration_014_remove_organizations(database: Database):
        database.execute("DROP TABLE IF EXISTS organization_members")
        database.execute("DROP TABLE IF EXISTS organizations")
        if _column_exists(database, "documents", "org_id"):
            database.execute("ALTER TABLE documents DROP COLUMN org_id")

    db.register_migration(14, "remove_organizations", migration_014_remove_organizations)

    def migration_015_rebuild_times(database: Database):
        database.execute("""
            CREATE TABLE IF NOT EXISTS rebuild_times (
                id SERIAL PRIMARY KEY,
                document_uuid TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                feature_count INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (NOW()::text),
                FOREIGN KEY (document_uuid) REFERENCES documents(uuid) ON DELETE CASCADE
            )
        """)
        database.execute("""
            CREATE INDEX IF NOT EXISTS idx_rebuild_times_doc
            ON rebuild_times(document_uuid)
        """)

    db.register_migration(15, "rebuild_times", migration_015_rebuild_times)

    def migration_016_sessions_user_id_index(database: Database):
        database.execute(
            "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)"
        )

    db.register_migration(16, "sessions_user_id_index", migration_016_sessions_user_id_index)

    def migration_017_session_created_at(database: Database):
        database.execute(
            "ALTER TABLE sessions ADD COLUMN created_at TEXT"
        )
        database.execute(
            "UPDATE sessions SET created_at = NOW()::text WHERE created_at IS NULL"
        )

    db.register_migration(17, "session_created_at", migration_017_session_created_at)

    def migration_018_token_to_token_hash(database: Database):
        if _column_exists(database, "sessions", "token"):
            database.execute("ALTER TABLE sessions RENAME COLUMN token TO token_hash")

    db.register_migration(18, "token_to_token_hash", migration_018_token_to_token_hash)


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

    # Register and run all pending migrations on startup
    db = _get_database(db_config)
    _register_migrations(db)
    db.init()
    _ensure_admin_user(db, testing=app.config.get("TESTING", False))
    db.close()

    # Set default config
    app.config.setdefault(
        "UPLOAD_DIR",
        os.environ.get(
            "OVERSOLVED_UPLOAD_DIR",
            os.path.join(app.instance_path, "uploads"),
        ),
    )
    app.config.setdefault("SOLVER_WS_CACHE_MAX_SIZE", 10)
    app.config.setdefault("WS_AUTH_CHECK_INTERVAL", 50)
    app.config.setdefault("SOLVER_DAEMON_HOST", os.environ.get("SOLVER_DAEMON_HOST", "127.0.0.1"))
    app.config.setdefault("SOLVER_DAEMON_PORT", int(os.environ.get("SOLVER_DAEMON_PORT", "9100")))

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
        db = g.pop("db", None)
        if db is not None:
            db.close()

    return app


if __name__ == "__main__":
    app = create_app()
    app.run(debug=True)
