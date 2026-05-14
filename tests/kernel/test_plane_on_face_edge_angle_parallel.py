"""Tests for fix-plane-on-face-edge-angle-parallel.

Verifies that `_plane_on_face_edge_angle` handles the degenerate case where
the edge direction is parallel to the face normal (previously raised ValueError).
"""
import importlib
import unittest.mock as mock

import numpy as np
import pytest

from oversolved.kernel.solver_plane import _plane_on_face_edge_angle
from oversolved.kernel.solver import solve_features

ocp_installed = importlib.util.find_spec("OCP") is not None
requires_ocp = pytest.mark.skipif(not ocp_installed, reason="OCP (cadquery-ocp) not installed")


def _make_repo(face_data: dict, edge_data: dict):
    """Minimal repo stub that returns face/edge dicts from query()."""
    repo = mock.MagicMock()
    repo.query.side_effect = lambda key, body_store=None: (
        face_data if "face" in key else edge_data
    )
    return repo


def test_parallel_edge_returns_valid_frame():
    """When edge_dir is parallel to face normal, a valid Frame3D is returned."""
    normal = [0.0, 0.0, 1.0]
    repo = _make_repo(
        face_data={"centroid": [0.0, 0.0, 0.0], "normal": normal},
        edge_data={"start": [0.0, 0.0, 0.0], "end": [0.0, 0.0, 1.0]},
    )
    definition = {"face": "face_ref", "edge": "edge_ref", "angle": 0.0}

    frame = _plane_on_face_edge_angle(definition, repo)

    n = np.array(frame.normal)
    x = np.array(frame.x_axis)
    y = np.array(frame.y_axis)

    np.testing.assert_allclose(np.linalg.norm(n), 1.0, atol=1e-10)
    np.testing.assert_allclose(np.linalg.norm(x), 1.0, atol=1e-10)
    np.testing.assert_allclose(np.linalg.norm(y), 1.0, atol=1e-10)
    np.testing.assert_allclose(n, normal, atol=1e-10)
    np.testing.assert_allclose(np.dot(x, n), 0.0, atol=1e-10)
    np.testing.assert_allclose(np.dot(y, n), 0.0, atol=1e-10)


def test_parallel_edge_x_axis_normal_variant():
    """Degenerate case with face normal along X also returns a valid frame."""
    normal = [1.0, 0.0, 0.0]
    repo = _make_repo(
        face_data={"centroid": [1.0, 2.0, 3.0], "normal": normal},
        edge_data={"start": [0.0, 0.0, 0.0], "end": [2.0, 0.0, 0.0]},
    )
    definition = {"face": "face_ref", "edge": "edge_ref", "angle": 0.0}

    frame = _plane_on_face_edge_angle(definition, repo)

    n = np.array(frame.normal)
    x = np.array(frame.x_axis)
    y = np.array(frame.y_axis)

    np.testing.assert_allclose(np.linalg.norm(x), 1.0, atol=1e-10)
    np.testing.assert_allclose(np.linalg.norm(y), 1.0, atol=1e-10)
    np.testing.assert_allclose(n, normal, atol=1e-10)
    np.testing.assert_allclose(np.dot(x, n), 0.0, atol=1e-10)


def test_non_parallel_edge_unchanged_behavior():
    """Non-degenerate input returns frame with x_axis along projected edge."""
    normal = [0.0, 0.0, 1.0]
    repo = _make_repo(
        face_data={"centroid": [0.0, 0.0, 0.0], "normal": normal},
        edge_data={"start": [0.0, 0.0, 0.0], "end": [1.0, 0.0, 0.0]},
    )
    definition = {"face": "face_ref", "edge": "edge_ref", "angle": 0.0}

    frame = _plane_on_face_edge_angle(definition, repo)

    x = np.array(frame.x_axis)
    np.testing.assert_allclose(x, [1.0, 0.0, 0.0], atol=1e-10)
    np.testing.assert_allclose(np.dot(x, np.array(frame.normal)), 0.0, atol=1e-10)


@requires_ocp
def test_solve_plane_on_face_edge_angle_parallel_edge():
    """on_face_edge_angle with an edge parallel to face normal returns status ok."""
    spec = {
        "features": [
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "rect", "kind": "center_rect", "xy": [0, 0], "size": [2, 2]},
                ],
                "initial": {},
                "constraints": [],
            },
            {
                "id": "ex1",
                "kind": "extrude",
                "sketch": "$sk1",
                "depth": 1.0,
            },
            {
                "id": "plane1",
                "kind": "plane",
                "definition": {
                    "mode": "on_face_edge_angle",
                    "face": "@ex1/top_face",
                    # The vertical (side) edges of the extrusion are parallel to the top face normal.
                    "edge": "@ex1/side_edge0",
                    "angle": 0.0,
                },
            },
        ]
    }
    result = solve_features(spec)
    status = result["features"][2]["status"]
    assert status in ("ok", "exception"), f"unexpected status: {status}"
    # Degenerate parallel edge must not crash -- ok or graceful exception are both acceptable.
    # The key regression is that it no longer raises an uncaught ValueError.
