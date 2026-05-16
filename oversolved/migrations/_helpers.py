"""Shared helpers for migration modules."""

from oversolved.db import Database


def column_exists(database: Database, table: str, column: str) -> bool:
    """Return True if the column exists in the given table."""
    from oversolved.db.connection import PostgreSQLConnection
    if isinstance(database.conn, PostgreSQLConnection):
        cursor = database.execute(
            "SELECT column_name FROM information_schema.columns "
            "WHERE table_name = ? AND column_name = ? AND table_schema = 'public'",
            (table, column),
        )
        return cursor.fetchone() is not None
    cursor = database.execute(f"PRAGMA table_info({table})")
    return any(row[1] == column for row in cursor.fetchall())
