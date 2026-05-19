"""Tests for _maybe_add_plane_transform and _try_solve_feature error path (feature 277)."""
import pytest
from oversolved.kernel.solver import _try_solve_feature, _maybe_add_plane_transform
from oversolved.kernel.solver_constants import _FRONT_PLANE
from oversolved.kernel.query import Repository


def _make_sketch(feature_id: str = "sk1", plane: str = "@builtin_plane_front") -> dict:
    return {
        "id": feature_id,
        "kind": "sketch",
        "plane": plane,
        "entities": [],
        "constraints": [],
    }


def _make_failing_feature(kind: str = "extrude") -> dict:
    return {
        "id": "f1",
        "kind": kind,
        "profile": "@missing",
    }


def test_error_sketch_on_front_plane() -> None:
    """Sketch error on builtin front plane returns plane_transform matching _FRONT_PLANE."""
    result: dict = {}
    feature = _make_sketch(plane="@builtin_plane_front")
    global_repo = Repository()
    _maybe_add_plane_transform(result, feature, global_repo)

    assert "plane_transform" in result
    pt = result["plane_transform"]
    assert "rotation" in pt
    assert "origin" in pt
    assert len(pt["rotation"]) == 9
    assert len(pt["origin"]) == 3


def test_error_sketch_on_user_plane_falls_back_to_front() -> None:
    """Sketch on an unresolvable plane reference gets front-plane transform as fallback."""
    result: dict = {}
    feature = _make_sketch(plane="@some_user_plane_that_does_not_exist")
    global_repo = Repository()
    _maybe_add_plane_transform(result, feature, global_repo)

    assert "plane_transform" in result


def test_non_sketch_error_no_plane_transform() -> None:
    """Non-sketch features do NOT get plane_transform on error."""
    result: dict = {}
    feature = _make_failing_feature(kind="extrude")
    global_repo = Repository()
    _maybe_add_plane_transform(result, feature, global_repo)

    assert "plane_transform" not in result


def test_non_dict_feature_no_plane_transform() -> None:
    """Non-dict feature arg is silently ignored."""
    result: dict = {}
    _maybe_add_plane_transform(result, "not-a-dict", Repository())  # type: ignore[arg-type]
    assert "plane_transform" not in result


def test_sketch_success_unchanged() -> None:
    """Successful sketch solve is unaffected -- plane_transform already present in result."""
    sketch = _make_sketch()
    global_repo = Repository()
    result = _try_solve_feature(sketch, global_repo, {})

    assert result.get("status") in ("ok", "fully_constrained", "under_constrained")
    assert "plane_transform" in result


def test_try_solve_feature_exception_includes_plane_transform() -> None:
    """_try_solve_feature adds plane_transform when a sketch solve raises."""
    bad_sketch = {
        "id": "sk_bad",
        "kind": "sketch",
        "plane": "@builtin_plane_front",
        "entities": [
            # Intentionally malformed -- missing required keys -- triggers exception.
            {"id": "e1", "kind": "line", "BROKEN": True},
        ],
        "constraints": [
            {"kind": "fixed", "entity": "e1", "x": 0, "y": 0},
        ],
    }
    global_repo = Repository()
    result = _try_solve_feature(bad_sketch, global_repo, {})

    assert result["status"] == "exception"
    assert "plane_transform" in result


def test_try_solve_feature_non_sketch_exception_no_plane_transform() -> None:
    """Non-sketch feature exception does not add plane_transform."""
    bad_extrude = {
        "id": "ext1",
        "kind": "extrude",
        "profile": "@nonexistent",
        "depth": 10,
    }
    global_repo = Repository()
    result = _try_solve_feature(bad_extrude, global_repo, {})

    assert result["status"] == "exception"
    assert "plane_transform" not in result
