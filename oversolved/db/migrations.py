"""Database manager with migrations support."""

import contextlib
from typing import Any, Callable

from oversolved.db.connection import DatabaseConnection, PostgreSQLConnection


class Database:
    """Database manager with migrations support."""

    def __init__(self, connection: DatabaseConnection, migrations: list | None = None):
        self.conn = connection
        self._migrations: list[tuple[int, str, Callable]] = list(migrations) if migrations is not None else []
        self._version = 0

    def register_migration(self, version: int, name: str, func: Callable) -> None:
        """Register a migration function."""
        self._migrations.append((version, name, func))
        self._migrations.sort(key=lambda x: x[0])

    def _ensure_schema_table(self) -> None:
        """Create schema_version table if it does not exist."""
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS schema_version (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL
            )
        """)
        self.conn.commit()

    def get_current_version(self) -> int:
        """Return the current schema version (0 if no migrations have been applied)."""
        self._ensure_schema_table()
        cursor = self.conn.execute("SELECT MAX(version) FROM schema_version")
        row = cursor.fetchone()
        self._version = row[0] if row[0] is not None else 0
        return self._version

    def get_all_migrations(self) -> list[tuple[int, str, Callable]]:
        """Return all registered migrations (version, name, func), sorted by version."""
        return list(self._migrations)

    def get_pending_migrations(self) -> list[tuple[int, str, Callable]]:
        """Return migrations with version > current version."""
        current = self.get_current_version()
        return [(v, n, f) for v, n, f in self._migrations if v > current]

    def get_latest_version(self) -> int:
        """Return the highest registered migration version."""
        if not self._migrations:
            return 0
        return max(v for v, _, _ in self._migrations)

    def check_version_sync(self, timeout: float = 5.0) -> tuple[bool, int, int]:
        """Check the database schema version against the latest migration.

        Uses a database-level lock to prevent multiprocessing races.
        Returns (is_ok, current, latest).
        """
        import time

        if isinstance(self.conn, PostgreSQLConnection):
            _ADVISORY_LOCK_ID = 1234567890
            cursor = self.conn.execute("SELECT pg_try_advisory_lock(?)", (_ADVISORY_LOCK_ID,))
            if not cursor.fetchone()[0]:
                raise TimeoutError("Could not acquire advisory lock for version check")
            try:
                current = self.get_current_version()
                latest = self.get_latest_version()
                return (current >= latest, current, latest)
            finally:
                self.conn.execute("SELECT pg_advisory_unlock(?)", (_ADVISORY_LOCK_ID,))
        else:
            deadline = time.monotonic() + timeout
            while True:
                try:
                    self.conn.execute("BEGIN IMMEDIATE")
                    break
                except Exception:
                    if time.monotonic() >= deadline:
                        raise TimeoutError("Could not acquire database lock for version check")
                    time.sleep(0.1)
            try:
                current = self.get_current_version()
                latest = self.get_latest_version()
                return (current >= latest, current, latest)
            finally:
                self.conn.rollback()

    def apply_migration(self, version: int, name: str, func: Callable) -> None:
        """Run a single migration and record it in schema_version."""
        self._ensure_schema_table()
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

    def init(self) -> None:
        """Initialize database and run pending migrations."""
        for version, name, func in self.get_pending_migrations():
            self.apply_migration(version, name, func)

    def execute(self, query: str, params: tuple = ()) -> Any:
        """Execute a query."""
        return self.conn.execute(query, params)

    def insert_returning_id(self, query: str, params: tuple = ()) -> int:
        """Execute an INSERT and return the auto-generated row ID."""
        return self.conn.insert_returning_id(query, params)

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
