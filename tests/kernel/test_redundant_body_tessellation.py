"""Tests for fix-redundant-body-tessellation.

Verifies that the build loop no longer re-tessellates all bodies before every
dirty feature, and that correctness is preserved after the optimisation.
"""

import importlib
import unittest.mock as mock

import pytest

from oversolved.kernel.builder import build
from solver_helpers import full_rect_extrude_spec, assert_mesh_valid

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _fillet_feature(fid: str, radius: float = 0.5) -> dict:
    return {
        "id": fid,
        "kind": "fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": radius,
    }


def test_build_correctness_after_redundancy_removal():
    """Multi-feature build produces a valid body mesh."""
    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    result = build(spec)
    bodies = result["bodies"]
    assert len(bodies) >= 1
    body = next(iter(bodies.values()))
    assert "mesh" in body
    assert_mesh_valid(body["mesh"])


def test_build_fillet_after_extrude_correctness():
    """Fillet after extrude must succeed and produce a valid modified mesh."""
    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append(_fillet_feature("fi1", radius=0.5))
    result = build(spec)
    assert result["result"]["fi1"]["status"] == "ok", (
        f"fillet failed: {result['result']['fi1'].get('exception')}"
    )
    mesh = result["bodies"]["body_ex1"]["mesh"]
    assert_mesh_valid(mesh)


def test_build_tessellates_once_per_body():
    """solid_to_mesh call count must not grow with the number of dirty features.

    For 1 body, the call count should be independent of how many features touch it.
    With N bodies and M dirty features, the old code called solid_to_mesh O(M*N)
    times. The new code calls it at most O(N + M_modified) times, where M_modified
    is the number of features that actually change a body.
    """
    from oversolved.kernel import geometry as geom_mod

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append(_fillet_feature("fi1", radius=0.5))

    call_count_with_fillet = 0
    original = geom_mod.solid_to_mesh

    def counting(*args, **kwargs):
        nonlocal call_count_with_fillet
        call_count_with_fillet += 1
        return original(*args, **kwargs)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=counting):
        build(spec)

    # Also count without the extra fillet feature.
    call_count_baseline = 0

    def counting_baseline(*args, **kwargs):
        nonlocal call_count_baseline
        call_count_baseline += 1
        return original(*args, **kwargs)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=counting_baseline):
        build(full_rect_extrude_spec(w=10, h=10, d=5))

    # Each additional dirty feature that modifies a body should add at most 1 extra call
    # (for re-registration), not N extra calls (the old O(M*N) behaviour).
    extra_calls = call_count_with_fillet - call_count_baseline
    assert extra_calls <= 2, (
        f"Adding 1 fillet added {extra_calls} extra solid_to_mesh calls; "
        f"expected ≤ 2 (1 re-registration + 1 checkpoint)"
    )


def test_ancestry_correctness_when_feature_modifies_body():
    """Filleted body must have more faces than the original box (ancestry updated)."""
    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    spec["features"].append(_fillet_feature("fi1", radius=0.5))
    result = build(spec)
    assert result["result"]["fi1"]["status"] == "ok"
    mesh = result["bodies"]["body_ex1"]["mesh"]
    # A filleted box has more than 6 faces.
    assert len(mesh["face_data"]) > 6
