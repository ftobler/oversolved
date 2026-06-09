"""Tests for OversolvedConfig dataclass."""

from oversolved.config import OversolvedConfig


class TestOversolvedConfig:

    def test_config_loads_defaults_when_env_unset(self, monkeypatch):
        """Without env vars the defaults are used."""
        monkeypatch.delenv("OVERSOLVED_UPLOAD_DIR", raising=False)

        cfg = OversolvedConfig.from_env(instance_path="/app/instance")
        assert cfg.upload_dir == "/app/instance/uploads"

    def test_config_overrides_from_env(self, monkeypatch):
        """Env vars override the defaults."""
        monkeypatch.setenv("OVERSOLVED_UPLOAD_DIR", "/data/uploads")

        cfg = OversolvedConfig.from_env(instance_path="/ignored")
        assert cfg.upload_dir == "/data/uploads"

    def test_config_exposed_on_app(self, pg_dsn, monkeypatch):
        """create_app stores OversolvedConfig under app.config['OVERSOLVED']."""
        monkeypatch.setenv("OVERSOLVED_ADMIN_PASSWORD", "admin")
        from oversolved.app import create_app
        app = create_app({"DB_TYPE": "postgres", "TESTING": True, "DB_DSN": pg_dsn})
        assert "OVERSOLVED" in app.config
        assert isinstance(app.config["OVERSOLVED"], OversolvedConfig)
