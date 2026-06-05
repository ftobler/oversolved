"""Generate reference face-profile loops for the TS faceLoops.ts gate (phase 2e).

Runs the canonical `_extract_loops_from_occ_face` (which sorts faces by
_face_sort_key, the same order the TS port uses) over a box and a cylinder, and
records, per (shape, face_index), the 2D boundary loops + the face plane frame.
Writes `frontend/src/kernel/occ/__fixtures__/faceLoops.json`. The gated test
(faceLoopsReal.test.ts) builds the same shapes via the OCC adapter and asserts
identical loops + plane (coords within 1e-6).

Run: .venv/bin/python tests/wasm_harness/gen_faceloops_fixture.py
"""

import json
import os

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from oversolved.kernel.ocp_ops import ocp_make_cylinder
from oversolved.kernel.solver_features_shared import _extract_loops_from_occ_face

BOX = (10.0, 10.0, 10.0)
CYL = {"center": [0.0, 0.0, 0.0], "axis": [0.0, 0.0, 1.0], "radius": 5.0, "height": 10.0}


def _frame_dict(frame):
    return {
        "origin": list(frame.origin),
        "x_axis": list(frame.x_axis),
        "y_axis": list(frame.y_axis),
        "normal": list(frame.normal),
    }


def _case(shape, shape_name, face_index):
    loops, frame, _cq_face = _extract_loops_from_occ_face(shape, face_index)
    return {
        "shape": shape_name,
        "face_index": face_index,
        "loops": loops,
        "plane": _frame_dict(frame),
    }


def main():
    box = BRepPrimAPI_MakeBox(*BOX).Shape()
    cyl = ocp_make_cylinder(CYL["center"], CYL["axis"], CYL["radius"], CYL["height"])

    cases = [
        _case(box, "box", 0),
        _case(box, "box", 1),
        _case(box, "box", 2),
        _case(cyl, "cyl", 0),  # a flat cap: a single full-circle loop
    ]

    fixture = {"box": BOX, "cyl": CYL, "cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "faceLoops.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases)")
    for c in cases:
        kinds = [e["kind"] for loop in c["loops"] for e in loop]
        print(f"  {c['shape']}[{c['face_index']}]: {len(c['loops'])} loop(s), edges={kinds}")


if __name__ == "__main__":
    main()
