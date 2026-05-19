"""Tests for feature 278: no silent default location fallback on missing sketch plane."""
import pytest
from oversolved.kernel.solver import _try_solve_feature, _resolve_sketch_plane
from oversolved.kernel.solver_plane import _resolve_plane_early
from oversolved.kernel.query import Repository


def _make_sketch(plane: str | None = '@builtin_plane_front', extra: dict | None = None) -> dict:
    sketch: dict = {
        "id": "sk1",
        "kind": "sketch",
        "entities": [],
        "constraints": [],
    }
    if plane is not None:
        sketch["plane"] = plane
    if extra:
        sketch.update(extra)
    return sketch


def test_sketch_no_plane_raises_error() -> None:
    """Sketch with no plane field resolves to exception, not silent Front plane."""
    sketch = _make_sketch(plane=None)
    result = _try_solve_feature(sketch, Repository(), {})

    assert result["status"] == "exception"
    assert "plane" in result["exception"].lower()


def test_sketch_valid_plane_success() -> None:
    """Sketch with a valid builtin plane still solves normally."""
    sketch = _make_sketch(plane="@builtin_plane_front")
    result = _try_solve_feature(sketch, Repository(), {})

    assert result["status"] in ("ok", "fully_constrained", "under_constrained")
    assert "plane_transform" in result


def test_sketch_empty_plane_raises_error() -> None:
    """Sketch with an empty string plane field also raises, not silent default."""
    sketch = _make_sketch(plane="")
    result = _try_solve_feature(sketch, Repository(), {})

    assert result["status"] == "exception"
    assert "plane" in result["exception"].lower()


def test_projection_no_plane_raises_error() -> None:
    """_resolve_plane_early raises when plane_query is absent."""
    with pytest.raises(ValueError, match="plane"):
        _resolve_plane_early(None, None)

    with pytest.raises(ValueError, match="plane"):
        _resolve_plane_early("", None)


def test_resolve_sketch_plane_no_plane_raises() -> None:
    """_resolve_sketch_plane raises directly for None/empty plane_query."""
    repo = Repository()

    def resolve_ref(val: object) -> object:
        return None

    with pytest.raises(ValueError, match="plane"):
        _resolve_sketch_plane(None, resolve_ref, repo)

    with pytest.raises(ValueError, match="plane"):
        _resolve_sketch_plane("", resolve_ref, repo)
