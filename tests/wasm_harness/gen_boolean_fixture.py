"""Generate reference BrepDiff classification + volume for the TS booleans.ts gate.

Runs the canonical OCP-direct boolean+clean+compose pipeline
(cadquery_ops.boolean_*_with_diff) on a fixed pair of overlapping boxes and
records, per op (cut/fuse/common):
  - the BrepDiff list lengths (new/inherited/modified/deleted faces+edges),
  - the result volume + face/edge/solid counts.

Writes `frontend/src/kernel/occ/__fixtures__/booleanDiff.json`. The gated
real-OCC test (booleansReal.test.ts) builds the same boxes via the OCC adapter,
runs the ported pipeline, and asserts geometry parity (volume, counts) plus the
classification partition. Boxes are built at the origin so no transform is
needed and the geometry matches the TS makeBox path exactly.

Run: .venv/bin/python tests/wasm_harness/gen_boolean_fixture.py
"""

import json
import os

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE, TopAbs_EDGE, TopAbs_SOLID

from oversolved.kernel.cadquery_ops import (
    boolean_cut_with_diff,
    boolean_union_with_diff,
    boolean_intersection_with_diff,
    _ensure_occ,
)

# target: 10x10x10 box at origin; tool: 4x4x4 box at origin -> [0,4]^3 corner overlap.
TARGET = (10.0, 10.0, 10.0)
TOOL = (4.0, 4.0, 4.0)


def _count(shape, kind):
    occ = _ensure_occ(shape)
    exp = TopExp_Explorer(occ, kind)
    n = 0
    while exp.More():
        n += 1
        exp.Next()
    return n


def _volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(shape), props)
    return float(props.Mass())


def _diff_counts(diff):
    return {
        "new_faces": len(diff.new_faces),
        "inherited_faces": len(diff.inherited_faces),
        "new_edges": len(diff.new_edges),
        "inherited_edges": len(diff.inherited_edges),
        "modified_input_faces": len(diff.modified_input_faces),
        "deleted_input_faces": len(diff.deleted_input_faces),
        "modified_input_edges": len(diff.modified_input_edges),
        "deleted_input_edges": len(diff.deleted_input_edges),
    }


def _run(op_fn):
    target = BRepPrimAPI_MakeBox(*TARGET).Shape()
    tool = BRepPrimAPI_MakeBox(*TOOL).Shape()
    shape, diff = op_fn(target, tool)
    return {
        "diff": _diff_counts(diff),
        "volume": _volume(shape),
        "result_faces": _count(shape, TopAbs_FACE),
        "result_edges": _count(shape, TopAbs_EDGE),
        "result_solids": _count(shape, TopAbs_SOLID),
    }


def main():
    fixture = {
        "target": TARGET,
        "tool": TOOL,
        "cut": _run(boolean_cut_with_diff),
        "fuse": _run(boolean_union_with_diff),
        "common": _run(boolean_intersection_with_diff),
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "booleanDiff.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path}")
    for op in ("cut", "fuse", "common"):
        print(f"  {op}: vol={fixture[op]['volume']:.1f} "
              f"faces={fixture[op]['result_faces']} diff={fixture[op]['diff']}")


if __name__ == "__main__":
    main()
