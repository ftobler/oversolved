"""Shared test fixtures for Flask app tests."""

import os
import uuid
import pytest
import psycopg2
from urllib.parse import urlparse, urlunparse

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
