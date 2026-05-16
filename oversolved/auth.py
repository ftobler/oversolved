"""Shared authentication logic for HTTP and WebSocket handlers."""

from dataclasses import dataclass
from oversolved.db import Database, SessionStore, UserStore


@dataclass
class AuthOk:
    user: dict


@dataclass
class AuthError:
    code: str  # "no_token" | "invalid_session" | "user_not_found" | "deactivated"
    message: str


AuthResult = AuthOk | AuthError


def authenticate_token(db: Database, token: str | None) -> AuthResult:
    """Validate a session token and return the authenticated user or an error.

    Checks token presence, session validity, user existence, and active status.
    """
    if not token:
        return AuthError("no_token", "Not authenticated")

    session = SessionStore(db).find(token)
    if session is None:
        return AuthError("invalid_session", "Invalid or expired session")

    user = UserStore(db).find_by_id(session["user_id"])
    if user is None:
        return AuthError("user_not_found", "User not found")

    if not user.get("is_active", True):
        return AuthError("deactivated", "Account deactivated")

    return AuthOk(user=user)
