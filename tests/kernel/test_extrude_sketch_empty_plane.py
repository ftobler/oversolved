"""Test for extrude 2 being red when using operation: add.

When an extrude uses operation: "add" and fuses with an existing body,
the returned body_id should reference the existing body (not a non-existent new body).
This ensures the frontend can find the mesh and not show the feature as red.
"""
import importlib

import pytest

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]

from oversolved.kernel.builder import build  # noqa: E402


def test_extrude_add_returns_existing_body_id():
    """Extrude with operation: add should return the existing body's ID."""
    spec = {
        "features": [
            {
                "id": "sketch1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "rect1", "kind": "line"},
                    {"id": "rect2", "kind": "line"},
                    {"id": "rect3", "kind": "line"},
                    {"id": "rect4", "kind": "line"},
                ],
                "initial": {
                    "rect1": [0, 0, 1, 0],
                    "rect2": [1, 0, 1, 1],
                    "rect3": [1, 1, 0, 1],
                    "rect4": [0, 1, 0, 0],
                },
                "constraints": [
                    {"id": "c1", "kind": "coincident", "a": "$rect1end", "b": "$rect2start"},
                    {"id": "c2", "kind": "coincident", "a": "$rect2end", "b": "$rect3start"},
                    {"id": "c3", "kind": "coincident", "a": "$rect3end", "b": "$rect4start"},
                    {"id": "c4", "kind": "coincident", "a": "$rect4end", "b": "$rect1start"},
                ],
            },
            {
                "id": "extrude1",
                "kind": "extrude",
                "extrude": {
                    "sketch": "$sketch1",
                    "distance": 1,
                },
            },
            {
                "id": "sketch2",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "circle1", "kind": "circle"},
                ],
                "initial": {
                    "circle1": [0.5, 0.5, 0.2],
                },
            },
            {
                "id": "extrude2",
                "kind": "extrude",
                "extrude": {
                    "sketch": "$sketch2",
                    "distance": 0.5,
                    "operation": "add",
                },
            },
        ]
    }

    result = build(spec)

    extrude2_result = result["result"]["extrude2"]
    bodies = result.get("bodies", {})

    # Extrude2 should succeed
    assert extrude2_result["status"] == "ok", \
        f"extrude2 failed: {extrude2_result.get('exception')}"

    # Extrude2's body_id should be in the bodies dict
    extrude2_body_id = extrude2_result["body_id"]
    assert extrude2_body_id in bodies, \
        f"extrude2 body {extrude2_body_id} should be in bodies dict"

    # Since extrude2 fused with extrude1, it should return extrude1's body_id
    assert extrude2_body_id == "body_extrude1", \
        f"extrude2 should return body_extrude1 when fusing, got {extrude2_body_id}"


if __name__ == "__main__":
    test_extrude_add_returns_existing_body_id()
