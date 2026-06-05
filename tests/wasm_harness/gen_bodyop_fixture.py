"""Generate reference body-store state for the TS bodyOps.ts gate (phase 2e).

Runs the canonical `_apply_body_operation` over new/cut/add scenarios on
overlapping boxes with geometry-derived lineage tokens, and records the result
dict plus, for every body left in the store, its volume / created_by /
modified_by / face_lineage / edge_lineage. Writes
`frontend/src/kernel/occ/__fixtures__/bodyOps.json`.

The TS gate (bodyOpsReal.test.ts) builds the same boxes via the OCC adapter,
runs the ported `applyBodyOperation`, and asserts the same body-store state and
result dicts. Boxes are origin-built so the geometry matches the TS makeBox path
and the geom-hash-keyed lineage tokens line up across the two kernels.

Run: .venv/bin/python tests/wasm_harness/gen_bodyop_fixture.py
"""

import json
import os

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.BRepGProp import BRepGProp
from OCP.GProp import GProp_GProps
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
import cadquery.occ_impl.shapes as cq_shapes

from oversolved.kernel.cadquery_ops import (
    _compute_face_centroid,
    _compute_face_normal,
    _ensure_occ,
)
from oversolved.kernel.geom_hash import face_geometry_hash
from oversolved.kernel.types3d import Body
from oversolved.kernel.solver_features_shared import _apply_body_operation

TARGET = (10.0, 10.0, 10.0)
TOOL = (4.0, 4.0, 4.0)


def _box(dims):
    return BRepPrimAPI_MakeBox(*dims).Shape()


def _volume(shape):
    props = GProp_GProps()
    BRepGProp.VolumeProperties_s(_ensure_occ(shape), props)
    return float(props.Mass())


def _face_lineage(shape, prefix):
    occ = _ensure_occ(shape)
    exp = TopExp_Explorer(occ, TopAbs_FACE)
    out = {}
    while exp.More():
        cq_f = cq_shapes.Shape.cast(exp.Current())
        gh = face_geometry_hash(_compute_face_centroid(cq_f), _compute_face_normal(cq_f))
        out[gh] = [f"@{prefix}/{gh}"]
        exp.Next()
    return out


def _dump_store(store):
    out = {}
    for bid, b in store.items():
        out[bid] = {
            "volume": _volume(b.shape) if b.shape is not None else None,
            "created_by": b.created_by,
            "modified_by": list(b.modified_by),
            "face_lineage": {k: sorted(v) for k, v in b.face_lineage.items()},
            "edge_lineage": {k: sorted(v) for k, v in b.edge_lineage.items()},
        }
    return out


def _scenario_new():
    tool = _box(TOOL)
    tool_lineage = _face_lineage(tool, "U")
    store = {}
    result = _apply_body_operation(
        _ensure_occ(tool), store, "new", None, "body_f", "featF", "skF",
        op_name="extrude", profile_queries=["?p"], face_lineage=tool_lineage,
    )
    return {"tool_face_lineage": tool_lineage, "result": result, "store": _dump_store(store)}


def _scenario_cut():
    target = _box(TARGET)
    tool = _box(TOOL)
    target_lineage = _face_lineage(target, "T")
    tool_lineage = _face_lineage(tool, "U")
    store = {
        "body_t": Body(id="body_t", created_by="featT", shape=_ensure_occ(target),
                       sketch_id="skT", face_lineage=dict(target_lineage)),
    }
    result = _apply_body_operation(
        _ensure_occ(tool), store, "cut", None, "body_f", "featF", "skF",
        op_name="extrude", profile_queries=["?p"], face_lineage=tool_lineage,
    )
    return {
        "target_face_lineage": target_lineage, "tool_face_lineage": tool_lineage,
        "result": result, "store": _dump_store(store),
    }


def _scenario_add_fuse():
    target = _box(TARGET)
    tool = _box(TOOL)
    target_lineage = _face_lineage(target, "T")
    tool_lineage = _face_lineage(tool, "U")
    store = {
        "body_t": Body(id="body_t", created_by="featT", shape=_ensure_occ(target),
                       sketch_id="skT", face_lineage=dict(target_lineage)),
    }
    result = _apply_body_operation(
        _ensure_occ(tool), store, "add", "body_t", "body_f", "featF", "skF",
        op_name="extrude", profile_queries=["?p"], face_lineage=tool_lineage,
    )
    return {
        "target_face_lineage": target_lineage, "tool_face_lineage": tool_lineage,
        "result": result, "store": _dump_store(store),
    }


def main():
    fixture = {
        "target": TARGET,
        "tool": TOOL,
        "new": _scenario_new(),
        "cut": _scenario_cut(),
        "add_fuse": _scenario_add_fuse(),
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "bodyOps.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path}")
    for s in ("new", "cut", "add_fuse"):
        bodies = fixture[s]["store"]
        vols = {k: round(v["volume"], 1) for k, v in bodies.items()}
        print(f"  {s}: result={fixture[s]['result']} volumes={vols}")


if __name__ == "__main__":
    main()
