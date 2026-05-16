from oversolved.db import Database

VERSION = 2
NAME = "add_preview_image"


def apply(database: Database) -> None:
    database.execute("ALTER TABLE documents ADD COLUMN preview_image BYTEA")
