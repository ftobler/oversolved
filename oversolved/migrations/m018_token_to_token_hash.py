from oversolved.db import Database
from oversolved.migrations._helpers import column_exists

VERSION = 18
NAME = "token_to_token_hash"


def apply(database: Database) -> None:
    if column_exists(database, "sessions", "token"):
        database.execute("ALTER TABLE sessions RENAME COLUMN token TO token_hash")
