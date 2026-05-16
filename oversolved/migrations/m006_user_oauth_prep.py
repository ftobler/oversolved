from oversolved.db import Database
from oversolved.migrations._helpers import column_exists

VERSION = 6
NAME = "user_oauth_prep"


def apply(database: Database) -> None:
    if not column_exists(database, "users", "email"):
        database.execute("ALTER TABLE users ADD COLUMN email TEXT")
    if not column_exists(database, "users", "nickname"):
        database.execute("ALTER TABLE users ADD COLUMN nickname TEXT")
    if not column_exists(database, "users", "external_id"):
        database.execute("ALTER TABLE users ADD COLUMN external_id TEXT")
    if not column_exists(database, "users", "provider"):
        database.execute("ALTER TABLE users ADD COLUMN provider TEXT")
    if not column_exists(database, "users", "provider_data"):
        database.execute("ALTER TABLE users ADD COLUMN provider_data TEXT")
    if not column_exists(database, "users", "updated_at"):
        database.execute("ALTER TABLE users ADD COLUMN updated_at TEXT")
    database.execute(
        "UPDATE users SET updated_at = NOW()::text WHERE updated_at IS NULL"
    )
    database.execute(
        "UPDATE users SET email = username || '@local.oversolved' WHERE email IS NULL"
    )
    database.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email)"
    )
    database.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_users_nickname ON users(nickname)"
    )
    database.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS "
        "idx_users_external_id_provider ON users(external_id, provider)"
    )
