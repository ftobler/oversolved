from __future__ import annotations


def error_result(message: str, code: str = "SOLVER_ERROR") -> dict:
    """Return a standardised error response dict for solver failures."""
    return {"ok": False, "error": message, "code": code}
