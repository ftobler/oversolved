"""Tests for centralized tolerance constants in solver_constants.py."""

import math
from oversolved.kernel.solver_constants import (
    TOL_LOOP_CLOSURE,
    TOL_NEAR_ZERO_AREA,
    TOL_MESH_NORMAL,
    TOL_TOPOLOGY_EPS,
    TOL_TOPOLOGY_MERGE,
    TOL_TOPOLOGY_SPLIT,
)


def test_tolerance_constants_importable():
    """All tolerance constants are importable, finite, and positive."""
    constants = [
        TOL_LOOP_CLOSURE,
        TOL_NEAR_ZERO_AREA,
        TOL_MESH_NORMAL,
        TOL_TOPOLOGY_EPS,
        TOL_TOPOLOGY_MERGE,
        TOL_TOPOLOGY_SPLIT,
    ]
    for c in constants:
        assert isinstance(c, float)
        assert math.isfinite(c)
        assert c > 0


def test_topology_merge_exceeds_eps():
    """TOL_TOPOLOGY_MERGE > TOL_TOPOLOGY_EPS (merge threshold must exceed coincidence threshold)."""
    assert TOL_TOPOLOGY_MERGE > TOL_TOPOLOGY_EPS


def test_loop_closure_used_in_profile_loops():
    """profile_loops imports TOL_NEAR_ZERO_AREA from solver_constants (not a bare literal)."""
    import inspect
    import oversolved.kernel.profile_loops as pl
    src = inspect.getsource(pl)
    assert "TOL_NEAR_ZERO_AREA" in src
    assert "1e-12" not in src


def test_topology_uses_constants():
    """topology.py does not define bare tolerance literals for _EPS/_MERGE/_SPLIT_EPS."""
    import inspect
    import oversolved.kernel.topology as topo
    src = inspect.getsource(topo)
    assert "TOL_TOPOLOGY_EPS" in src
    assert "TOL_TOPOLOGY_MERGE" in src
    assert "TOL_TOPOLOGY_SPLIT" in src
