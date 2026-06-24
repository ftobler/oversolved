"""Time helpers shared by the db stores.

Kept in a leaf module so store modules can import it without going through
oversolved.db's __init__, which would create a circular import.
"""

from datetime import datetime, timezone


def _now() -> str:
    """Return the current UTC time as an ISO-8601 string."""
    return datetime.now(timezone.utc).isoformat()
