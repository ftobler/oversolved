"""Generate reference output for the TS faceProfile.ts `$sketch` path gate (2e).

Drives `_collect_extrude_loops` over a plain `$sketch` reference (the common
extrude path: read sketch topology, register the swept top face, assemble the
profile loops) and records the returned loops + plane + sketch_id plus the
top-face elements registered as a side effect. Writes
`frontend/src/kernel/occ/__fixtures__/faceProfile.json`.

This path is OCC-free, so the TS gate (faceProfile.test.ts) is always-on. The
`@feat/face/N` body-face path is OCC-backed and gated separately
(faceProfileReal.test.ts).

Run: .venv/bin/python tests/wasm_harness/gen_faceprofile_fixture.py
"""

import json
import os

from oversolved.kernel.query import Repository
from oversolved.kernel.solver_features_shared import _collect_extrude_loops

SKETCH_ID = "sk"
FEATURE_ID = "featX"
DISTANCE = 10.0

PLANE = {"origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1]}
SURFACES = [{
    "boundary": [
        {"kind": "line", "start": [0, 0], "end": [10, 0]},
        {"kind": "line", "start": [10, 0], "end": [10, 10]},
        {"kind": "line", "start": [10, 10], "end": [0, 10]},
        {"kind": "line", "start": [0, 10], "end": [0, 0]},
    ],
}]


def main():
    repo = Repository()
    repo.register("_pt_" + SKETCH_ID, dict(PLANE))
    repo.register("_topo_" + SKETCH_ID, {"surfaces": [dict(s) for s in SURFACES]})

    loops, pt, sketch_id, _cq_face = _collect_extrude_loops(
        "$" + SKETCH_ID, FEATURE_ID, {}, DISTANCE, repo, {}
    )

    plane = {
        "origin": list(pt["origin"]), "x_axis": list(pt["x_axis"]),
        "y_axis": list(pt["y_axis"]), "normal": list(pt["normal"]),
    }
    top_face = {
        FEATURE_ID + "/top_face": repo.elements.get(FEATURE_ID + "/top_face"),
        FEATURE_ID + "/top_face/edge0": repo.elements.get(FEATURE_ID + "/top_face/edge0"),
    }
    top_face = {k: v for k, v in top_face.items() if v is not None}

    fixture = {
        "sketch_id": SKETCH_ID,
        "feature_id": FEATURE_ID,
        "distance": DISTANCE,
        "plane": PLANE,
        "surfaces": SURFACES,
        "expected": {
            "loops": loops,
            "plane": plane,
            "returned_sketch_id": sketch_id,
            "top_face": top_face,
        },
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "faceProfile.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path}: {len(loops)} loop(s), "
          f"{len(fixture['expected']['top_face'])} top-face elements")


if __name__ == "__main__":
    main()
