from oversolved.db import Database
from oversolved.migrations._helpers import column_exists

VERSION = 14
NAME = "remove_organizations"


def apply(database: Database) -> None:
    database.execute("DROP TABLE IF EXISTS organization_members")
    database.execute("DROP TABLE IF EXISTS organizations")
    if column_exists(database, "documents", "org_id"):
        database.execute("ALTER TABLE documents DROP COLUMN org_id")
