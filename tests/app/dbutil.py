"""Shared helper for app DB tests: build a migrated, initialized Database."""

from oversolved.db import Database, PostgreSQLConnection
from oversolved.migrations import discover_and_register


def make_db(pg_dsn):
    database = Database(PostgreSQLConnection(pg_dsn))
    discover_and_register(database)
    database.init()
    return database
