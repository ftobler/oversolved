"""Generate reference sweep-lineage output for the TS sweep gate (phase 2f).

Runs the canonical `sweep_profile_with_lineage` (the sweep leaf's OCC brep
producer) over a square profile swept along three spines -- a straight Z line, an
L-shaped two-segment path, and a quarter-circle arc -- recording per case the
input loops + plane + spine segments (world 3D), then the produced solid volume
and the full face/edge lineage maps. Writes
`frontend/src/kernel/occ/__fixtures__/sweep.json`. The gated test
(sweepReal.test.ts) rebuilds the same spine edges via the TS adapters and asserts
volume + lineage. Straight/L spines yield all-flat faces (face lineage EXACT);
the arc spine yields curved lateral faces (face lineage by token-multiset).

Run: .venv/bin/python tests/wasm_harness/gen_sweep_fixture.py
"""

import json
import os

from oversolved.kernel.geometry_tessellation import sweep_profile_with_lineage
from oversolved.kernel.cadquery_ops import _ensure_occ, make_line_edge
from oversolved.kernel.solver_features_brep import _world_arc_edge
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}

# 4x4 square centred on the origin, in the XY plane (perpendicular to a Z spine).
SQUARE = [
    [
        {"id": "s1", "kind": "line", "start": [-2.0, -2.0], "end": [2.0, -2.0]},
        {"id": "s2", "kind": "line", "start": [2.0, -2.0], "end": [2.0, 2.0]},
        {"id": "s3", "kind": "line", "start": [2.0, 2.0], "end": [-2.0, 2.0]},
        {"id": "s4", "kind": "line", "start": [-2.0, 2.0], "end": [-2.0, -2.0]},
    ]
]


def _volume(solid) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(solid), props, True, False, False)
    return props.Mass()


def _sorted_lineage(lineage: dict) -> dict:
    return {k: sorted(v) for k, v in lineage.items()}


def _build_spine(segments):
    edges = []
    for seg in segments:
        if seg["kind"] == "arc":
            edges.append(
                _world_arc_edge(seg["center"], seg["start"], seg["end"], seg["radius"])
            )
        else:
            edges.append(make_line_edge(seg["start"], seg["end"]))
    return edges


def _case(name, loops, segments, sketch_id, flat):
    spine = _build_spine(segments)
    solid, face_lineage, edge_lineage = sweep_profile_with_lineage(
        loops, PLANE, spine, sketch_id=sketch_id,
    )
    return {
        "name": name,
        "loops": loops,
        "plane": PLANE,
        "segments": segments,
        "sketch_id": sketch_id,
        "flat": flat,
        "volume": _volume(solid),
        "face_lineage": _sorted_lineage(face_lineage),
        "edge_lineage": _sorted_lineage(edge_lineage),
    }


def main():
    cases = [
        _case(
            "straight",
            SQUARE,
            [{"kind": "line", "start": [0.0, 0.0, 0.0], "end": [0.0, 0.0, 10.0]}],
            "sk1",
            True,
        ),
        _case(
            "lshape",
            SQUARE,
            [
                {"kind": "line", "start": [0.0, 0.0, 0.0], "end": [0.0, 0.0, 10.0]},
                {"kind": "line", "start": [0.0, 0.0, 10.0], "end": [6.0, 0.0, 10.0]},
            ],
            "sk2",
            True,
        ),
        _case(
            "arc",
            SQUARE,
            [{
                "kind": "arc", "center": [10.0, 0.0, 0.0],
                "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 10.0], "radius": 10.0,
            }],
            "sk3",
            False,
        ),
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "sweep.json")
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
