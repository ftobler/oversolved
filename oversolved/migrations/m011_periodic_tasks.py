from oversolved.db import Database

VERSION = 11
NAME = "periodic_tasks"


def apply(database: Database) -> None:
    database.execute("""
        CREATE TABLE IF NOT EXISTS periodic_tasks (
            id SERIAL PRIMARY KEY,
            task_key TEXT UNIQUE NOT NULL,
            last_run_at TEXT,
            last_run_status TEXT
        )
    """)
