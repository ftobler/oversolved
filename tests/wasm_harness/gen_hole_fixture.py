"""Generate reference _solve_hole output for the TS hole leaf gate (phase 2f).

Builds a target box body + a sketch plane + point entities (with XY entries in the
repo), runs the real `_solve_hole` for a blind two-hole case, a through-all case,
and a case where one point has no XY data (partial), and records per case the
result dict + the resulting target-body volume. Writes
`frontend/src/kernel/occ/__fixtures__/hole.json`. The gated test
(holeReal.test.ts) rebuilds the same setup and asserts result + volume parity
(through-all volume matches despite the vertex-AABB cylinder length, since the
cylinder fully penetrates either way).

Run: .venv/bin/python tests/wasm_harness/gen_hole_fixture.py
"""

import json
import os

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body
from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.solver_features_hole import _solve_hole
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


PLANE = {
    "origin": [0.0, 0.0, 0.0],
    "x_axis": [1.0, 0.0, 0.0],
    "y_axis": [0.0, 1.0, 0.0],
    "normal": [0.0, 0.0, 1.0],
}

# Box 20 x 20 x 10 at the origin; sketch on the z=0 face, holes drill up (+z).
BOX = [20.0, 20.0, 10.0]


def _volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(shape), props, True, False, False)
    return props.Mass()


def _setup(xy_entries):
    repo = Repository()
    repo.register("_pt_sk", PLANE)
    for eid, xy in xy_entries.items():
        repo.register(f"sk/{eid}/xy", {"external_xy": xy})
    box = BRepPrimAPI_MakeBox(*BOX).Shape()
    body_store = {"body_t": Body(id="body_t", created_by="ex_t", shape=box, sketch_id="sk_t")}
    return repo, body_store


def _case(name, depth_mode, diameter, depth, points, xy_entries):
    repo, body_store = _setup(xy_entries)
    features_by_id = {"sk": {"entities": [{"id": p, "kind": "point"} for p in points]}}
    feature = {
        "id": "hole1",
        "hole": {
            "sketch": "@sk", "diameter": diameter, "depth_mode": depth_mode,
            "depth": depth, "direction": "normal", "target": "body_t",
        },
    }
    result = _solve_hole(feature, repo, body_store, features_by_id)
    return {
        "name": name,
        "box": BOX,
        "plane": PLANE,
        "diameter": diameter,
        "depth_mode": depth_mode,
        "depth": depth,
        "points": points,
        "xy_entries": xy_entries,
        "result": result,
        "volume": _volume(body_store["body_t"].shape),
    }


def main():
    cases = [
        _case("blind_two", "blind", 6.0, 5.0, ["p1", "p2"],
              {"p1": [6.0, 6.0], "p2": [14.0, 14.0]}),
        _case("through_all", "through_all", 4.0, 0.0, ["p1"],
              {"p1": [10.0, 10.0]}),
        _case("partial_skip", "blind", 6.0, 5.0, ["p1", "p2"],
              {"p1": [6.0, 6.0]}),  # p2 has no XY -> skipped
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "hole.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases)")
    for c in cases:
        print(f"  {c['name']}: result={c['result']}, vol={c['volume']:.3f}")


if __name__ == "__main__":
    main()
