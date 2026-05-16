from oversolved.db import Database

VERSION = 15
NAME = "rebuild_times"


def apply(database: Database) -> None:
    database.execute("""
        CREATE TABLE IF NOT EXISTS rebuild_times (
            id SERIAL PRIMARY KEY,
            document_uuid TEXT NOT NULL,
            duration_ms INTEGER NOT NULL,
            feature_count INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (NOW()::text),
            FOREIGN KEY (document_uuid) REFERENCES documents(uuid) ON DELETE CASCADE
        )
    """)
    database.execute("""
        CREATE INDEX IF NOT EXISTS idx_rebuild_times_doc
        ON rebuild_times(document_uuid)
    """)
