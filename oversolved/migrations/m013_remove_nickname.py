from oversolved.db import Database
from oversolved.migrations._helpers import column_exists

VERSION = 13
NAME = "remove_nickname"


def apply(database: Database) -> None:
    if column_exists(database, "users", "nickname"):
        database.execute("DROP INDEX IF EXISTS idx_users_nickname")
        database.execute("ALTER TABLE users DROP COLUMN nickname")
