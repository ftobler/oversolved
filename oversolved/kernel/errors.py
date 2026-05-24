from __future__ import annotations


def error_result(message: str) -> dict:
    """Return a standardised error response dict for solver failures."""
    return {
        "solve_ms": 0,
        "result": {"_error": message},
        "bodies": {},
    }
