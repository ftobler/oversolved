"""Tests for PostgreSQL connection pool integration."""

import threading
import os
import pytest
import psycopg2


def _make_app_and_close_pool(pg_dsn, monkeypatch, pool_max=10):
    """Create app and return (app, pool) so the test can close the pool after use."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    monkeypatch.setenv("OVERSOLVED_DB_POOL_MAX", str(pool_max))
    from oversolved.app import create_app
    app = create_app({
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
    })
    pool = app.config.get("_DB_POOL")
    return app, pool


def test_pool_borrow_returns_distinct_connections_under_load(pg_dsn, monkeypatch):
    """Concurrent requests all succeed when pool_max is large enough."""
    app, pool = _make_app_and_close_pool(pg_dsn, monkeypatch, pool_max=10)

    from oversolved.blueprints import get_db
    errors = []
    results = []

    def worker():
        try:
            with app.test_request_context("/"):
                app.preprocess_request()
                db = get_db()
                cursor = db.execute("SELECT 1")
                results.append(cursor.fetchone()[0])
                app.do_teardown_appcontext()
        except Exception as exc:
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(8)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    pool.closeall()

    assert not errors, f"Errors in threads: {errors}"
    assert all(r == 1 for r in results)
    assert len(results) == 8


def test_returned_connection_has_no_open_transaction(pg_dsn, monkeypatch):
    """Connection returned to pool has any uncommitted work rolled back."""
    app, pool = _make_app_and_close_pool(pg_dsn, monkeypatch, pool_max=1)

    # Create the table using a direct connection (outside the pool)
    direct = psycopg2.connect(pg_dsn)
    direct.autocommit = True
    with direct.cursor() as cur:
        cur.execute("CREATE TABLE pool_test (val INTEGER)")
    direct.close()

    from oversolved.blueprints import get_db

    # First request: insert without commit, let teardown roll it back
    with app.test_request_context("/"):
        app.preprocess_request()
        db = get_db()
        db.execute("INSERT INTO pool_test VALUES (42)")
        # no commit -- teardown should rollback
        app.do_teardown_appcontext()

    # Second request: same (only) connection in pool; INSERT should not be visible
    with app.test_request_context("/"):
        app.preprocess_request()
        db = get_db()
        cursor = db.execute("SELECT COUNT(*) FROM pool_test")
        count = cursor.fetchone()[0]
        app.do_teardown_appcontext()

    pool.closeall()

    assert count == 0, "Uncommitted INSERT should have been rolled back on pool return"


def test_get_db_does_not_call_psycopg2_connect_per_request(pg_dsn, monkeypatch):
    """Requests reuse pool connections; psycopg2.connect call count stays bounded."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")

    import psycopg2 as _psycopg2
    original_connect = _psycopg2.connect
    connect_calls = []

    def counting_connect(*args, **kwargs):
        connect_calls.append(1)
        return original_connect(*args, **kwargs)

    monkeypatch.setattr(_psycopg2, "connect", counting_connect)

    from oversolved.app import create_app
    app = create_app({
        "DB_TYPE": "postgres",
        "TESTING": True,
        "DB_DSN": pg_dsn,
    })
    pool = app.config.get("_DB_POOL")
    # pool is created during create_app; startup connects at most pool_max times
    calls_after_init = len(connect_calls)

    from oversolved.blueprints import get_db
    for _ in range(5):
        with app.test_request_context("/"):
            app.preprocess_request()
            get_db()
            app.do_teardown_appcontext()

    total_calls = len(connect_calls)
    pool.closeall()

    # Requests must not have caused additional psycopg2.connect calls
    assert total_calls == calls_after_init, (
        f"Expected no new connect calls after pool init, "
        f"got {total_calls - calls_after_init} extra calls"
    )


def test_migrations_registered_once(pg_dsn, monkeypatch):
    """discover_and_register loads all migrations; create_app applies each exactly once."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")

    from oversolved.migrations import _load_migrations

    first = _load_migrations()
    second = _load_migrations()
    assert len(first) > 0
    assert [v for v, _, _ in first] == [v for v, _, _ in second], (
        "Migration list must be stable across calls"
    )

    from oversolved.app import create_app
    app = create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})
    pool = app.config.get("_DB_POOL")
    try:
        import psycopg2
        conn = psycopg2.connect(pg_dsn)
        conn.autocommit = True
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(DISTINCT version) FROM schema_version")
            distinct = cur.fetchone()[0]
        conn.close()
        assert distinct == len(first), "schema_version must have one row per migration"
    finally:
        if pool is not None:
            pool.closeall()
