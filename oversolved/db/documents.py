"""Document store implementation."""

import uuid as uuid_mod
from datetime import datetime

from oversolved.db._time import _now
from oversolved.db.migrations import Database


def _to_bytes(value: object) -> bytes | None:
    """Normalize BYTEA values: psycopg2 returns memoryview, sqlite returns bytes."""
    if value is None:
        return None
    if isinstance(value, memoryview):
        return bytes(value)
    return value  # type: ignore[return-value]


class DocumentStore:
    """Store and retrieve YAML documents."""

    _SORT_ORDERS = {
        "modified": "d.updated_at DESC",
        "modified_asc": "d.updated_at ASC",
    }

    def __init__(self, db: Database):
        self.db = db

    def create(self, name: str, owner_id: int, is_public: bool = False) -> str:
        """Create a new document and return its UUID."""
        uuid = uuid_mod.uuid4().hex
        now = _now()
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (uuid, name, "", owner_id, 1 if is_public else 0, now, now),
            )
        return uuid

    def import_document(self, name: str, owner_id: int, content: str) -> str:
        """Create a document together with its content and return its UUID.

        Import must never leave a committed empty-content row behind, so name and
        content land in one INSERT inside a single transaction instead of the
        create()/store_content() pair, which commits twice.
        """
        uuid = uuid_mod.uuid4().hex
        now = _now()
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (uuid, name, content, owner_id, 0, now, now),
            )
        return uuid

    def store_content(self, uuid: str, content: str) -> None:
        """Update document content."""
        now = _now()
        with self.db.transaction():
            self.db.execute(
                "UPDATE documents SET content = ?, updated_at = ? WHERE uuid = ?",
                (content, now, uuid),
            )

    def store_preview_image(self, uuid: str, image_data: bytes) -> None:
        """Update document preview image."""
        now = _now()
        with self.db.transaction():
            self.db.execute(
                "UPDATE documents SET preview_image = ?, updated_at = ? WHERE uuid = ?",
                (image_data, now, uuid),
            )

    def rename(self, uuid: str, name: str) -> bool:
        """Rename a document. Returns True if found."""
        now = _now()
        with self.db.transaction():
            cursor = self.db.execute(
                "UPDATE documents SET name = ?, updated_at = ? WHERE uuid = ?",
                (name, now, uuid),
            )
            return cursor.rowcount > 0

    def update(self, uuid: str, **fields) -> bool:
        """Update document fields. Returns True if found and updated."""
        if not fields:
            return False
        allowed = {"name", "content", "preview_image", "updated_at", "is_public", "deleted_at"}
        updates = {k: v for k, v in fields.items() if k in allowed}
        if not updates:
            return False
        if "updated_at" not in updates:
            updates["updated_at"] = _now()
        return self.db.update("documents", "uuid", uuid, updates) > 0

    def retrieve(self, uuid: str) -> dict | None:
        """Retrieve a document by UUID."""
        cursor = self.db.execute(
            """SELECT d.uuid, d.name, d.content, d.owner_id, d.preview_image,
                      d.created_at, d.updated_at, d.deleted_at, d.is_public
               FROM documents d
               WHERE d.uuid = ?""",
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
            "preview_image": _to_bytes(row[4]),
            "created_at": row[5],
            "updated_at": row[6],
            "deleted_at": row[7],
            "is_public": bool(row[8]),
        }

    def list_trash(self, user_id: int) -> list[dict]:
        """List soft-deleted documents owned by a user."""
        cursor = self.db.execute(
            """SELECT d.uuid, d.name, d.deleted_at, d.created_at, d.owner_id, u.username
               FROM documents d
               JOIN users u ON d.owner_id = u.id
               WHERE d.owner_id = ? AND d.deleted_at IS NOT NULL
               ORDER BY d.deleted_at DESC""",
            (user_id,),
        )
        return [
            {
                "uuid": row[0],
                "name": row[1],
                "deleted_at": row[2],
                "created_at": row[3],
                "owner_id": row[4],
                "owner_username": row[5],
            }
            for row in cursor.fetchall()
        ]

    def permanently_delete(self, uuid: str) -> bool:
        """Permanently delete a document by UUID. Returns True if deleted."""
        with self.db.transaction():
            cursor = self.db.execute("DELETE FROM documents WHERE uuid = ?", (uuid,))
            return cursor.rowcount > 0

    def find_deleted_before(self, cutoff: datetime) -> list[dict]:
        """Find documents deleted before the given cutoff time."""
        cursor = self.db.execute(
            """SELECT uuid, name, owner_id, deleted_at
               FROM documents
               WHERE deleted_at IS NOT NULL AND deleted_at < ?""",
            (cutoff.replace(tzinfo=None).isoformat(),),
        )
        return [
            {
                "uuid": row[0],
                "name": row[1],
                "owner_id": row[2],
                "deleted_at": row[3],
            }
            for row in cursor.fetchall()
        ]

    def _copy_document(self, uuid: str, new_name: str, new_owner_id: int | None = None) -> str | None:
        """Copy a document's content under a fresh uuid and name.

        When new_owner_id is None the source's owner is kept (duplicate);
        otherwise ownership is reassigned to new_owner_id (clone). Returns the
        new UUID, or None if the source does not exist.
        """
        doc = self.retrieve(uuid)
        if doc is None:
            return None
        new_uuid = uuid_mod.uuid4().hex
        now = _now()
        owner_id = doc["owner_id"] if new_owner_id is None else new_owner_id
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO documents (uuid, name, content, owner_id, preview_image, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                (new_uuid, new_name, doc["content"], owner_id, doc["preview_image"], now, now),
            )
        return new_uuid

    def duplicate(self, uuid: str, new_name: str) -> str | None:
        """Duplicate a document with a new name. Returns new UUID or None if source not found."""
        return self._copy_document(uuid, new_name)

    def clone_document(self, uuid: str, new_owner_id: int, new_name: str) -> str | None:
        """Clone a document with new owner. Returns new UUID or None if source not found."""
        return self._copy_document(uuid, new_name, new_owner_id)

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

    def get_shares(self, uuid: str) -> list[dict]:
        """List all shares for a document, including public link status."""
        cursor = self.db.execute(
            """SELECT ds.id, ds.document_uuid, ds.shared_with_user_id, ds.permission, ds.created_at, u.username
               FROM document_shares ds
               LEFT JOIN users u ON ds.shared_with_user_id = u.id
               WHERE ds.document_uuid = ?""",
            (uuid,),
        )
        shares = [
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
        cursor = self.db.execute("SELECT is_public FROM documents WHERE uuid = ?", (uuid,))
        row = cursor.fetchone()
        if row and row[0]:
            shares.append({
                "id": 0,
                "document_uuid": uuid,
                "shared_with_user_id": None,
                "permission": "view",
                "created_at": "",
                "username": None,
            })
        return shares

    def set_public(self, uuid: str, is_public: bool) -> None:
        """Toggle public link sharing for a document."""
        with self.db.transaction():
            self.db.execute(
                "UPDATE documents SET is_public = ? WHERE uuid = ?",
                (1 if is_public else 0, uuid),
            )

    def has_permission(self, uuid: str, user_id: int, min_permission: str = "view") -> bool:
        """Check if user has permission to access a document."""
        cursor = self.db.execute(
            """SELECT d.owner_id, d.is_public, ds.permission
               FROM documents d
               LEFT JOIN document_shares ds ON d.uuid = ds.document_uuid
                   AND ds.shared_with_user_id = ?
               WHERE d.uuid = ?""",
            (user_id, uuid),
        )
        row = cursor.fetchone()
        if row is None:
            return False
        owner_id, is_public, perm = row[0], row[1], row[2]
        if owner_id == user_id:
            return True
        if perm is not None:
            if min_permission == "view" and perm in ("view", "edit"):
                return True
            if min_permission == "edit" and perm == "edit":
                return True
        if is_public and min_permission == "view":
            return True
        return False

    def get_permission(self, uuid: str, user_id: int) -> str | None:
        """Get the permission level for a user on a document. Returns 'owner', 'edit', 'view', or None."""
        cursor = self.db.execute(
            """SELECT d.owner_id, d.is_public, ds.permission
               FROM documents d
               LEFT JOIN document_shares ds ON d.uuid = ds.document_uuid
                   AND ds.shared_with_user_id = ?
               WHERE d.uuid = ?""",
            (user_id, uuid),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        owner_id, is_public, perm = row[0], row[1], row[2]
        if owner_id == user_id:
            return "owner"
        if perm is not None:
            return perm
        if is_public:
            return "view"
        return None

    def _documents_query(
        self, filter_type: str, search: str, sort: str, user_id: int
    ) -> tuple[str, tuple]:
        """Build (sql, params) for a document listing query.

        filter_type: "all" | "owned" | "shared" | "public"
        search: optional LIKE filter on name (empty = no filter)
        sort: key from _SORT_ORDERS, defaults to name
        user_id: caller's user id (unused for "public" filter)
        """
        order = self._SORT_ORDERS.get(sort)
        if order is None:
            order = "d.name"
        like = f"%{search}%" if search else None

        select = (
            "SELECT d.uuid, d.name, "
            "d.created_at, d.updated_at, d.owner_id, u.username, d.is_public "
            "FROM documents d JOIN users u ON d.owner_id = u.id "
        )

        if filter_type == "owned":
            where = "WHERE d.deleted_at IS NULL AND d.owner_id = ?"
            params: tuple = (user_id,)
        elif filter_type == "shared":
            # No preview_image here either: listings are sidebar data, and the
            # blob is only fetched by the per-document retrieve().
            select = (
                "SELECT DISTINCT d.uuid, d.name, "
                "d.created_at, d.updated_at, d.owner_id, u.username, d.is_public "
                "FROM documents d JOIN users u ON d.owner_id = u.id "
                "JOIN document_shares ds ON d.uuid = ds.document_uuid "
            )
            where = "WHERE d.deleted_at IS NULL AND ds.shared_with_user_id = ? AND d.owner_id != ?"
            params = (user_id, user_id)
        elif filter_type == "public":
            where = "WHERE d.deleted_at IS NULL AND d.is_public = 1"
            params = ()
        else:  # all
            where = (
                "WHERE d.deleted_at IS NULL "
                "AND (d.owner_id = ? "
                "OR EXISTS (SELECT 1 FROM document_shares "
                "WHERE document_uuid = d.uuid AND shared_with_user_id = ?) "
                "OR d.is_public = 1)"
            )
            params = (user_id, user_id)

        if like is not None:
            where += " AND LOWER(d.name) LIKE LOWER(?)"
            params = params + (like,)

        sql = f"{select}{where} ORDER BY {order}"
        return sql, params

    def _execute_documents_query(
        self, filter_type: str, search: str, sort: str, user_id: int
    ) -> list[dict]:
        """Execute a documents listing query and map rows to dicts."""
        sql, params = self._documents_query(filter_type, search, sort, user_id)
        cursor = self.db.execute(sql, params)
        return [
            {
                "uuid": row[0],
                "name": row[1],
                "created_at": row[2],
                "updated_at": row[3],
                "is_owner": row[4] == user_id,
                "owner_username": row[5],
                "is_public": bool(row[6]),
            }
            for row in cursor.fetchall()
        ]

    def list_by_filter(self, user_id: int, filter_type: str = "owned",
                       sort: str = "name", search: str = "") -> list[dict]:
        """Unified method: list documents by filter type with optional search."""
        return self._execute_documents_query(filter_type, search, sort, user_id)

    def list_by_owner(self, owner_id: int, sort: str = "name") -> list[dict]:
        """List all documents for an owner."""
        order = self._SORT_ORDERS.get(sort)
        if order is None:
            order = "d.name"
        cursor = self.db.execute(
            f"SELECT d.uuid, d.name, d.preview_image, d.created_at, d.updated_at,"
            f" d.is_public FROM documents d WHERE d.deleted_at IS NULL"
            f" AND d.owner_id = ? ORDER BY {order}",
            (owner_id,),
        )
        return [
            {
                "uuid": row[0], "name": row[1], "preview_image": _to_bytes(row[2]),
                "created_at": row[3], "updated_at": row[4], "is_public": bool(row[5]),
            }
            for row in cursor.fetchall()
        ]
