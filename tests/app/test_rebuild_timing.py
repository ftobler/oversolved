"""Tests for rebuild timing tracking and stats endpoint."""

import json
import pytest
from oversolved.db import PostgreSQLConnection, Database


def _get_db(app):
    """Get a direct DB connection from the app config."""
    db = Database(PostgreSQLConnection(app.config["DB_DSN"]))
    db.init()
    return db


@pytest.fixture
def app(pg_dsn, monkeypatch):
    from oversolved.app import create_app

    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    test_app = create_app({
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
    })
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


class TestRebuildTimeTracking:
    def test_track_rebuild_time(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "RebuildTest"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        db.execute(
            """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
               VALUES (?, ?, ?)""",
            (doc_id, 123, 2),
        )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 1
        assert stats["last_duration_ms"] == 123
        assert stats["average_ms"] == 123.0
        assert stats["median_ms"] == 123.0

    def test_rebuild_stats_endpoint_empty(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "EmptyStats"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 0
        assert stats["last_duration_ms"] is None
        assert stats["average_ms"] is None
        assert stats["history"] == []

    def test_rebuild_stats_last_20(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Last20"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        for _ in range(25):
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, 100, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 25
        assert len(stats["history"]) == 20

    def test_rebuild_stats_trend_faster(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TrendFaster"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        for i in range(10):
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, 1000 - i * 50, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["trend"] == "faster"

    def test_rebuild_stats_trend_slower(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TrendSlower"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        for i in range(10):
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, 500 + i * 50, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["trend"] == "slower"

    def test_rebuild_stats_trend_stable(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TrendStable"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        for i in range(10):
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, 500 + (i % 3) * 10, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["trend"] == "stable"

    def test_rebuild_stats_access_control(self, authed_client, client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "AccessControl"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        stats_resp = client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 401

    def test_rebuild_stats_not_found(self, authed_client):
        stats_resp = authed_client.get("/api/documents/nonexistent/rebuild-stats")
        assert stats_resp.status_code == 404

    def test_multiple_rebuilds_accumulate(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Accumulate"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        for _ in range(5):
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, 100, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 5
        assert len(stats["history"]) == 5

    def test_stat_average_is_float(self, authed_client):
        """Average should be a float (not integer division)."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "FloatAvg"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        durations = [101, 202, 303]
        for d in durations:
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, d, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        expected_avg = sum(durations) / len(durations)
        assert stats["average_ms"] == expected_avg
        assert isinstance(stats["average_ms"], float)

    def test_median_is_float_for_even_count(self, authed_client):
        """Median should be float for even number of values."""
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "MedFloat"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        durations = [100, 200, 300, 400]
        for d in durations:
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, d, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["median_ms"] == 250.0
        assert isinstance(stats["median_ms"], float)

    def test_stat_calculations_correct(self, authed_client):
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Calculations"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        db = _get_db(authed_client.application)
        durations = [100, 200, 300, 400, 500]
        for d in durations:
            db.execute(
                """INSERT INTO rebuild_times (document_uuid, duration_ms, feature_count)
                   VALUES (?, ?, ?)""",
                (doc_id, d, 2),
            )
        db.commit()

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["average_ms"] == 300
        assert stats["median_ms"] == 300
        assert stats["min_ms"] == 100
        assert stats["max_ms"] == 500
