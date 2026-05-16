from oversolved.db import Database

VERSION = 5
NAME = "add_last_login"


def apply(database: Database) -> None:
    database.execute("ALTER TABLE users ADD COLUMN last_login_at TEXT")
