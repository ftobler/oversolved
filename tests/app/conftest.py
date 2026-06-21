"""Shared test fixtures for Flask app tests."""

import json
import os
import uuid
import pytest
import psycopg2
from urllib.parse import urlparse, urlunparse

from oversolved.app import create_app

_DEFAULT_BASE_DSN = "postgresql://oversolved:oversolved@localhost:5432/oversolved"
_BASE_DSN = os.environ.get("TEST_DB_DSN", _DEFAULT_BASE_DSN)


def _admin_dsn(base: str) -> str:
    """Return a DSN pointing to the postgres maintenance database."""
    return urlunparse(urlparse(base)._replace(path="/postgres"))


def _with_dbname(base: str, name: str) -> str:
    return urlunparse(urlparse(base)._replace(path=f"/{name}"))


@pytest.fixture
def pg_dsn():
    """Provide an isolated PostgreSQL database for each test, dropped afterwards."""
    test_db = f"test_{uuid.uuid4().hex}"
    admin = _admin_dsn(_BASE_DSN)

    conn = psycopg2.connect(admin)
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute(f"CREATE DATABASE {test_db}")
    conn.close()

    dsn = _with_dbname(_BASE_DSN, test_db)
    yield dsn

    conn = psycopg2.connect(admin)
    conn.autocommit = True
    with conn.cursor() as cur:
        # Terminate any remaining connections so DROP DATABASE succeeds.
        cur.execute(
            "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
            "WHERE datname = %s AND pid <> pg_backend_pid()",
            (test_db,),
        )
        cur.execute(f"DROP DATABASE {test_db}")
    conn.close()


@pytest.fixture
def app(pg_dsn, monkeypatch):
    """Create a test Flask app backed by a fresh PostgreSQL database."""
    monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
    return create_app(
        {
            "DB_TYPE": "postgres",
            "TESTING": True,
            "DB_DSN": pg_dsn,
        }
    )


@pytest.fixture
def client(app):
    """Create an unauthenticated test client."""
    return app.test_client()


@pytest.fixture
def authed_client(app):
    """Create a test client logged in as admin."""
    client = app.test_client()
    response = client.post(
        "/api/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}),
        content_type="application/json",
    )
    assert response.status_code == 200
    return client
