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
            "SELECT id, username, password_hash, must_change_password, is_admin, is_active FROM users WHERE username = ?",
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
            "is_admin": bool(row[4]),
            "is_active": bool(row[5]),
        }

    def find_by_id(self, user_id: int) -> Optional[dict]:
        """Find a user by id."""
        cursor = self.db.execute(
            "SELECT id, username, must_change_password, is_admin, is_active, created_at FROM users WHERE id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "username": row[1],
            "must_change_password": bool(row[2]),
            "is_admin": bool(row[3]),
            "is_active": bool(row[4]),
            "created_at": row[5],
        }

    def update(self, user_id: int, **fields) -> bool:
        """Update user fields. Returns True if user was found and updated."""
        if not fields:
            return False
        allowed = {"username", "password_hash", "must_change_password", "is_admin", "is_active"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return False
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values())
        values.append(user_id)
        with self.db.transaction():
            cursor = self.db.execute(
                f"UPDATE users SET {set_clause} WHERE id = ?",
                tuple(values),
            )
            return cursor.rowcount > 0

    def delete(self, user_id: int) -> bool:
        """Delete user. Returns True if user was found and deleted."""
        with self.db.transaction():
            cursor = self.db.execute("DELETE FROM users WHERE id = ?", (user_id,))
            return cursor.rowcount > 0

    def list_all(self) -> list[dict]:
        """List all users (for admin). Returns list of user dicts without password_hash."""
        cursor = self.db.execute(
            "SELECT id, username, must_change_password, is_admin, is_active, created_at FROM users ORDER BY username"
        )
        return [
            {
                "id": row[0],
                "username": row[1],
                "must_change_password": bool(row[2]),
                "is_admin": bool(row[3]),
                "is_active": bool(row[4]),
                "created_at": row[5],
            }
            for row in cursor.fetchall()
        ]

    def set_active(self, user_id: int, active: bool) -> bool:
        """Set is_active flag. Returns True if user was found."""
        return self.update(user_id, is_active=1 if active else 0)

    def set_admin(self, user_id: int, admin: bool) -> bool:
        """Set is_admin flag. Returns True if user was found."""
        return self.update(user_id, is_admin=1 if admin else 0)

    def change_password(self, user_id: int, new_hash: str) -> bool:
        """Change user password. Returns True if user was found."""
        return self.update(user_id, password_hash=new_hash)


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

    def clone_document(self, uuid: str, new_owner_id: int, new_name: str) -> Optional[str]:
        """Clone a document with new owner. Returns new UUID or None if source not found."""
        doc = self.retrieve(uuid)
        if doc is None:
            return None
        new_uuid = secrets.token_urlsafe(16)
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id, preview_image) VALUES (?, ?, ?, ?, ?)",
                (new_uuid, new_name, doc["content"], new_owner_id, doc["preview_image"]),
            )
        return new_uuid

    def share_document(self, uuid: str, shared_with_user_id: int, permission: str = "view") -> None:
        """Create or update a share for a document."""
        with self.db.transaction():
            self.db.execute(
                """INSERT INTO document_shares (document_uuid, shared_with_user_id, permission)
                    VALUES (?, ?, ?)
                    ON CONFLICT(document_uuid, shared_with_user_id) DO UPDATE SET permission = excluded.permission""",
                (uuid, shared_with_user_id, permission),
            )

    def unshare_document(self, uuid: str, shared_with_user_id: int) -> None:
        """Remove a share for a document."""
        with self.db.transaction():
            self.db.execute(
                "DELETE FROM document_shares WHERE document_uuid = ? AND shared_with_user_id = ?",
                (uuid, shared_with_user_id),
            )

    def unshare_public(self, uuid: str) -> None:
        """Remove public link share for a document."""
        with self.db.transaction():
            self.db.execute(
                "DELETE FROM document_shares WHERE document_uuid = ? AND shared_with_user_id IS NULL",
                (uuid,),
            )

    def get_shares(self, uuid: str) -> list[dict]:
        """List all shares for a document, including usernames."""
        cursor = self.db.execute(
            """SELECT ds.id, ds.document_uuid, ds.shared_with_user_id, ds.permission, ds.created_at, u.username
               FROM document_shares ds
               LEFT JOIN users u ON ds.shared_with_user_id = u.id
               WHERE ds.document_uuid = ?""",
            (uuid,),
        )
        return [
            {
                "id": row[0],
                "document_uuid": row[1],
                "shared_with_user_id": row[2],
                "permission": row[3],
                "created_at": row[4],
                "username": row[5],
            }
            for row in cursor.fetchall()
        ]

    def set_public(self, uuid: str, is_public: bool) -> None:
        """Toggle public link sharing for a document."""
        with self.db.transaction():
            self.db.execute(
                "UPDATE documents SET is_public = ? WHERE uuid = ?",
                (1 if is_public else 0, uuid),
            )
            if is_public:
                self.db.execute(
                    """INSERT INTO document_shares (document_uuid, shared_with_user_id, permission)
                        VALUES (?, NULL, 'view')
                        ON CONFLICT(document_uuid, shared_with_user_id) DO NOTHING""",
                    (uuid,),
                )
            else:
                self.db.execute(
                    "DELETE FROM document_shares WHERE document_uuid = ? AND shared_with_user_id IS NULL",
                    (uuid,),
                )

    def has_permission(self, uuid: str, user_id: int, min_permission: str = "view") -> bool:
        """Check if user has permission to access a document."""
        doc = self.retrieve(uuid)
        if doc is None:
            return False
        if doc["owner_id"] == user_id:
            return True
        cursor = self.db.execute(
            "SELECT permission FROM document_shares WHERE document_uuid = ? AND (shared_with_user_id = ? OR shared_with_user_id IS NULL)",
            (uuid, user_id),
        )
        for row in cursor.fetchall():
            perm = row[0]
            if min_permission == "view" and perm in ("view", "edit"):
                return True
            if min_permission == "edit" and perm == "edit":
                return True
        return False

    def get_permission(self, uuid: str, user_id: int) -> Optional[str]:
        """Get the permission level for a user on a document. Returns 'owner', 'edit', 'view', or None."""
        doc = self.retrieve(uuid)
        if doc is None:
            return None
        if doc["owner_id"] == user_id:
            return "owner"
        cursor = self.db.execute(
            "SELECT permission FROM document_shares WHERE document_uuid = ? AND (shared_with_user_id = ? OR shared_with_user_id IS NULL)",
            (uuid, user_id),
        )
        for row in cursor.fetchall():
            return row[0]
        return None

    def get_owner_username(self, uuid: str) -> Optional[str]:
        """Get the username of the document owner."""
        cursor = self.db.execute(
            "SELECT u.username FROM documents d JOIN users u ON d.owner_id = u.id WHERE d.uuid = ?",
            (uuid,),
        )
        row = cursor.fetchone()
        return row[0] if row else None

    def list_owned_and_shared(self, user_id: int, sort: str = "name", include_shared: bool = True) -> list[dict]:
        """List documents owned by or shared with a user."""
        if sort == "modified":
            order = "updated_at DESC"
        else:
            order = "name"

        if include_shared:
            cursor = self.db.execute(
                f"""SELECT DISTINCT d.uuid, d.name, d.preview_image, d.created_at, d.updated_at, d.owner_id, u.username
                    FROM documents d
                    JOIN users u ON d.owner_id = u.id
                    LEFT JOIN document_shares ds ON d.uuid = ds.document_uuid
                    WHERE d.owner_id = ? OR (ds.shared_with_user_id = ? OR ds.shared_with_user_id IS NULL)
                    ORDER BY {order}""",
                (user_id, user_id),
            )
        else:
            cursor = self.db.execute(
                f"""SELECT d.uuid, d.name, d.preview_image, d.created_at, d.updated_at, d.owner_id, u.username
                    FROM documents d
                    JOIN users u ON d.owner_id = u.id
                    WHERE d.owner_id = ?
                    ORDER BY {order}""",
                (user_id,),
            )

        return [
            {
                "uuid": row[0],
                "name": row[1],
                "preview_image": row[2],
                "created_at": row[3],
                "updated_at": row[4],
                "is_owner": row[5] == user_id,
                "owner_username": row[6],
            }
            for row in cursor.fetchall()
        ]

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
