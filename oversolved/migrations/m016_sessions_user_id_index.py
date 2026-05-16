from oversolved.db import Database

VERSION = 16
NAME = "sessions_user_id_index"


def apply(database: Database) -> None:
    database.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id)"
    )
