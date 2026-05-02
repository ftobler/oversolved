"""Tests for document trash and periodic task system."""

import json
import pytest
from datetime import datetime, timedelta
from oversolved.app import create_app
from oversolved.db import (
    Database,
    SQLiteConnection,
    DocumentStore,
    UserStore,
    PeriodicTaskStore,
)
from oversolved.periodic_tasks import TaskScheduler, EmptyTrashTask, _parse_cron


def _make_db():
    conn = SQLiteConnection(":memory:")
    database = Database(conn)

    def migration_001(db: Database):
        db.execute("""
            CREATE TABLE users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                must_change_password INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        db.execute("""
            CREATE TABLE sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id)
            )
        """)
        db.execute("""
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

    database.register_migration(1, "initial_schema", migration_001)

    def migration_002(db: Database):
        db.execute("ALTER TABLE documents ADD COLUMN preview_image BLOB")

    database.register_migration(2, "add_preview_image", migration_002)

    def migration_003(db: Database):
        db.execute("""
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
        db.execute("ALTER TABLE documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")

    database.register_migration(3, "add_shares", migration_003)

    def migration_004(db: Database):
        db.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
        db.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")

    database.register_migration(4, "add_user_management_fields", migration_004)

    def migration_005(db: Database):
        db.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")

    database.register_migration(5, "add_last_login", migration_005)

    def migration_006(db: Database):
        db.execute("ALTER TABLE users ADD COLUMN email TEXT")
        db.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
        db.execute("ALTER TABLE users ADD COLUMN provider TEXT")
        db.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
        db.execute("ALTER TABLE users ADD COLUMN updated_at TEXT NOT NULL DEFAULT (datetime('now'))")
        db.execute("UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_external_id_provider ON users(external_id, provider)")

    database.register_migration(6, "user_oauth_prep", migration_006)

    def migration_007(db: Database):
        db.execute(
            "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
        )

    database.register_migration(7, "user_sort_preference", migration_007)

    def migration_008(db: Database):
        pass

    database.register_migration(8, "organizations", migration_008)

    def migration_009(db: Database):
        pass

    database.register_migration(9, "documents_org_id", migration_009)

    def migration_010(db: Database):
        db.execute("ALTER TABLE documents ADD COLUMN deleted_at TEXT")
        db.execute("CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at)")

    database.register_migration(10, "document_trash", migration_010)

    def migration_011(db: Database):
        db.execute("""
            CREATE TABLE periodic_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                task_key TEXT UNIQUE NOT NULL,
                last_run_at TEXT,
                last_run_status TEXT
            )
        """)

    database.register_migration(11, "periodic_tasks", migration_011)

    def migration_012(db: Database):
        db.execute("""
            CREATE TABLE IF NOT EXISTS accounts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                handle TEXT UNIQUE NOT NULL,
                owner_type TEXT NOT NULL,
                owner_id INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts(handle)
        """)
        db.execute("""
            CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_type, owner_id)
        """)

    database.register_migration(12, "accounts_table", migration_012)
    database.init()
    return database


@pytest.fixture
def db():
    database = _make_db()
    yield database
    database.close()


@pytest.fixture
def doc_store(db):
    return DocumentStore(db)


@pytest.fixture
def user_store(db):
    return UserStore(db)


@pytest.fixture
def task_store(db):
    return PeriodicTaskStore(db)


@pytest.fixture
def app(tmp_path):
    db_path = str(tmp_path / "test.db")
    test_app = create_app(
        {
            "DB_TYPE": "sqlite",
            "DB_PATH": db_path,
            "TESTING": True,
        }
    )
    return test_app


@pytest.fixture
def client(app):
    return app.test_client()


@pytest.fixture
def authed_client(app):
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client


class TestDocumentTrash:
    """Tests for document soft delete and trash operations."""

    def test_soft_delete_document(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ToTrash"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.delete(f"/api/documents/{uuid}")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "moved_to_trash"
        assert "deleted_at" in data
        assert "expires_at" in data

    def test_recover_document(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ToRecover"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.delete(f"/api/documents/{uuid}")

        response = authed_client.post(f"/api/documents/{uuid}/recover")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "recovered"
        assert data["deleted_at"] is None

        # Document should be back in normal list
        list_resp = authed_client.get("/api/documents")
        uuids = [d["uuid"] for d in json.loads(list_resp.data)["documents"]]
        assert uuid in uuids

    def test_recover_expired_document(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Expired"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Manually set deleted_at to 31 days ago
        from oversolved.db import DocumentStore
        from flask import g
        with authed_client.application.app_context():
            g.db = _get_db_for_app(authed_client.application)
            old_date = (datetime.now() - timedelta(days=31)).isoformat()
            DocumentStore(g.db).update(uuid, deleted_at=old_date)

        response = authed_client.post(f"/api/documents/{uuid}/recover")
        assert response.status_code == 410
        assert "expired" in json.loads(response.data)["error"].lower()

    def test_permanently_delete(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "ToPermaDelete"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.delete(f"/api/documents/{uuid}")

        response = authed_client.delete(f"/api/documents/{uuid}/trash")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "permanently_deleted"

        # Should be completely gone
        get_resp = authed_client.get(f"/api/documents/{uuid}")
        assert get_resp.status_code == 404

    def test_list_trash(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "InTrash"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.delete(f"/api/documents/{uuid}")

        response = authed_client.get("/api/documents/trash")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert any(d["uuid"] == uuid for d in data["documents"])

    def test_trash_not_in_normal_list(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Hidden"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        authed_client.delete(f"/api/documents/{uuid}")

        response = authed_client.get("/api/documents")
        data = json.loads(response.data)
        assert not any(d["uuid"] == uuid for d in data["documents"])

    def test_delete_nonexistent(self, authed_client):
        response = authed_client.delete("/api/documents/no-uuid")
        assert response.status_code == 404

    def test_recover_not_in_trash(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "NotInTrash"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.post(f"/api/documents/{uuid}/recover")
        assert response.status_code == 400
        assert "not in trash" in json.loads(response.data)["error"].lower()

    def test_permanent_delete_not_in_trash(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "NotInTrash2"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        response = authed_client.delete(f"/api/documents/{uuid}/trash")
        assert response.status_code == 400
        assert "not in trash" in json.loads(response.data)["error"].lower()


class TestPeriodicTasks:
    """Tests for periodic task framework."""

    def test_cron_parser_daily(self):
        next_run = _parse_cron("0 2 * * *")
        now = datetime.now()
        assert next_run.hour == 2
        assert next_run.minute == 0
        assert next_run > now or (next_run.day == now.day and next_run.hour >= 2)

    def test_empty_trash_task_deletes_old_docs(self, db, doc_store, user_store, task_store):
        uid = user_store.create("testuser", "hash", email="test@example.com")
        uuid = doc_store.create("Old Doc", uid)
        old_date = (datetime.now() - timedelta(days=31)).isoformat()
        doc_store.update(uuid, deleted_at=old_date)

        task = EmptyTrashTask()
        result = task.run(db)

        assert result["status"] == "success"
        assert result["deleted_count"] == 1
        assert doc_store.retrieve(uuid) is None

    def test_empty_trash_task_ignores_recent_docs(self, db, doc_store, user_store, task_store):
        uid = user_store.create("testuser2", "hash", email="test2@example.com")
        uuid = doc_store.create("Recent Doc", uid)
        recent_date = (datetime.now() - timedelta(days=5)).isoformat()
        doc_store.update(uuid, deleted_at=recent_date)

        task = EmptyTrashTask()
        result = task.run(db)

        assert result["status"] == "success"
        assert result["deleted_count"] == 0
        assert doc_store.retrieve(uuid) is not None

    def test_task_scheduler_register_and_force_run(self, db, task_store):
        scheduler = TaskScheduler()
        scheduler.register_task(EmptyTrashTask())

        result = scheduler.force_run_task("document.empty_trash", db)
        assert result["status"] == "success"

        # Check that task record was created
        tasks = task_store.find_all()
        trash_task = next((t for t in tasks if t["task_key"] == "document.empty_trash"), None)
        assert trash_task is not None
        assert trash_task["last_run_status"] == "success"
        assert trash_task["last_run_at"] is not None

    def test_task_scheduler_force_run_unknown_task(self, db):
        scheduler = TaskScheduler()
        result = scheduler.force_run_task("unknown.task", db)
        assert result["status"] == "error"

    def test_periodic_task_store_find_all(self, db, task_store):
        db.execute(
            """INSERT INTO periodic_tasks (task_key, last_run_at, last_run_status)
               VALUES (?, ?, ?)""",
            ("task.a", datetime.now().isoformat(), "success"),
        )
        db.commit()

        tasks = task_store.find_all()
        assert len(tasks) == 1
        assert tasks[0]["task_key"] == "task.a"
        assert tasks[0]["last_run_status"] == "success"


class TestAdminPeriodicTaskAPI:
    """Tests for admin periodic task endpoints."""

    def test_list_periodic_tasks_requires_admin(self, client):
        response = client.get("/api/admin/periodic-tasks")
        assert response.status_code == 401

    def test_list_periodic_tasks(self, authed_client):
        response = authed_client.get("/api/admin/periodic-tasks")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert "tasks" in data

    def test_force_run_task_requires_admin(self, client):
        response = client.post("/api/admin/periodic-tasks/document.empty_trash/run")
        assert response.status_code == 401

    def test_force_run_task_success(self, authed_client):
        response = authed_client.post(
            "/api/admin/periodic-tasks/document.empty_trash/run"
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "success"

    def test_force_run_unknown_task(self, authed_client):
        response = authed_client.post(
            "/api/admin/periodic-tasks/nonexistent.task/run"
        )
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "error"


def _get_db_for_app(app):
    """Get database connection matching app config."""
    from oversolved.db import Database, SQLiteConnection, MariaDBConnection
    if app.config["DB_TYPE"] == "sqlite":
        return Database(SQLiteConnection(app.config.get("DB_PATH", ":memory:")))
    else:
        return Database(MariaDBConnection(
            host=app.config["DB_HOST"],
            user=app.config["DB_USER"],
            password=app.config["DB_PASSWORD"],
            database=app.config["DB_NAME"],
        ))
