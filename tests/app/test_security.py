"""Tests for security hardening (zip bomb protection, upload limits)."""

import io
import zipfile
import pytest


@pytest.fixture
def admin_client(tmp_path, monkeypatch):
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    from oversolved.app import create_app
    db_path = str(tmp_path / "test_security.db")
    app = create_app({
        "DB_TYPE": "sqlite",
        "TESTING": True,
        "DB_PATH": db_path,
    })
    client = app.test_client()

    resp = client.post(
        "/api/auth/login",
        data='{"username": "admin", "password": "admin"}',
        content_type="application/json",
    )
    assert resp.status_code == 200
    return client


class TestZipBombProtection:
    """Tests for zip bomb protection in import_backup."""

    def _make_zip_with_count(self, count):
        """Create a zip file with a given number of empty entries."""
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            for i in range(count):
                zf.writestr(f"user{i}/doc{i}.yaml", "content: dummy\n")
        buf.seek(0)
        return buf

    def test_import_backup_rejects_too_many_entries(self, admin_client, tmp_path):
        buf = self._make_zip_with_count(10001)
        resp = admin_client.post(
            "/api/admin/import-backup",
            data={"file": (buf, "many_files.zip")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400
        data = resp.get_json()
        assert "too many" in data.get("error", "").lower()

    def test_import_backup_rejects_large_decompressed(self, admin_client, tmp_path):
        buf = io.BytesIO()
        large_content = b"x" * (600 * 1024 * 1024)
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("user/doc.yaml", large_content)
        buf.seek(0)
        resp = admin_client.post(
            "/api/admin/import-backup",
            data={"file": (buf, "large_bomb.zip")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400
        data = resp.get_json()
        assert "too large" in data.get("error", "").lower()

    def test_valid_small_backup_import_works(self, admin_client, tmp_path):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("admin/test_doc.yaml", "name: test\ndescription: hello\n")
        buf.seek(0)
        resp = admin_client.post(
            "/api/admin/import-backup",
            data={"file": (buf, "valid_backup.zip")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["status"] == "imported"
        assert data["imported_count"] >= 1


class TestMaxContentLength:
    """Tests for MAX_CONTENT_LENGTH protection."""

    def test_upload_rejects_over_limit(self, tmp_path, monkeypatch):
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        db_path = str(tmp_path / "test_upload_limit.db")
        app = create_app({
            "DB_TYPE": "sqlite",
            "TESTING": True,
            "DB_PATH": db_path,
        })
        client = app.test_client()

        resp = client.post(
            "/api/auth/login",
            data='{"username": "admin", "password": "admin"}',
            content_type="application/json",
        )
        assert resp.status_code == 200

        big_data = b"x" * (101 * 1024 * 1024)
        resp = client.post(
            "/api/upload",
            data={"file": (io.BytesIO(big_data), "large.step")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 413

    def test_import_backup_rejects_over_limit(self, admin_client):
        buf = io.BytesIO(b"x" * (101 * 1024 * 1024))
        resp = admin_client.post(
            "/api/admin/import-backup",
            data={"file": (buf, "large.zip")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 413

    def test_import_backup_empty_zip(self, admin_client):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, 'w', zipfile.ZIP_DEFLATED):
            pass
        buf.seek(0)
        resp = admin_client.post(
            "/api/admin/import-backup",
            data={"file": (buf, "empty.zip")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 200
        data = resp.get_json()
        assert data["imported_count"] == 0

    def test_import_backup_corrupt_zip(self, admin_client):
        buf = io.BytesIO(b"not a zip file")
        resp = admin_client.post(
            "/api/admin/import-backup",
            data={"file": (buf, "corrupt.zip")},
            content_type="multipart/form-data",
        )
        assert resp.status_code == 400
        data = resp.get_json()
        assert "invalid zip" in data.get("error", "").lower()
