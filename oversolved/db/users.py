"""User and account store implementations."""

from oversolved.db.migrations import Database

# Columns returned by auth lookup methods (no provider_data, no created_at,
# no document_sort_preference — password_hash is included for credential check).
_AUTH_COLUMNS = (
    "id", "username", "password_hash", "email", "external_id", "provider",
    "must_change_password", "is_admin", "is_active", "last_login_at", "updated_at",
)

# Full column set returned by find_by_id (no password_hash; includes extras).
_FULL_COLUMNS = (
    "id", "username", "email", "external_id", "provider",
    "provider_data", "must_change_password", "is_admin",
    "is_active", "created_at", "last_login_at", "updated_at",
    "document_sort_preference",
)

# Columns that are stored as integers but should be surfaced as booleans.
_BOOL_COLUMNS = {"must_change_password", "is_admin", "is_active"}


def _row_to_user(row, columns: tuple) -> dict:
    """Map a DB row tuple to a user dict, coercing boolean columns."""
    result: dict = {}
    for col, val in zip(columns, row):
        if col in _BOOL_COLUMNS:
            result[col] = bool(val)
        elif col == "document_sort_preference" and val is None:
            result[col] = "alphabetical"
        else:
            result[col] = val
    return result


class AccountStore:
    """Unified accounts table for user namespace tracking."""

    def __init__(self, db: Database):
        self.db = db

    def find_by_handle(self, handle: str) -> dict | None:
        """Find an account by handle. Returns {id, handle, owner_type, owner_id}."""
        cursor = self.db.execute(
            "SELECT id, handle, owner_type, owner_id FROM accounts WHERE handle = ?",
            (handle,),
        )
        row = cursor.fetchone()
        if row is None:
            return None
        return {
            "id": row[0],
            "handle": row[1],
            "owner_type": row[2],
            "owner_id": row[3],
        }

    def register(self, handle: str, owner_type: str, owner_id: int) -> None:
        """Register a new handle for a user or org."""
        with self.db.transaction():
            self.db.execute(
                """INSERT INTO accounts (handle, owner_type, owner_id)
                   VALUES (?, ?, ?)""",
                (handle, owner_type, owner_id),
            )


class UserStore:
    """User management."""

    def __init__(self, db: Database):
        self.db = db

    def create(
        self, username: str, password_hash: str, must_change_password: bool = False,
        email: str | None = None,
        external_id: str | None = None, provider: str | None = None,
        provider_data: str | None = None, is_admin: bool = False,
        is_active: bool = True
    ) -> int:
        """Create a user and return its id."""
        with self.db.transaction():
            columns = ["username", "password_hash", "must_change_password"]
            values = [username, password_hash, 1 if must_change_password else 0]

            if email is not None:
                columns.append("email")
                values.append(email)
            if external_id is not None:
                columns.append("external_id")
                values.append(external_id)
            if provider is not None:
                columns.append("provider")
                values.append(provider)
            if provider_data is not None:
                columns.append("provider_data")
                values.append(provider_data)

            columns.extend(["is_admin", "is_active"])
            values.extend([1 if is_admin else 0, 1 if is_active else 0])

            placeholders = ", ".join(["?"] * len(values))
            user_id = self.db.insert_returning_id(
                f"""INSERT INTO users ({', '.join(columns)})
                   VALUES ({placeholders})""",
                tuple(values),
            )
            # Register handle in accounts table
            self.db.execute(
                """INSERT INTO accounts (handle, owner_type, owner_id)
                   VALUES (?, ?, ?) ON CONFLICT DO NOTHING""",
                (username, "user", user_id),
            )
            return user_id

    def find_by_username(self, username: str) -> dict | None:
        """Find a user by username."""
        cols = ", ".join(_AUTH_COLUMNS)
        cursor = self.db.execute(
            f"SELECT {cols} FROM users WHERE username = ?",
            (username,),
        )
        row = cursor.fetchone()
        return _row_to_user(row, _AUTH_COLUMNS) if row is not None else None

    def find_by_email(self, email: str) -> dict | None:
        """Find a user by email (case-insensitive)."""
        cols = ", ".join(_AUTH_COLUMNS)
        cursor = self.db.execute(
            f"SELECT {cols} FROM users WHERE LOWER(email) = LOWER(?)",
            (email,),
        )
        row = cursor.fetchone()
        return _row_to_user(row, _AUTH_COLUMNS) if row is not None else None

    def find_by_external_id(self, external_id: str, provider: str) -> dict | None:
        """Find a user by OAuth external_id and provider."""
        cols = ", ".join(_AUTH_COLUMNS)
        cursor = self.db.execute(
            f"SELECT {cols} FROM users WHERE external_id = ? AND provider = ?",
            (external_id, provider),
        )
        row = cursor.fetchone()
        return _row_to_user(row, _AUTH_COLUMNS) if row is not None else None

    def find_by_id(self, user_id: int) -> dict | None:
        """Find a user by id."""
        cols = ", ".join(_FULL_COLUMNS)
        cursor = self.db.execute(
            f"SELECT {cols} FROM users WHERE id = ?",
            (user_id,),
        )
        row = cursor.fetchone()
        return _row_to_user(row, _FULL_COLUMNS) if row is not None else None

    def update(self, user_id: int, **fields) -> bool:
        """Update user fields. Returns True if user was found and updated."""
        if not fields:
            return False
        allowed = {"username", "password_hash", "must_change_password", "is_admin",
                   "is_active", "last_login_at", "email",
                   "external_id", "provider", "provider_data", "updated_at",
                   "document_sort_preference"}
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
            """SELECT id, username, email, must_change_password, is_admin,
                      is_active, created_at, last_login_at, updated_at
               FROM users ORDER BY username"""
        )
        return [
            {
                "id": row[0],
                "username": row[1],
                "email": row[2],
                "must_change_password": bool(row[3]),
                "is_admin": bool(row[4]),
                "is_active": bool(row[5]),
                "created_at": row[6],
                "last_login_at": row[7],
                "updated_at": row[8],
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
