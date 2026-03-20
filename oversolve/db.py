"""Database abstraction layer supporting SQLite and MariaDB."""

import sqlite3
import contextlib
from typing import Any, Optional, Callable
from abc import ABC, abstractmethod


class DatabaseConnection(ABC):
    """Abstract base for database connections."""

    @abstractmethod
    def execute(self, query: str, params: tuple = ()) -> Any:
        """Execute a query and return cursor."""
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
        self.conn = sqlite3.connect(db_path)
        self.conn.row_factory = sqlite3.Row

    def execute(self, query: str, params: tuple = ()) -> Any:
        return self.conn.execute(query, params)

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


class MariaDBConnection(DatabaseConnection):
    """MariaDB connection wrapper using PyMySQL."""

    def __init__(self, host: str, user: str, password: str, database: str):
        import pymysql
        self.conn = pymysql.connect(
            host=host,
            user=user,
            password=password,
            database=database,
            autocommit=False,
        )

    def execute(self, query: str, params: tuple = ()) -> Any:
        cursor = self.conn.cursor()
        cursor.execute(query, params)
        return cursor

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()

    def close(self) -> None:
        self.conn.close()


class Database:
    """Database manager with migrations support."""

    def __init__(self, connection: DatabaseConnection):
        self.conn = connection
        self._migrations: list[tuple[int, str, Callable]] = []
        self._version = 0

    def register_migration(self, version: int, name: str, func: Callable) -> None:
        """Register a migration function."""
        self._migrations.append((version, name, func))
        self._migrations.sort(key=lambda x: x[0])

    def init(self) -> None:
        """Initialize database and run pending migrations."""
        # Create schema_version table if it doesn't exist
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            )
        """)
        self.conn.commit()

        # Get current version
        cursor = self.conn.execute("SELECT MAX(version) FROM schema_version")
        row = cursor.fetchone()
        self._version = row[0] if row[0] is not None else 0

        # Run pending migrations
        for version, name, func in self._migrations:
            if version > self._version:
                try:
                    func(self)
                    self.conn.execute(
                        "INSERT INTO schema_version (version, name) VALUES (?, ?)",
                        (version, name)
                    )
                    self.conn.commit()
                    self._version = version
                except Exception:
                    self.conn.rollback()
                    raise

    def execute(self, query: str, params: tuple = ()) -> Any:
        """Execute a query."""
        return self.conn.execute(query, params)

    def commit(self) -> None:
        """Commit transaction."""
        self.conn.commit()

    def rollback(self) -> None:
        """Rollback transaction."""
        self.conn.rollback()

    def close(self) -> None:
        """Close connection."""
        self.conn.close()

    @contextlib.contextmanager
    def transaction(self):
        """Context manager for transactions."""
        try:
            yield self
            self.commit()
        except Exception:
            self.rollback()
            raise


class DocumentStore:
    """Store and retrieve YAML documents."""

    def __init__(self, db: Database):
        self.db = db

    def store(self, doc_id: str, yaml_content: str) -> None:
        """Store a YAML document."""
        with self.db.transaction():
            cursor = self.db.execute(
                "SELECT id FROM documents WHERE id = ?",
                (doc_id,)
            )
            exists = cursor.fetchone() is not None

            if exists:
                self.db.execute(
                    "UPDATE documents SET content = ? WHERE id = ?",
                    (yaml_content, doc_id)
                )
            else:
                self.db.execute(
                    "INSERT INTO documents (id, content) VALUES (?, ?)",
                    (doc_id, yaml_content)
                )

    def retrieve(self, doc_id: str) -> Optional[str]:
        """Retrieve a YAML document by ID."""
        cursor = self.db.execute(
            "SELECT content FROM documents WHERE id = ?",
            (doc_id,)
        )
        row = cursor.fetchone()
        return row[0] if row else None

    def delete(self, doc_id: str) -> bool:
        """Delete a document by ID. Returns True if deleted, False if not found."""
        with self.db.transaction():
            cursor = self.db.execute(
                "DELETE FROM documents WHERE id = ?",
                (doc_id,)
            )
            return cursor.rowcount > 0

    def list_ids(self) -> list[str]:
        """List all document IDs."""
        cursor = self.db.execute("SELECT id FROM documents ORDER BY id")
        return [row[0] for row in cursor.fetchall()]
