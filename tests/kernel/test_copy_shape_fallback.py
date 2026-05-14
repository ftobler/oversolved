from unittest.mock import patch

import pytest

from oversolved.kernel.builder import _copy_shape


def test_copy_shape_handles_none_input():
    """_copy_shape(None) returns None without raising."""
    assert _copy_shape(None) is None


def test_copy_shape_returns_none_on_failure():
    """When ocp_copy_shape raises, _copy_shape returns None instead of the original."""
    pytest.importorskip("OCP.BRepPrimAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

    shape = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()

    with patch("oversolved.kernel.builder.ocp_copy_shape", side_effect=RuntimeError("occ error")):
        result = _copy_shape(shape)

    assert result is None


def test_copy_shape_copies_valid_shape():
    """_copy_shape returns a distinct object that is not the original shape."""
    pytest.importorskip("OCP.BRepPrimAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

    shape = BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape()
    copied = _copy_shape(shape)

    assert copied is not None
    assert copied is not shape
