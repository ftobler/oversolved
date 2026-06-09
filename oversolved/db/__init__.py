"""Database abstraction layer supporting SQLite and PostgreSQL."""

from oversolved.db.connection import DatabaseConnection, SQLiteConnection, PostgreSQLConnection
from oversolved.db.migrations import Database
from oversolved.db.users import AccountStore, UserStore
from oversolved.db.sessions import SessionStore
from oversolved.db.documents import DocumentStore
from oversolved.db.periodic import PeriodicTaskStore
from oversolved.db.rebuild_times import RebuildTimeStore


def create_database(db_type: str, dsn: str | None = None, path: str | None = None) -> Database:
    """Build a Database from a connection type and its parameters.

    Single source of truth for the postgres/sqlite connection selection shared
    by the Flask app (startup and per-request) and the CLI. Does not register
    migrations or call init(); the caller decides whether to do that.
    """
    conn: DatabaseConnection
    if db_type == "postgres":
        if dsn is None:
            raise ValueError("postgres database requires a dsn")
        conn = PostgreSQLConnection(dsn)
    elif db_type == "sqlite":
        if path is None:
            raise ValueError("sqlite database requires a path")
        conn = SQLiteConnection(path)
    else:
        raise ValueError(f"Unknown database type: {db_type}")
    return Database(conn)


__all__ = [
    "DatabaseConnection",
    "SQLiteConnection",
    "PostgreSQLConnection",
    "Database",
    "create_database",
    "AccountStore",
    "UserStore",
    "SessionStore",
    "DocumentStore",
    "PeriodicTaskStore",
    "RebuildTimeStore",
]
