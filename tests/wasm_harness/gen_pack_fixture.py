"""Generate a reference packed-geometry frame for the TS pack.ts parity test.

Builds deterministic body dicts (hand-rolled meshes, no kernel needed), packs
them with the canonical `pack_geometry_update`, and writes
`frontend/src/kernel/occ/__fixtures__/packFrame.json` holding the exact input and
the resulting frame (hex). The TS test re-packs the same input and asserts the
binary section is byte-identical and the JSON header is structurally equal.

Run: .venv/bin/python tests/wasm_harness/gen_pack_fixture.py
"""

import json
import os

from oversolved.kernel.geometry_pack import pack_geometry_update


def _bodies():
    return {
        "body_a": {
            "created_by": "feat_extrude_1",
            "modified_by": ["feat_fillet_2"],
            "mesh": {
                "vertices": [
                    [0.0, 0.0, 0.0],
                    [10.0, 0.0, 0.0],
                    [10.0, 10.0, 0.0],
                    [0.0, 10.0, 0.0],
                ],
                "faces": [[0, 1, 2], [0, 2, 3]],
                "triangle_to_face": [0, 0],
                "face_data": [
                    {
                        "centroid": [5.0, 5.0, 0.0],
                        "normal": [0.0, 0.0, -1.0],
                        "area": 100.0,
                        "surface_type": "flatface",
                    }
                ],
                "face_queries": ["q:face:0"],
            },
            "edges": [
                {"kind": "line", "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0]},
            ],
            "edge_queries": ["q:edge:0"],
            "vertices": [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0]],
            "vertex_queries": ["q:vert:0", "q:vert:1"],
        },
        "body_b": {
            "created_by": "feat_box_3",
            "modified_by": [],
            "mesh": {
                "vertices": [[1.5, 2.5, 3.5], [4.5, 5.5, 6.5], [7.5, 8.5, 9.5]],
                "faces": [[0, 1, 2]],
                "triangle_to_face": [0],
                "face_data": [
                    {
                        "centroid": [4.5, 5.5, 6.5],
                        "normal": [0.5773502691896258, 0.5773502691896258, 0.5773502691896258],
                        "area": 7.794228634059948,
                        "surface_type": "face",
                    }
                ],
                "face_queries": [],
            },
            "edges": [],
            "edge_queries": [],
            "vertices": [],
            "vertex_queries": [],
        },
    }


def _pick_bodies():
    return {
        "pick_a": {
            "created_by": "feat_extrude_1",
            "modified_by": [],
            "mesh": {
                "vertices": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
                "faces": [[0, 1, 2]],
                "triangle_to_face": [3],
                "face_data": [],
                "face_queries": [],
            },
        },
    }


def main():
    bodies = _bodies()
    pick_bodies = _pick_bodies()
    frame = pack_geometry_update(42, bodies, pick_bodies, request_id=7)

    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "packFrame.json")
    payload = {
        "input": {"msgId": 42, "bodies": bodies, "pick_bodies": pick_bodies, "request_id": 7},
        "frameHex": frame.hex(),
    }
    with open(out_path, "w") as f:
        json.dump(payload, f, indent=2)
    print(f"wrote {out_path} ({len(frame)} frame bytes)")


if __name__ == "__main__":
    main()
