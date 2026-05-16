from oversolved.db import Database

VERSION = 17
NAME = "session_created_at"


def apply(database: Database) -> None:
    database.execute("ALTER TABLE sessions ADD COLUMN created_at TEXT")
    database.execute(
        "UPDATE sessions SET created_at = NOW()::text WHERE created_at IS NULL"
    )
