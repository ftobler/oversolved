"""Database connection abstractions for SQLite and PostgreSQL."""

from typing import Any
from abc import ABC, abstractmethod


class DatabaseConnection(ABC):
    """Abstract base for database connections."""

    @abstractmethod
    def execute(self, query: str, params: tuple = ()) -> Any:
        """Execute a query and return cursor."""
        pass

    @abstractmethod
    def insert_returning_id(self, query: str, params: tuple = ()) -> int:
        """Execute an INSERT and return the auto-generated row ID."""
        pass

    @abstractmethod
    def commit(self) -> None:
        """Commit transaction."""
        pass

    @abstractmethod
    def rollback(self) -> None:
        """Rollback transaction."""
        pass

    @abstractmethod
    def close(self) -> None:
        """Close connection."""
        pass


class SQLiteConnection(DatabaseConnection):
    """SQLite connection wrapper."""

    def __init__(self, db_path: str = ":memory:"):
        import sqlite3
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row

    def execute(self, query: str, params: tuple = ()) -> Any:
        return self.conn.execute(query, params)

    def insert_returning_id(self, query: str, params: tuple = ()) -> int:
        cursor = self.conn.execute(query, params)
        assert cursor.lastrowid is not None
        return cursor.lastrowid

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


class PostgreSQLConnection(DatabaseConnection):
    """PostgreSQL connection wrapper using psycopg2.

    Translates ? placeholders to %s automatically so query strings stay consistent
    with the SQLite convention used throughout the codebase.
    """

    def __init__(self, dsn: str):
        import psycopg2
        self.conn = psycopg2.connect(dsn)
        self.conn.autocommit = False
        self._is_pool_conn = False

    @classmethod
    def from_pool(cls, raw_conn: Any) -> "PostgreSQLConnection":
        """Wrap an already-open borrowed pool connection."""
        instance = cls.__new__(cls)
        instance.conn = raw_conn
        instance._is_pool_conn = True
        return instance

    def _translate(self, query: str) -> str:
        return query.replace("?", "%s")

    def execute(self, query: str, params: tuple = ()) -> Any:
        import psycopg2.extras
        cursor = self.conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cursor.execute(self._translate(query), params)
        return cursor

    def insert_returning_id(self, query: str, params: tuple = ()) -> int:
        import psycopg2.extras
        cursor = self.conn.cursor(cursor_factory=psycopg2.extras.DictCursor)
        cursor.execute(self._translate(query) + " RETURNING id", params)
        return cursor.fetchone()[0]

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        if self._is_pool_conn:
            return  # pool manages connection lifetime; caller returns it via putconn
        self.conn.close()
