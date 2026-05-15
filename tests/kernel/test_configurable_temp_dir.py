"""Tests for configurable-temp-dir.

Verifies that OVERSOLVED_TMP_DIR env var is forwarded as dir= to
NamedTemporaryFile in shape_to_step_file_buffer and shape_to_stl_file_buffer.
"""
from __future__ import annotations

import tempfile
from io import BytesIO
from unittest.mock import MagicMock, patch


def _patched_ntf(captured: list, fake_path: str):
    """Return a context-manager mock for NamedTemporaryFile that records kwargs."""
    class _FakeTmp:
        name = fake_path

        def __enter__(self):
            return self

        def __exit__(self, *_):
            pass

    def _factory(*args, **kwargs):
        captured.append(kwargs)
        return _FakeTmp()

    return _factory


def test_step_temp_dir_env_var_is_respected(tmp_path, monkeypatch):
    """shape_to_step_file_buffer must pass OVERSOLVED_TMP_DIR as dir= kwarg."""
    import oversolved.kernel.geometry_io as gio

    monkeypatch.setattr(gio, "_TMP_DIR", str(tmp_path))

    captured: list = []
    fake_path = str(tmp_path / "fake.step")

    fake_buf = BytesIO(b"STEP-data")

    with patch("oversolved.kernel.geometry_io.tempfile.NamedTemporaryFile", side_effect=_patched_ntf(captured, fake_path)), \
         patch("oversolved.kernel.geometry_io._ensure_cq") as mock_cq, \
         patch("builtins.open", MagicMock(return_value=MagicMock(__enter__=lambda s: fake_buf, __exit__=MagicMock()))), \
         patch("oversolved.kernel.geometry_io.os.path.isfile", return_value=True), \
         patch("oversolved.kernel.geometry_io.os.unlink"):
        mock_shape = mock_cq.return_value
        mock_shape.exportStep = MagicMock()
        gio.shape_to_step_file_buffer(MagicMock())

    assert captured, "NamedTemporaryFile was never called"
    assert captured[0].get("dir") == str(tmp_path)


def test_stl_temp_dir_env_var_is_respected(tmp_path, monkeypatch):
    """shape_to_stl_file_buffer must pass OVERSOLVED_TMP_DIR as dir= kwarg."""
    import oversolved.kernel.geometry_io as gio

    monkeypatch.setattr(gio, "_TMP_DIR", str(tmp_path))

    captured: list = []
    fake_path = str(tmp_path / "fake.stl")
    fake_buf = BytesIO(b"STL-data")

    with patch("oversolved.kernel.geometry_io.tempfile.NamedTemporaryFile", side_effect=_patched_ntf(captured, fake_path)), \
         patch("oversolved.kernel.geometry_io.ocp_write_stl"), \
         patch("builtins.open", MagicMock(return_value=MagicMock(__enter__=lambda s: fake_buf, __exit__=MagicMock()))), \
         patch("oversolved.kernel.geometry_io.os.unlink"):
        gio.shape_to_stl_file_buffer(MagicMock())

    assert captured, "NamedTemporaryFile was never called"
    assert captured[0].get("dir") == str(tmp_path)


def test_temp_dir_env_var_unset_uses_default(monkeypatch):
    """When OVERSOLVED_TMP_DIR is unset, dir=None must be passed (system default)."""
    import oversolved.kernel.geometry_io as gio

    monkeypatch.setattr(gio, "_TMP_DIR", None)

    captured_step: list = []
    captured_stl: list = []
    fake_buf = BytesIO(b"data")

    with patch("oversolved.kernel.geometry_io.tempfile.NamedTemporaryFile",
               side_effect=_patched_ntf(captured_step, "/tmp/fake.step")), \
         patch("oversolved.kernel.geometry_io._ensure_cq") as mock_cq, \
         patch("builtins.open", MagicMock(return_value=MagicMock(__enter__=lambda s: fake_buf, __exit__=MagicMock()))), \
         patch("oversolved.kernel.geometry_io.os.path.isfile", return_value=True), \
         patch("oversolved.kernel.geometry_io.os.unlink"):
        mock_cq.return_value.exportStep = MagicMock()
        gio.shape_to_step_file_buffer(MagicMock())

    assert captured_step[0].get("dir") is None

    with patch("oversolved.kernel.geometry_io.tempfile.NamedTemporaryFile",
               side_effect=_patched_ntf(captured_stl, "/tmp/fake.stl")), \
         patch("oversolved.kernel.geometry_io.ocp_write_stl"), \
         patch("builtins.open", MagicMock(return_value=MagicMock(__enter__=lambda s: fake_buf, __exit__=MagicMock()))), \
         patch("oversolved.kernel.geometry_io.os.unlink"):
        gio.shape_to_stl_file_buffer(MagicMock())

    assert captured_stl[0].get("dir") is None
