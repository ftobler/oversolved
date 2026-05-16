"""Application configuration dataclass."""

import os
from dataclasses import dataclass, field


@dataclass
class OversolvedConfig:
    """Runtime configuration loaded from environment variables.

    All fields have safe defaults so the app starts without any env vars set.
    """

    upload_dir: str = field(default_factory=lambda: os.path.join("instance", "uploads"))
    solver_ws_cache_max_size: int = 10
    ws_auth_check_interval: int = 50
    solver_daemon_host: str = "127.0.0.1"
    solver_daemon_port: int = 9100

    @classmethod
    def from_env(cls, instance_path: str = "") -> "OversolvedConfig":
        """Build config from environment, falling back to defaults."""
        default_upload_dir = os.path.join(instance_path or "instance", "uploads")

        raw_port = os.environ.get("SOLVER_DAEMON_PORT", "9100")
        try:
            port = int(raw_port)
        except ValueError as exc:
            raise ValueError(
                f"SOLVER_DAEMON_PORT must be an integer, got {raw_port!r}"
            ) from exc
        if not (1 <= port <= 65535):
            raise ValueError(
                f"SOLVER_DAEMON_PORT must be between 1 and 65535, got {port}"
            )

        return cls(
            upload_dir=os.environ.get("OVERSOLVED_UPLOAD_DIR", default_upload_dir),
            solver_ws_cache_max_size=10,
            ws_auth_check_interval=50,
            solver_daemon_host=os.environ.get("SOLVER_DAEMON_HOST", "127.0.0.1"),
            solver_daemon_port=port,
        )
