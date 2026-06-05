"""Generate reference revolve-lineage output for the TS prismLineage.ts gate (phase 2f).

Runs the canonical `revolve_profile_with_lineage` (the revolve leaf's OCC brep
producer) over a rectangle offset from the revolve axis, at a full 360 turn and a
90-degree wedge, and records per case the input loops + plane + axis + angle +
sketch id, then the produced solid volume and the full face/edge lineage maps
(geom-hash key -> sorted entity tokens). Writes
`frontend/src/kernel/occ/__fixtures__/revolve.json`. The gated test
(revolveReal.test.ts) feeds the same loops through the TS port and asserts the
solid volume + lineage match Python (edge lineage EXACT; face lineage by token
multiset, since cylindrical-wall geom-hash keys diverge across OCC builds).

Run: .venv/bin/python tests/wasm_harness/gen_revolve_fixture.py
"""

import json
import os

from oversolved.kernel.geometry_tessellation import revolve_profile_with_lineage
from oversolved.kernel.cadquery_ops import _ensure_occ
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}

# A rectangle on the +x side of the Y axis (x in [2,5], y in [0,4]); revolving it
# around the Y axis sweeps an annular tube (or, partial, a tube wedge).
RECT = [
    [
        {"id": "e1", "kind": "line", "start": [2.0, 0.0], "end": [5.0, 0.0]},
        {"id": "e2", "kind": "line", "start": [5.0, 0.0], "end": [5.0, 4.0]},
        {"id": "e3", "kind": "line", "start": [5.0, 4.0], "end": [2.0, 4.0]},
        {"id": "e4", "kind": "line", "start": [2.0, 4.0], "end": [2.0, 0.0]},
    ]
]

AXIS_ORIGIN = [0.0, 0.0, 0.0]
AXIS_DIRECTION = [0.0, 1.0, 0.0]


def _volume(solid) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(solid), props, True, False, False)
    return props.Mass()


def _sorted_lineage(lineage: dict) -> dict:
    return {k: sorted(v) for k, v in lineage.items()}


def _case(name, loops, angle, sketch_id):
    solid, face_lineage, edge_lineage = revolve_profile_with_lineage(
        loops, PLANE, AXIS_ORIGIN, AXIS_DIRECTION, angle, sketch_id=sketch_id,
    )
    return {
        "name": name,
        "loops": loops,
        "plane": PLANE,
        "axis_origin": AXIS_ORIGIN,
        "axis_direction": AXIS_DIRECTION,
        "angle": angle,
        "sketch_id": sketch_id,
        "volume": _volume(solid),
        "face_lineage": _sorted_lineage(face_lineage),
        "edge_lineage": _sorted_lineage(edge_lineage),
    }


def main():
    cases = [
        _case("full", RECT, 360.0, "sk1"),
        _case("wedge", RECT, 90.0, "sk2"),
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "revolve.json")
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
