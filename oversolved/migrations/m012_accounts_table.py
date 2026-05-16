from oversolved.db import Database

VERSION = 12
NAME = "accounts_table"


def apply(database: Database) -> None:
    database.execute("""
        CREATE TABLE IF NOT EXISTS accounts (
            id SERIAL PRIMARY KEY,
            handle TEXT UNIQUE NOT NULL,
            owner_type TEXT NOT NULL,
            owner_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (NOW()::text)
        )
    """)
    database.execute("""
        CREATE INDEX IF NOT EXISTS idx_accounts_handle ON accounts(handle)
    """)
    database.execute("""
        CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_type, owner_id)
    """)
    cursor = database.execute("SELECT id, username FROM users WHERE username IS NOT NULL")
    for row in cursor.fetchall():
        uid, username = row[0], row[1]
        database.execute(
            """INSERT INTO accounts (handle, owner_type, owner_id)
               VALUES (?, ?, ?) ON CONFLICT DO NOTHING""",
            (username, "user", uid),
        )
