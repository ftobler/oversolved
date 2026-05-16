"""Tests for OversolvedConfig dataclass."""

import os
import pytest
from oversolved.config import OversolvedConfig


class TestOversolvedConfig:

    def test_config_loads_defaults_when_env_unset(self, monkeypatch):
        """Without env vars the defaults are used."""
        for var in ("OVERSOLVED_UPLOAD_DIR", "SOLVER_DAEMON_HOST", "SOLVER_DAEMON_PORT"):
            monkeypatch.delenv(var, raising=False)

        cfg = OversolvedConfig.from_env(instance_path="/app/instance")
        assert cfg.upload_dir == "/app/instance/uploads"
        assert cfg.solver_daemon_host == "127.0.0.1"
        assert cfg.solver_daemon_port == 9100
        assert cfg.solver_ws_cache_max_size == 10
        assert cfg.ws_auth_check_interval == 50

    def test_config_overrides_from_env(self, monkeypatch):
        """Env vars override the defaults."""
        monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", "/data/uploads")
        monkeypatch.setenv("SOLVER_DAEMON_HOST", "10.0.0.5")
        monkeypatch.setenv("SOLVER_DAEMON_PORT", "9200")

        cfg = OversolvedConfig.from_env(instance_path="/ignored")
        assert cfg.upload_dir == "/data/uploads"
        assert cfg.solver_daemon_host == "10.0.0.5"
        assert cfg.solver_daemon_port == 9200

    def test_config_rejects_invalid_port(self, monkeypatch):
        """Non-integer SOLVER_DAEMON_PORT raises ValueError."""
        monkeypatch.setenv("SOLVER_DAEMON_PORT", "not-a-number")
        with pytest.raises(ValueError, match="SOLVER_DAEMON_PORT"):
            OversolvedConfig.from_env()

    def test_config_rejects_out_of_range_port(self, monkeypatch):
        """Port 0 or > 65535 raises ValueError."""
        monkeypatch.setenv("SOLVER_DAEMON_PORT", "0")
        with pytest.raises(ValueError, match="SOLVER_DAEMON_PORT"):
            OversolvedConfig.from_env()

        monkeypatch.setenv("SOLVER_DAEMON_PORT", "99999")
        with pytest.raises(ValueError, match="SOLVER_DAEMON_PORT"):
            OversolvedConfig.from_env()

    def test_config_exposed_on_app(self, monkeypatch):
        """create_app stores OversolvedConfig under app.config['OVERSOLVED']."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        app = create_app({"TESTING": True})
        assert "OVERSOLVED" in app.config
        assert isinstance(app.config["OVERSOLVED"], OversolvedConfig)
