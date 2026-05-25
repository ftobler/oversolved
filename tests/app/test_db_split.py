"""Tests for the db package split: public API compatibility and no circular imports."""

import subprocess
import sys


def test_public_api_compat():
    """All names from the original db.py public API are importable from oversolved.db.

    The private _to_bytes helper is intentionally not re-exported (it lives in
    oversolved.db.migrations); only the public surface is guaranteed here.
    """
    from oversolved.db import (  # noqa: F401
        DatabaseConnection,
        SQLiteConnection,
        PostgreSQLConnection,
        Database,
        AccountStore,
        UserStore,
        SessionStore,
        DocumentStore,
        PeriodicTaskStore,
    )


def test_no_circular_imports():
    """Each submodule can be imported independently without circular import errors."""
    submodules = [
        "oversolved.db.connection",
        "oversolved.db.migrations",
        "oversolved.db.users",
        "oversolved.db.sessions",
        "oversolved.db.documents",
        "oversolved.db.periodic",
    ]
    for module in submodules:
        result = subprocess.run(
            [sys.executable, "-c", f"import {module}"],
            capture_output=True,
            text=True,
        )
        assert result.returncode == 0, (
            f"Importing {module} failed:\n{result.stderr}"
        )
