"""Application configuration dataclass."""

import os
from dataclasses import dataclass, field


@dataclass
class OversolvedConfig:
    """Runtime configuration loaded from environment variables.

    All fields have safe defaults so the app starts without any env vars set.
    """

    upload_dir: str = field(default_factory=lambda: os.path.join("instance", "uploads"))

    @classmethod
    def from_env(cls, instance_path: str = "") -> "OversolvedConfig":
        """Build config from environment, falling back to defaults."""
        default_upload_dir = os.path.join(instance_path or "instance", "uploads")

        return cls(
            upload_dir=os.environ.get("OVERSOLVED_UPLOAD_DIR", default_upload_dir),
        )
