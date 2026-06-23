"""Tests for document trash and periodic task system."""

import json
import pytest
from datetime import datetime, timedelta, timezone
from oversolved.db import (
    Database,
    PostgreSQLConnection,
    DocumentStore,
    UserStore,
    PeriodicTaskStore,
)
from oversolved.periodic_tasks import TaskScheduler, EmptyTrashTask, _cron_next
from .dbutil import make_db as _make_db


@pytest.fixture
def db(pg_dsn):
    database = _make_db(pg_dsn)
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
            old_date = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
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

    def test_recover_with_naive_deleted_at(self, authed_client):
        """Regression: recover_document must handle old naive +00:00 free deleted_at strings."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "NaiveDelete"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Simulate old-style naive deleted_at (no timezone suffix)
        from oversolved.db import DocumentStore
        from flask import g
        with authed_client.application.app_context():
            g.db = _get_db_for_app(authed_client.application)
            old_date = (datetime.now(timezone.utc) - timedelta(hours=1)).replace(tzinfo=None).isoformat()
            assert "+" not in old_date  # must be naive
            DocumentStore(g.db).update(uuid, deleted_at=old_date)

        # Recover must not throw TypeError from naive/aware mismatch
        response = authed_client.post(f"/api/documents/{uuid}/recover")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "recovered"

    def test_recover_with_aware_datetime(self, authed_client):
        """Regression: recover_document must not crash with +00:00 suffix in deleted_at."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "AwareDelete"}),
            content_type="application/json",
        )
        uuid = json.loads(create_resp.data)["uuid"]

        # Soft-delete (now stores aware UTC)
        delete_resp = authed_client.delete(f"/api/documents/{uuid}")
        assert delete_resp.status_code == 200
        assert "+00:00" in json.loads(delete_resp.data)["deleted_at"]

        # Recover must not throw TypeError
        response = authed_client.post(f"/api/documents/{uuid}/recover")
        assert response.status_code == 200
        data = json.loads(response.data)
        assert data["status"] == "recovered"


class TestPeriodicTasks:
    """Tests for periodic task framework."""

    def test_cron_parser_daily(self):
        now = datetime.now(timezone.utc)
        next_run = _cron_next("0 2 * * *", now)
        assert next_run.hour == 2
        assert next_run.minute == 0
        assert next_run > now or (next_run.day == now.day and next_run.hour >= 2)

    def test_empty_trash_task_deletes_old_docs(self, db, doc_store, user_store, task_store):
        uid = user_store.create("testuser", "hash", email="test@example.com")
        uuid = doc_store.create("Old Doc", uid)
        old_date = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        doc_store.update(uuid, deleted_at=old_date)

        task = EmptyTrashTask()
        result = task.run(db)

        assert result["status"] == "success"
        assert result["deleted_count"] == 1
        assert doc_store.retrieve(uuid) is None

    def test_empty_trash_task_ignores_recent_docs(self, db, doc_store, user_store, task_store):
        uid = user_store.create("testuser2", "hash", email="test2@example.com")
        uuid = doc_store.create("Recent Doc", uid)
        recent_date = (datetime.now(timezone.utc) - timedelta(days=5)).isoformat()
        doc_store.update(uuid, deleted_at=recent_date)

        task = EmptyTrashTask()
        result = task.run(db)

        assert result["status"] == "success"
        assert result["deleted_count"] == 0
        assert doc_store.retrieve(uuid) is not None

    def test_empty_trash_task_partial_on_delete_error(
        self, db, doc_store, user_store, task_store, monkeypatch
    ):
        """If a permanent delete fails, the doc is reported in errors and the
        overall status degrades to 'partial' instead of raising."""
        uid = user_store.create("testuser3", "hash", email="test3@example.com")
        uuid = doc_store.create("Doomed Doc", uid)
        old_date = (datetime.now(timezone.utc) - timedelta(days=31)).isoformat()
        doc_store.update(uuid, deleted_at=old_date)

        def _boom(self, doc_uuid):
            raise RuntimeError("delete blew up")

        monkeypatch.setattr(DocumentStore, "permanently_delete", _boom)

        result = EmptyTrashTask().run(db)
        assert result["status"] == "partial"
        assert result["deleted_count"] == 0
        assert len(result["errors"]) == 1
        assert result["errors"][0]["uuid"] == uuid
        assert "delete blew up" in result["errors"][0]["error"]

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
            ("task.a", datetime.now(timezone.utc).isoformat(), "success"),
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
    return Database(PostgreSQLConnection(app.config["DB_DSN"]))
