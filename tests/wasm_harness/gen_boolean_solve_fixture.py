"""Generate reference _solve_boolean output for the TS boolean leaf gate (phase 2f).

Builds a target box + tool box(es) as Body objects in a body_store, runs the real
`_solve_boolean` for union / subtract / intersect / a subtract that splits the
target into two solids, and records per case the result dict + the post-op body
store (per remaining body: volume, created_by, modified_by). Writes
`frontend/src/kernel/occ/__fixtures__/booleanSolve.json`. The gated test
(booleanSolveReal.test.ts) rebuilds the same bodies and asserts result + store
parity.

Run: .venv/bin/python tests/wasm_harness/gen_boolean_solve_fixture.py
"""

import json
import os

from oversolved.kernel.cadquery_ops import _ensure_occ
from oversolved.kernel.types3d import Body
from oversolved.kernel.solver_features_boolean import _solve_boolean
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.gp import gp_Pnt
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp


def _volume(shape) -> float:
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(shape), props, True, False, False)
    return props.Mass()


def _box(dx, dy, dz):
    return BRepPrimAPI_MakeBox(dx, dy, dz).Shape()


def _box_at(corner, dx, dy, dz):
    return BRepPrimAPI_MakeBox(gp_Pnt(*corner), dx, dy, dz).Shape()


def _store(target_shape, tools):
    store = {
        "body_t": Body(id="body_t", created_by="ex_t", shape=target_shape, sketch_id="sk_t"),
    }
    for i, ts in enumerate(tools):
        store[f"body_u{i}"] = Body(id=f"body_u{i}", created_by=f"ex_u{i}", shape=ts, sketch_id="sk_u")
    return store


def _case(name, operation, target_spec, tool_specs, tool_refs, keep_tools=False):
    target_shape = _box_at(target_spec[0], *target_spec[1])
    tools = [_box_at(c, *d) for (c, d) in tool_specs]
    store = _store(target_shape, tools)
    feature = {
        "id": "bool1",
        "boolean": {"operation": operation, "target": "body_t", "tools": tool_refs, "keep_tools": keep_tools},
    }
    result = _solve_boolean(feature, None, store)
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
        "operation": operation,
        "tool_refs": tool_refs,
        "keep_tools": keep_tools,
        "target_spec": target_spec,
        "tool_specs": tool_specs,
        "result": result,
        "store": store_state,
    }


# Box spec: (corner, [dx, dy, dz]). The 10-cube target and a 6-cube tool sharing
# the origin corner overlap; the slab splits the target.
T10 = ([0.0, 0.0, 0.0], [10.0, 10.0, 10.0])
T6 = ([0.0, 0.0, 0.0], [6.0, 6.0, 6.0])
SLAB = ([-1.0, -1.0, 4.0], [12.0, 12.0, 2.0])


def main():
    cases = [
        _case("union", "union", T10, [T6], ["body_u0"]),
        _case("subtract", "subtract", T10, [T6], ["body_u0"]),
        _case("intersect", "intersect", T10, [T6], ["body_u0"]),
        _case("subtract_keep", "subtract", T10, [T6], ["body_u0"], keep_tools=True),
        _case("subtract_split", "subtract", T10, [SLAB], ["body_u0"]),
    ]
    fixture = {"cases": cases}
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "booleanSolve.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path} ({len(cases)} cases)")
    for c in cases:
        print(f"  {c['name']}: result={c['result']}, bodies={list(c['store'].keys())}")


if __name__ == "__main__":
    main()
