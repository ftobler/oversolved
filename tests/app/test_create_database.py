"""Tests for the create_database factory: connection selection and validation."""

import pytest

import oversolved.db as db_package
from oversolved.db import create_database, Database, SQLiteConnection


def test_sqlite_builds_database_without_migrations():
    """sqlite type builds a Database wrapping a SQLiteConnection, no init() called."""
    db = create_database("sqlite", path=":memory:")
    assert isinstance(db, Database)
    assert isinstance(db.conn, SQLiteConnection)


def test_postgres_builds_database(monkeypatch):
    """postgres type wires the dsn into a PostgreSQLConnection without connecting."""
    built = {}

    class FakePostgres:
        def __init__(self, dsn):
            built["dsn"] = dsn

    # create_database resolves PostgreSQLConnection via the db package namespace.
    monkeypatch.setattr(db_package, "PostgreSQLConnection", FakePostgres)
    db = create_database("postgres", dsn="postgresql://example/db")
    assert isinstance(db, Database)
    assert isinstance(db.conn, FakePostgres)
    assert built["dsn"] == "postgresql://example/db"


def test_postgres_without_dsn_raises():
    with pytest.raises(ValueError, match="postgres database requires a dsn"):
        create_database("postgres")


def test_sqlite_without_path_raises():
    with pytest.raises(ValueError, match="sqlite database requires a path"):
        create_database("sqlite")


def test_unknown_type_raises():
    with pytest.raises(ValueError, match="Unknown database type: mysql"):
        create_database("mysql")
