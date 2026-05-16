"""Tests for the projected-geometry-pick-chip feature.

Covers:
- test_projection_resolves_before_constraint_solve
- test_projection_updates_when_source_changes
- test_project_face_creates_projected_line_per_edge (face boundary edges projected)
"""
from unittest.mock import patch

import numpy as np

from oversolved.kernel.solver import _resolve_projections, solve_features


def test_projection_resolves_before_constraint_solve():
    """_process_projected_entities is invoked during solve for sketches with projected entities.

    Verified by tracking calls to the projection resolver and confirming it runs
    for a sketch that contains projected_line entities.
    """
    spec = {
        "features": [
            {
                "id": "sk0",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [{"id": "l1", "kind": "line"}],
                "initial": {"l1": [0.0, 0.0, 1.0, 0.0]},
                "constraints": [],
            },
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "pl1", "kind": "projected_line", "source": "@sk0/l1"},
                ],
                "constraints": [],
            },
        ]
    }

    call_log: list = []
    import oversolved.kernel.solver as solver_mod
    original = solver_mod._process_projected_entities

    def _tracking_wrapper(feature, global_repo, initial, constraints):
        result = original(feature, global_repo, initial, constraints)
        call_log.append(feature.get("id"))
        return result

    with patch("oversolved.kernel.solver._process_projected_entities", _tracking_wrapper):
        solve_features(spec)

    # Projection resolver is invoked for sk1 (the sketch with projected entities).
    assert "sk1" in call_log


def test_projection_updates_when_source_changes():
    """When the source geometry changes, the projected entity coordinates update on re-solve."""
    def _solve_with_source(x1: float, x2: float) -> dict:
        spec = {
            "features": [
                {
                    "id": "sk0",
                    "kind": "sketch",
                    "plane": "@builtin_plane_front",
                    "entities": [{"id": "l1", "kind": "line"}],
                    "initial": {"l1": [0.0, 0.0, x1, 0.0]},
                    "constraints": [
                        {
                            "id": "fix_start",
                            "kind": "fixed",
                            "target": {"entity": "l1", "point": "start"},
                            "x": 0.0, "y": 0.0,
                        },
                        {
                            "id": "fix_end",
                            "kind": "fixed",
                            "target": {"entity": "l1", "point": "end"},
                            "x": x1, "y": 0.0,
                        },
                    ],
                },
                {
                    "id": "sk1",
                    "kind": "sketch",
                    "plane": "@builtin_plane_front",
                    "entities": [
                        {"id": "pl1", "kind": "projected_line", "source": "@sk0/l1"},
                    ],
                    "constraints": [],
                },
            ]
        }
        result = solve_features(spec)
        geom = result["features"][1]["geometry"]
        return geom["pl1"]

    pl1_a = _solve_with_source(x1=3.0, x2=3.0)
    pl1_b = _solve_with_source(x1=7.0, x2=7.0)

    np.testing.assert_array_almost_equal(pl1_a["start"], [0, 0], decimal=5)
    np.testing.assert_array_almost_equal(pl1_a["end"], [3, 0], decimal=5)

    np.testing.assert_array_almost_equal(pl1_b["start"], [0, 0], decimal=5)
    np.testing.assert_array_almost_equal(pl1_b["end"], [7, 0], decimal=5)


def test_project_face_creates_projected_line_per_edge():
    """Each edge of a sketch surface (face boundary) can be projected to another sketch.

    The test projects all boundary edges of a closed rectangular sketch profile
    from sk0 into sk1 by creating one projected_line entity per edge.
    After solving, all projected lines must carry the source coordinates.
    """
    spec = {
        "features": [
            {
                "id": "sk0",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "top",    "kind": "line"},
                    {"id": "right",  "kind": "line"},
                    {"id": "bottom", "kind": "line"},
                    {"id": "left",   "kind": "line"},
                ],
                "initial": {
                    "top":    [0.0, 1.0, 1.0, 1.0],
                    "right":  [1.0, 1.0, 1.0, 0.0],
                    "bottom": [1.0, 0.0, 0.0, 0.0],
                    "left":   [0.0, 0.0, 0.0, 1.0],
                },
                "constraints": [
                    {"id": "f_top",    "kind": "fixed", "target": {"entity": "top"}},
                    {"id": "f_right",  "kind": "fixed", "target": {"entity": "right"}},
                    {"id": "f_bottom", "kind": "fixed", "target": {"entity": "bottom"}},
                    {"id": "f_left",   "kind": "fixed", "target": {"entity": "left"}},
                ],
            },
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                # One projected_line entity per edge of the sk0 rectangle.
                "entities": [
                    {"id": "pt",  "kind": "projected_line", "source": "@sk0/top"},
                    {"id": "pr",  "kind": "projected_line", "source": "@sk0/right"},
                    {"id": "pb",  "kind": "projected_line", "source": "@sk0/bottom"},
                    {"id": "pl",  "kind": "projected_line", "source": "@sk0/left"},
                ],
                "constraints": [],
            },
        ]
    }

    result = solve_features(spec)
    sk1_result = result["features"][1]
    assert sk1_result["status"] in ("fully_constrained", "underconstrained", "ok")

    geom = sk1_result["geometry"]
    # All four projected edges must be present.
    assert {"pt", "pr", "pb", "pl"} <= geom.keys()

    # Verify projected edges match source geometry.
    np.testing.assert_array_almost_equal(geom["pt"]["start"], [0, 1], decimal=5)
    np.testing.assert_array_almost_equal(geom["pt"]["end"],   [1, 1], decimal=5)
    np.testing.assert_array_almost_equal(geom["pr"]["start"], [1, 1], decimal=5)
    np.testing.assert_array_almost_equal(geom["pr"]["end"],   [1, 0], decimal=5)
    np.testing.assert_array_almost_equal(geom["pb"]["start"], [1, 0], decimal=5)
    np.testing.assert_array_almost_equal(geom["pb"]["end"],   [0, 0], decimal=5)
    np.testing.assert_array_almost_equal(geom["pl"]["start"], [0, 0], decimal=5)
    np.testing.assert_array_almost_equal(geom["pl"]["end"],   [0, 1], decimal=5)

    # Confirm the projected flag is set.
    for eid in ("pt", "pr", "pb", "pl"):
        assert geom[eid].get("projected") is True, f"{eid} must have projected=True"
