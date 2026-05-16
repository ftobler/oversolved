from oversolved.db import Database

VERSION = 1
NAME = "initial_schema"


def apply(database: Database) -> None:
    database.execute("""
        CREATE TABLE users (
            id SERIAL PRIMARY KEY,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            must_change_password INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (NOW()::text)
        )
    """)
    database.execute("""
        CREATE TABLE sessions (
            token TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        )
    """)
    database.execute("""
        CREATE TABLE documents (
            uuid TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            content TEXT NOT NULL,
            owner_id INTEGER NOT NULL,
            created_at TEXT NOT NULL DEFAULT (NOW()::text),
            updated_at TEXT NOT NULL DEFAULT (NOW()::text),
            FOREIGN KEY (owner_id) REFERENCES users(id)
        )
    """)
