"""Generate reference extrude-lineage output for the TS prismLineage.ts gate (phase 2f).

Runs the canonical `extrude_profile_with_lineage` (the extrude leaf's OCC brep
producer) over two profiles -- a plain rectangle and a rectangle with a circular
hole -- and records, per case, the input loops + plane + direction + distance +
sketch id, then the produced solid volume and the full face/edge lineage maps
(geom-hash key -> sorted entity tokens). Writes
`frontend/src/kernel/occ/__fixtures__/extrude.json`. The gated test
(extrudeReal.test.ts) feeds the same loops through the TS port and asserts the
solid volume + lineage match Python EXACTLY (tokens sorted; volume within 1e-6).

Run: .venv/bin/python tests/wasm_harness/gen_extrude_fixture.py
"""

import json
import os

from oversolved.kernel.geometry_tessellation import extrude_profile_with_lineage
from oversolved.kernel.cadquery_ops import _ensure_occ
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}

RECT = [
    [
        {"id": "e1", "kind": "line", "start": [0.0, 0.0], "end": [10.0, 0.0]},
        {"id": "e2", "kind": "line", "start": [10.0, 0.0], "end": [10.0, 10.0]},
        {"id": "e3", "kind": "line", "start": [10.0, 10.0], "end": [0.0, 10.0]},
        {"id": "e4", "kind": "line", "start": [0.0, 10.0], "end": [0.0, 0.0]},
    ]
]

RECT_HOLE = [
    [
        {"id": "o1", "kind": "line", "start": [0.0, 0.0], "end": [20.0, 0.0]},
        {"id": "o2", "kind": "line", "start": [20.0, 0.0], "end": [20.0, 20.0]},
        {"id": "o3", "kind": "line", "start": [20.0, 20.0], "end": [0.0, 20.0]},
        {"id": "o4", "kind": "line", "start": [0.0, 20.0], "end": [0.0, 0.0]},
    ],
    [
        {
            "id": "c1", "kind": "arc", "center": [10.0, 10.0], "radius": 3.0,
            "angle_start_deg": 0.0, "angle_end_deg": 180.0, "ccw": True,
            "start": [13.0, 10.0], "end": [7.0, 10.0],
        },
        {
            "id": "c2", "kind": "arc", "center": [10.0, 10.0], "radius": 3.0,
            "angle_start_deg": 180.0, "angle_end_deg": 360.0, "ccw": True,
            "start": [7.0, 10.0], "end": [13.0, 10.0],
        },
    ],
]


def _volume(solid) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(solid), props, True, False, False)
    return props.Mass()


def _sorted_lineage(lineage: dict) -> dict:
    return {k: sorted(v) for k, v in lineage.items()}


def _case(name, loops, direction, distance, sketch_id):
    solid, face_lineage, edge_lineage = extrude_profile_with_lineage(
        loops, PLANE, direction, distance, sketch_id=sketch_id,
    )
    return {
        "name": name,
        "loops": loops,
        "plane": PLANE,
        "direction": direction,
        "distance": distance,
        "sketch_id": sketch_id,
        "volume": _volume(solid),
        "face_lineage": _sorted_lineage(face_lineage),
        "edge_lineage": _sorted_lineage(edge_lineage),
    }


# Two disjoint squares: classify_loops yields two independent outer groups, so
# extrude_profile_with_lineage extrudes each and boolean-fuses them. Exercises the
# multi-group fuse fold (otherwise untested) and the cross-group lineage merge.
DISJOINT = [
    [
        {"id": "a1", "kind": "line", "start": [0.0, 0.0], "end": [4.0, 0.0]},
        {"id": "a2", "kind": "line", "start": [4.0, 0.0], "end": [4.0, 4.0]},
        {"id": "a3", "kind": "line", "start": [4.0, 4.0], "end": [0.0, 4.0]},
        {"id": "a4", "kind": "line", "start": [0.0, 4.0], "end": [0.0, 0.0]},
    ],
    [
        {"id": "b1", "kind": "line", "start": [10.0, 0.0], "end": [14.0, 0.0]},
        {"id": "b2", "kind": "line", "start": [14.0, 0.0], "end": [14.0, 4.0]},
        {"id": "b3", "kind": "line", "start": [14.0, 4.0], "end": [10.0, 4.0]},
        {"id": "b4", "kind": "line", "start": [10.0, 4.0], "end": [10.0, 0.0]},
    ],
]


def main():
    cases = [
        _case("rect", RECT, [0.0, 0.0, 1.0], 5.0, "sk1"),
        _case("rect_hole", RECT_HOLE, [0.0, 0.0, 1.0], 4.0, "sk2"),
        _case("disjoint", DISJOINT, [0.0, 0.0, 1.0], 2.0, "sk3"),
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "extrude.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases)")
    for c in cases:
        nf = len(c["face_lineage"])
        ne = len(c["edge_lineage"])
        tagged = sum(1 for v in c["face_lineage"].values() if v)
        print(f"  {c['name']}: vol={c['volume']:.3f}, {nf} faces ({tagged} tagged), {ne} edges")


if __name__ == "__main__":
    main()
