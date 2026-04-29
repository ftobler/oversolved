"""Tests for rebuild timing tracking and stats endpoint."""

import json
import pytest

from solver_helpers import extrude_spec, rect_sketch_spec


def post_solve(client, payload):
    return client.post(
        "/api/solve",
        data=json.dumps(payload),
        content_type="application/json",
    )


@pytest.fixture
def app(tmp_path):
    from oversolved.app import create_app

    test_app = create_app({
        "DB_TYPE": "sqlite",
        "TESTING": True,
        "DB_PATH": str(tmp_path / "test.db"),
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
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        # Create a document
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "RebuildTest"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        # Solve with doc id
        r1 = post_solve(authed_client, {"id": doc_id, "features": [sk1, ex1]})
        assert r1.status_code == 200
        d1 = json.loads(r1.data)
        assert "solve_ms" in d1

        # Check stats
        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 1
        assert stats["last_duration_ms"] == round(d1["solve_ms"])
        assert stats["average_ms"] == round(d1["solve_ms"])
        assert stats["median_ms"] == round(d1["solve_ms"])

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
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Last20"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        for _ in range(25):
            post_solve(authed_client, {"id": doc_id, "features": [sk1, ex1]})

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 20
        assert len(stats["history"]) == 20

    def test_rebuild_stats_trend_faster(self, authed_client):
        pytest.importorskip("OCP.gp")

        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TrendFaster"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        # Seed 10 entries with decreasing duration_ms
        db = authed_client.application.extensions.get("db")
        # Access db via the app's get_db or direct connection
        # Since we need to insert directly, let's use the app's db
        from oversolved.db import SQLiteConnection, Database
        db_path = authed_client.application.config["DB_PATH"]
        db = Database(SQLiteConnection(db_path))

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
        pytest.importorskip("OCP.gp")
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TrendSlower"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        from oversolved.db import SQLiteConnection, Database
        db_path = authed_client.application.config["DB_PATH"]
        db = Database(SQLiteConnection(db_path))

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
        pytest.importorskip("OCP.gp")
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "TrendStable"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        from oversolved.db import SQLiteConnection, Database
        db_path = authed_client.application.config["DB_PATH"]
        db = Database(SQLiteConnection(db_path))

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
        pytest.importorskip("OCP.gp")
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "AccessControl"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        # Unauthenticated client should get 401
        stats_resp = client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 401

    def test_rebuild_stats_not_found(self, authed_client):
        stats_resp = authed_client.get("/api/documents/nonexistent/rebuild-stats")
        assert stats_resp.status_code == 404

    def test_multiple_rebuilds_accumulate(self, authed_client):
        pytest.importorskip("OCP.gp")
        sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
        ex1 = extrude_spec("sk1", "ex1", distance=5.0)

        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Accumulate"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        for _ in range(5):
            post_solve(authed_client, {"id": doc_id, "features": [sk1, ex1]})

        stats_resp = authed_client.get(f"/api/documents/{doc_id}/rebuild-stats")
        assert stats_resp.status_code == 200
        stats = json.loads(stats_resp.data)
        assert stats["rebuild_count"] == 5
        assert len(stats["history"]) == 5

    def test_stat_calculations_correct(self, authed_client):
        pytest.importorskip("OCP.gp")
        create_resp = authed_client.post(
            "/api/documents",
            data=json.dumps({"name": "Calculations"}),
            content_type="application/json",
        )
        doc_id = json.loads(create_resp.data)["uuid"]

        from oversolved.db import SQLiteConnection, Database
        db_path = authed_client.application.config["DB_PATH"]
        db = Database(SQLiteConnection(db_path))

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
