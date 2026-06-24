"""Session store implementation."""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from oversolved.db._time import _now
from oversolved.db.migrations import Database


class SessionStore:
    """Session management."""

    SESSION_DURATION = timedelta(days=30)
    MAX_SESSIONS = 5

    def __init__(self, db: Database):
        self.db = db

    def create(self, user_id: int) -> str:
        """Create a session, enforce per-user session limit, return the token."""
        token = secrets.token_urlsafe(32)
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        expires_at = (datetime.now(timezone.utc) + self.SESSION_DURATION).isoformat()
        now = _now()
        with self.db.transaction():
            self.db.execute(
                "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
                (token_hash, user_id, expires_at, now),
            )
            self._enforce_session_limit(user_id, keep_token=token)
        return token

    def _enforce_session_limit(self, user_id: int, keep_token: str, max_sessions: int | None = None) -> int:
        """Delete oldest sessions for a user if count exceeds max_sessions.
        Returns number of sessions deleted."""
        if max_sessions is None:
            max_sessions = self.MAX_SESSIONS
        keep_hash = hashlib.sha256(keep_token.encode()).hexdigest()
        cursor = self.db.execute(
            """SELECT token_hash, created_at FROM sessions
               WHERE user_id = ? AND token_hash != ?
               ORDER BY created_at DESC, token_hash DESC""",
            (user_id, keep_hash),
        )
        rows = cursor.fetchall()
        if len(rows) < max_sessions:
            return 0
        to_keep = max_sessions - 1
        tokens_to_delete = [row[0] for row in rows[to_keep:]]
        if not tokens_to_delete:
            return 0
        placeholders = ", ".join("?" for _ in tokens_to_delete)
        cursor = self.db.execute(
            f"DELETE FROM sessions WHERE token_hash IN ({placeholders})",
            tuple(tokens_to_delete),
        )
        return cursor.rowcount

    def cleanup_for_user(self, user_id: int, keep_token: str | None = None) -> int:
        """Remove active sessions for a user, optionally keeping one token.

        Returns the number of sessions deleted.
        """
        if keep_token:
            keep_hash = hashlib.sha256(keep_token.encode()).hexdigest()
            cursor = self.db.execute(
                "DELETE FROM sessions WHERE user_id = ? AND token_hash != ?",
                (user_id, keep_hash),
            )
        else:
            cursor = self.db.execute(
                "DELETE FROM sessions WHERE user_id = ?",
                (user_id,),
            )
        return cursor.rowcount

    def find(self, token: str) -> dict | None:
        """Find a valid (non-expired) session."""
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        cursor = self.db.execute(
            "SELECT token_hash, user_id, expires_at FROM sessions WHERE token_hash = ?", (token_hash,)
        )
        row = cursor.fetchone()
        if row is None:
            return None
        expires_at = datetime.fromisoformat(row[2])
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if datetime.now(timezone.utc) >= expires_at:
            return None
        return {"token": row[0], "user_id": row[1], "expires_at": row[2]}

    def delete(self, token: str) -> None:
        """Delete a session (logout)."""
        token_hash = hashlib.sha256(token.encode()).hexdigest()
        with self.db.transaction():
            self.db.execute("DELETE FROM sessions WHERE token_hash = ?", (token_hash,))

    def cleanup_expired(self) -> None:
        """Remove expired sessions."""
        now = _now()
        with self.db.transaction():
            self.db.execute("DELETE FROM sessions WHERE expires_at <= ?", (now,))
