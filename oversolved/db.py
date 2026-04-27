"""Database abstraction layer supporting SQLite and MariaDB."""

import sqlite3
import secrets
import contextlib
from datetime import datetime, timedelta, timezone
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
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            )
        """)
        self.conn.commit()

        cursor = self.conn.execute("SELECT MAX(version) FROM schema_version")
        row = cursor.fetchone()
        self._version = row[0] if row[0] is not None else 0

        for version, name, func in self._migrations:
            if version > self._version:
                try:
                    func(self)
                    self.conn.execute(
                        "INSERT INTO schema_version (version, name) VALUES (?, ?)",
                        (version, name),
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


class UserStore:
    """User management."""

    def __init__(self, db: Database):
        self.db = db

    def create(
        self, username: str, password_hash: str, must_change_password: bool = False
    ) -> int:
        """Create a user and return its id."""
        with self.db.transaction():
            cursor = self.db.execute(
                "INSERT INTO users (username, password_hash, must_change_password) VALUES (?, ?, ?)",
                (username, password_hash, 1 if must_change_password else 0),
            )
            return cursor.lastrowid

    def find_by_username(self, username: str) -> Optional[dict]:
        """Find a user by username."""
        cursor = self.db.execute(
            "SELECT id, username, password_hash, must_change_password FROM users WHERE username = ?",
            (username,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "username": row[1],
            "password_hash": row[2],
            "must_change_password": bool(row[3]),
        }

    def find_by_id(self, user_id: int) -> Optional[dict]:
        """Find a user by id."""
        cursor = self.db.execute(
            "SELECT id, username, must_change_password FROM users WHERE id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "username": row[1],
            "must_change_password": bool(row[2]),
        }


class SessionStore:
    """Session management."""

    SESSION_DURATION = timedelta(days=30)

    def __init__(self, db: Database):
        self.db = db

    def create(self, user_id: int) -> str:
        """Create a session and return the token."""
        token = secrets.token_urlsafe(32)
        expires_at = (datetime.now(timezone.utc) + self.SESSION_DURATION).isoformat()
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)",
                (token, user_id, expires_at),
            )
        return token

    def find(self, token: str) -> Optional[dict]:
        """Find a valid (non-expired) session."""
        cursor = self.db.execute(
            "SELECT token, user_id, expires_at FROM sessions WHERE token = ?", (token,)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        expires_at = datetime.fromisoformat(row[2])
        if datetime.now(timezone.utc) >= expires_at:
            return None
        return {"token": row[0], "user_id": row[1], "expires_at": row[2]}

    def delete(self, token: str) -> None:
        """Delete a session (logout)."""
        with self.db.transaction():
            self.db.execute("DELETE FROM sessions WHERE token = ?", (token,))

    def cleanup_expired(self) -> None:
        """Remove expired sessions."""
        now = datetime.now(timezone.utc).isoformat()
        with self.db.transaction():
            self.db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))


class DocumentStore:
    """Store and retrieve YAML documents."""

    def __init__(self, db: Database):
        self.db = db

    def create(self, name: str, owner_id: int) -> str:
        """Create a new document and return its UUID."""
        uuid = secrets.token_urlsafe(16)
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id) VALUES (?, ?, ?, ?)",
                (uuid, name, "", owner_id),
            )
        return uuid

    def create_with_uuid(self, uuid: str, name: str, owner_id: int) -> None:
        """Create a new document with a specific UUID."""
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id) VALUES (?, ?, ?, ?)",
                (uuid, name, "", owner_id),
            )

    def store_content(self, uuid: str, content: str) -> None:
        """Update document content."""
        now = datetime.now(timezone.utc).isoformat()
        with self.db.transaction():
            self.db.execute(
                "UPDATE documents SET content = ?, updated_at = ? WHERE uuid = ?",
                (content, now, uuid),
            )

    def store_preview_image(self, uuid: str, image_data: bytes) -> None:
        """Update document preview image."""
        now = datetime.now(timezone.utc).isoformat()
        with self.db.transaction():
            self.db.execute(
                "UPDATE documents SET preview_image = ?, updated_at = ? WHERE uuid = ?",
                (image_data, now, uuid),
            )

    def rename(self, uuid: str, name: str) -> bool:
        """Rename a document. Returns True if found."""
        now = datetime.now(timezone.utc).isoformat()
        with self.db.transaction():
            cursor = self.db.execute(
                "UPDATE documents SET name = ?, updated_at = ? WHERE uuid = ?",
                (name, now, uuid),
            )
            return cursor.rowcount > 0

    def retrieve(self, uuid: str) -> Optional[dict]:
        """Retrieve a document by UUID."""
        cursor = self.db.execute(
            "SELECT uuid, name, content, owner_id, preview_image, created_at, updated_at FROM documents WHERE uuid = ?",
            (uuid,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            "uuid": row[0],
            "name": row[1],
            "content": row[2],
            "owner_id": row[3],
            "preview_image": row[4],
            "created_at": row[5],
            "updated_at": row[6],
        }

    def delete(self, uuid: str) -> bool:
        """Delete a document by UUID. Returns True if deleted."""
        with self.db.transaction():
            cursor = self.db.execute("DELETE FROM documents WHERE uuid = ?", (uuid,))
            return cursor.rowcount > 0

    def duplicate(self, uuid: str, new_name: str) -> Optional[str]:
        """Duplicate a document with a new name. Returns new UUID or None if source not found."""
        doc = self.retrieve(uuid)
        if doc is None:
            return None
        new_uuid = secrets.token_urlsafe(16)
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id, preview_image) VALUES (?, ?, ?, ?, ?)",
                (new_uuid, new_name, doc["content"], doc["owner_id"], doc["preview_image"]),
            )
        return new_uuid

    def list_by_owner(self, owner_id: int, sort: str = "name") -> list[dict]:
        """List all documents for an owner."""
        if sort == "modified":
            order = "updated_at DESC"
        else:
            order = "name"
        cursor = self.db.execute(
            f"SELECT uuid, name, preview_image, created_at, updated_at FROM documents WHERE owner_id = ? ORDER BY {order}",
            (owner_id,),
        )
        return [
            {"uuid": row[0], "name": row[1], "preview_image": row[2], "created_at": row[3], "updated_at": row[4]}
            for row in cursor.fetchall()
        ]
