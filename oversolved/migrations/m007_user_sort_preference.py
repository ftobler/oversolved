from oversolved.db import Database
from oversolved.migrations._helpers import column_exists

VERSION = 7
NAME = "user_sort_preference"


def apply(database: Database) -> None:
    if not column_exists(database, "users", "document_sort_preference"):
        database.execute(
            "ALTER TABLE users ADD COLUMN document_sort_preference TEXT DEFAULT 'alphabetical'"
        )
