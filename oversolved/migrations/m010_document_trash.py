from oversolved.db import Database
from oversolved.migrations._helpers import column_exists

VERSION = 10
NAME = "document_trash"


def apply(database: Database) -> None:
    if not column_exists(database, "documents", "deleted_at"):
        database.execute("ALTER TABLE documents ADD COLUMN deleted_at TEXT")
    database.execute("CREATE INDEX IF NOT EXISTS idx_documents_deleted_at ON documents(deleted_at)")
