from oversolved.db import Database

VERSION = 3
NAME = "add_shares"


def apply(database: Database) -> None:
    database.execute("""
        CREATE TABLE document_shares (
            id SERIAL PRIMARY KEY,
            document_uuid TEXT NOT NULL,
            shared_with_user_id INTEGER NULL,
            permission TEXT NOT NULL DEFAULT 'view',
            created_at TEXT NOT NULL DEFAULT (NOW()::text),
            FOREIGN KEY (document_uuid) REFERENCES documents(uuid) ON DELETE CASCADE,
            FOREIGN KEY (shared_with_user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(document_uuid, shared_with_user_id)
        )
    """)
    database.execute("ALTER TABLE documents ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0")
