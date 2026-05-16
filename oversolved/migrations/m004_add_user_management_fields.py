from oversolved.db import Database

VERSION = 4
NAME = "add_user_management_fields"


def apply(database: Database) -> None:
    database.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0")
    database.execute("ALTER TABLE users ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1")
