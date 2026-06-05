"""Generate reference output for the TS transform-group leaves (phase 2f):
array, circular_array, transform, mirror.

Each case builds a source box body (+ a registered mirror plane where needed),
runs the real solver, and records the result dict + the post-op body store (per
body: volume, created_by, modified_by). All transforms use literal vectors /
axes (no query-driven direction) except the mirror plane, which resolves via a
registered `@builtin_plane_front` element. Writes
`frontend/src/kernel/occ/__fixtures__/transformGroup.json`. The gated test
(transformGroupReal.test.ts) rebuilds each setup and asserts parity.

Run: .venv/bin/python tests/wasm_harness/gen_transform_fixture.py
"""

import json
import os

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body
from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.solver_features_array import _solve_array
from oversolved.kernel.solver_features_circular_array import _solve_circular_array
from oversolved.kernel.solver_features_transform_mirror import _solve_transform, _solve_mirror
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pnt
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp

FRONT_PLANE = {"type": "plane", "origin": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0]}


def _volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(shape), props, True, False, False)
    return props.Mass()


def _box(corner, dims):
    return BRepPrimAPI_MakeBox(gp_Pnt(*corner), *dims).Shape()


SOLVERS = {
    "array": lambda f, r, s: _solve_array(f, r, s),
    "circular_array": lambda f, r, s: _solve_circular_array(f, r, s),
    "transform": lambda f, r, s: _solve_transform(f, r, s),
    "mirror": lambda f, r, s: _solve_mirror(f, r, s),
}


def _case(name, kind, feature_id, source_spec, sub, register_plane=False):
    repo = Repository()
    if register_plane:
        repo.register("builtin_plane_front", FRONT_PLANE)
    box = _box(source_spec[0], source_spec[1])
    store = {"body_s": Body(id="body_s", created_by="ex_s", shape=box, sketch_id="sk_s")}
    feature = {"id": feature_id, "kind": kind, kind: sub}
    result = SOLVERS[kind](feature, repo, store)
    store_state = {
        bid: {
            "volume": _volume(b.shape) if b.shape is not None else None,
            "created_by": b.created_by,
            "modified_by": list(b.modified_by),
        }
        for bid, b in sorted(store.items())
    }
    return {
        "name": name,
        "kind": kind,
        "feature_id": feature_id,
        "source_spec": source_spec,
        "sub": sub,
        "register_plane": register_plane,
        "result": result,
        "store": store_state,
    }


def main():
    cases = [
        _case("array_linear_add", "array", "arr1", ([0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
              {"source_body": "body_s", "mode": "linear", "count_x": 3, "pitch_x": 3.0,
               "direction_x": [1, 0, 0], "include_source": True, "operation": "add"}),
        _case("array_linear_new", "array", "arr2", ([0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
              {"source_body": "body_s", "mode": "linear", "count_x": 3, "pitch_x": 10.0,
               "direction_x": [1, 0, 0], "include_source": True, "operation": "new"}),
        _case("circular_add", "circular_array", "ca1", ([5.0, -2.0, -2.0], [4.0, 4.0, 4.0]),
              {"source_body": "body_s", "count": 4, "step_angle": 90.0,
               "axis_origin": [0, 0, 0], "axis_direction": [0, 0, 1],
               "include_source": True, "operation": "add"}),
        _case("transform_translate_new", "transform", "tr1", ([0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
              {"body": "body_s", "translation": [10.0, 0.0, 0.0], "operation": "new"}),
        _case("transform_rotate_replace", "transform", "tr2", ([2.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
              {"body": "body_s", "rotation_angle": 90.0, "rotation_axis_origin": [0, 0, 0],
               "rotation_axis_direction": [0, 0, 1], "operation": "replace"}),
        _case("transform_scale_new", "transform", "tr3", ([0.0, 0.0, 0.0], [4.0, 4.0, 4.0]),
              {"body": "body_s", "scale": 2.0, "scale_center": [0, 0, 0], "operation": "new"}),
        _case("mirror_merge", "mirror", "mi1", ([2.0, 2.0, 2.0], [4.0, 4.0, 4.0]),
              {"body": "body_s", "plane": "@builtin_plane_front", "merge": True, "keep_original": True},
              register_plane=True),
        _case("mirror_new", "mirror", "mi2", ([2.0, 2.0, 2.0], [4.0, 4.0, 4.0]),
              {"body": "body_s", "plane": "@builtin_plane_front", "merge": False, "keep_original": True},
              register_plane=True),
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "transformGroup.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases)")
    for c in cases:
        print(f"  {c['name']}: result={c['result']}, bodies={list(c['store'].keys())}")


if __name__ == "__main__":
    main()
