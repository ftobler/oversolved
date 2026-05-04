"""Flask application for the Oversolved solver API."""

import os
import sys
from pathlib import Path
from flask import Flask, send_from_directory, g
from werkzeug.security import generate_password_hash
from oversolved.db import Database, UserStore
from oversolved.blueprints import _get_database
from oversolved.blueprints.auth import auth_bp
from oversolved.blueprints.users import users_bp
from oversolved.blueprints.documents import documents_bp
from oversolved.blueprints.upload_export import upload_export_bp
from oversolved.blueprints.solver import solver_bp
from oversolved.blueprints.cache_inspect import cache_inspect_bp
from oversolved.blueprints.admin import admin_bp
from oversolved.blueprints.docs import docs_bp
from oversolved.cache import TtlCache, L2Cache


def _register_migrations(db: Database) -> None:
    """Register all database migrations. Idempotent - only registers once per Database instance."""
    if db._migrations_registered:
        return
    db._migrations_registered = True

    def migration_001_initial_schema(database: Database):
        database.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                FOREIGN KEY (owner_id) REFERENCES users(id)
            )
        """)

    db.register_migration(1, "initial_schema", migration_001_initial_schema)

    def migration_002_add_preview_image(database: Database):
        database.execute("ALTER TABLE documents ADD COLUMN preview_image BLOB")

    db.register_migration(2, "add_preview_image", migration_002_add_preview_image)

    def migration_003_add_shares(database: Database):
        database.execute("""
            CREATE TABLE document_shares (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_uuid TEXT NOT NULL,
                shared_with_user_id INTEGER NULL,
                permission TEXT NOT NULL DEFAULT 'view',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
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
            "UPDATE users SET updated_at = datetime('now') WHERE updated_at IS NULL"
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
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_key TEXT UNIQUE NOT NULL,
                last_run_at TEXT,
                last_run_status TEXT
            )
        """)

    db.register_migration(11, "periodic_tasks", migration_011_periodic_tasks)

    def migration_012_accounts_table(database: Database):
        database.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                handle TEXT UNIQUE NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
                """INSERT OR IGNORE INTO accounts (handle, owner_type, owner_id)
                   VALUES (?, ?, ?)""",
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
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                document_uuid TEXT NOT NULL,
                duration_ms INTEGER NOT NULL,
                feature_count INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
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


def _ensure_admin_user(db: Database) -> None:
    """Create the default admin user if it doesn't exist."""
    admin_password = os.environ.get("OVERSOLVED_ADMIN_PASSWORD")
    if not admin_password:
        raise RuntimeError("OVERSOLVED_ADMIN_PASSWORD must be set")
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


def create_app(config: dict | None = None) -> Flask:
    """Create and configure the Flask app."""
    app = Flask(__name__)

    app.config.update(
        {
            "DB_TYPE": "sqlite",
            "DB_PATH": ":memory:",
            "JSON_SORT_KEYS": False,
            "L2_CACHE_ENABLED": True,
            "L2_CACHE_DIR": "/tmp/oversolved_l2_cache",
            "L2_CACHE_MAX_SIZE": 5 * 1024 * 1024 * 1024,  # 5 GB
            "L2_CACHE_TTL": 86400 * 30,  # 30 days
            "SESSION_COOKIE_SECURE": os.environ.get("OVERSOLVED_SESSION_COOKIE_SECURE", "false").lower() == "true",
            "MAX_CONTENT_LENGTH": 100 * 1024 * 1024,  # 100 MB
        }
    )

    if config:
        app.config.update(config)

    db_config = {
        "type": app.config["DB_TYPE"],
        "path": app.config.get("DB_PATH", ":memory:"),
        "host": app.config.get("DB_HOST"),
        "user": app.config.get("DB_USER"),
        "password": app.config.get("DB_PASSWORD"),
        "name": app.config.get("DB_NAME"),
    }

    # Make db_config accessible to blueprints via get_db()
    app.config["_DB_CONFIG"] = db_config

    # Register migrations and verify schema version before starting
    db = _get_database(db_config)
    _register_migrations(db)
    if app.config.get("TESTING"):
        db.init()
    else:
        try:
            is_ok, current, latest = db.check_version_sync()
        except TimeoutError:
            print("ERROR: Could not acquire database lock for version check", file=sys.stderr)
            db.close()
            sys.exit(1)
        if not is_ok:
            print(
                f"ERROR: Database schema version mismatch "
                f"(current: {current}, latest: {latest})",
                file=sys.stderr,
            )
            print("Run: oversolved db upgrade", file=sys.stderr)
            db.close()
            sys.exit(1)
    _ensure_admin_user(db)
    db.close()

    # Create cache instances accessible to blueprints
    app.extensions["build_state_cache"] = TtlCache(ttl_seconds=300.0, max_size=1000)
    app.extensions["l2_cache"] = L2Cache(
        ttl_seconds=app.config["L2_CACHE_TTL"],
        max_size=app.config["L2_CACHE_MAX_SIZE"],
        cache_dir=app.config["L2_CACHE_DIR"],
    )

    # Register blueprints
    app.register_blueprint(auth_bp)
    app.register_blueprint(users_bp)
    app.register_blueprint(documents_bp)
    app.register_blueprint(upload_export_bp)
    app.register_blueprint(solver_bp)
    app.register_blueprint(cache_inspect_bp)
    app.register_blueprint(admin_bp)
    app.register_blueprint(docs_bp)

    # ── Frontend static serving ───────────────────────────────────────────────

    frontend_dist = Path(__file__).parent.parent / "frontend" / "dist"
    if frontend_dist.exists():

        @app.route("/")
        @app.route("/<path:path>")
        def serve_frontend(path="index.html"):
            if path and (frontend_dist / path).exists():
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
