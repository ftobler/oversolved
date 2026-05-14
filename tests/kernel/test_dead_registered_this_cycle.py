"""Tests for fix-dead-registered-this-cycle.

Verifies that removing the dead `registered_this_cycle` guard does not change
behaviour: all bodies with shapes are registered, and bodies without shapes
are skipped.
"""
import importlib
import unittest.mock as mock

import pytest

from oversolved.kernel.builder import build
from solver_helpers import full_rect_extrude_spec

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def test_loop_without_guard_processes_all_bodies():
    """Every body with a shape is registered at least once (no guard can skip it)."""
    from oversolved.kernel import geometry as geom_mod

    spec = full_rect_extrude_spec(w=10, h=10, d=5)
    original = geom_mod.solid_to_mesh
    registered_body_ids: set[str] = set()

    def tracking(shape, *, created_by=None, body_id=None, **kw):
        if body_id is not None:
            registered_body_ids.add(body_id)
        return original(shape, created_by=created_by, body_id=body_id, **kw)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=tracking):
        result = build(spec)

    body_ids = set(result["bodies"].keys())
    assert body_ids <= registered_body_ids, (
        f"Bodies not registered via solid_to_mesh: {body_ids - registered_body_ids}"
    )


def test_loop_skips_bodies_without_shape():
    """A sketch-only spec has no shaped body, so solid_to_mesh is never called."""
    from oversolved.kernel import geometry as geom_mod

    spec: dict = {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [],
                "constraints": [],
            }
        ]
    }
    original = geom_mod.solid_to_mesh
    calls: list[tuple] = []

    def tracking(*args, **kwargs):
        calls.append(args)
        return original(*args, **kwargs)

    with mock.patch.object(geom_mod, "solid_to_mesh", side_effect=tracking):
        build(spec)

    assert calls == [], (
        f"solid_to_mesh called {len(calls)} time(s) for a shape-less spec"
    )
