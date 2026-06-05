"""Generate reference face/edge lineage for the TS booleanLineage.ts gate (2e).

Runs the canonical _transfer_boolean_lineage over a cut of two overlapping boxes
with geometry-derived lineage tokens, and records the resulting body.face_lineage
+ body.edge_lineage. Writes
`frontend/src/kernel/occ/__fixtures__/booleanLineage.json`.

Tokens are keyed by face_geometry_hash and the token value embeds the hash
(`@T/<gh>` for target faces, `@U/<gh>` for tool faces), so the input maps are a
pure function of geometry -- the TS gate feeds the same recorded input maps and
asserts the output lineage matches, which also exercises geom-hash parity (the
output keys are recomputed by the TS port from its own OCC face reads).

Run: .venv/bin/python tests/wasm_harness/gen_boolean_lineage_fixture.py
"""

import json
import os

from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_FACE
import cadquery.occ_impl.shapes as cq_shapes

from oversolved.kernel.cadquery_ops import (
    boolean_cut_with_diff,
    _compute_face_centroid,
    _compute_face_normal,
    _ensure_occ,
)
from oversolved.kernel.geom_hash import face_geometry_hash
from oversolved.kernel.types3d import Body
from oversolved.kernel.solver_features_shared import _transfer_boolean_lineage

TARGET = (10.0, 10.0, 10.0)
TOOL = (4.0, 4.0, 4.0)


def _face_lineage(shape, prefix):
    """{face_geometry_hash: [f'@{prefix}/<hash>']} over every face of shape."""
    occ = _ensure_occ(shape)
    exp = TopExp_Explorer(occ, TopAbs_FACE)
    out = {}
    while exp.More():
        cq_f = cq_shapes.Shape.cast(exp.Current())
        gh = face_geometry_hash(_compute_face_centroid(cq_f), _compute_face_normal(cq_f))
        out[gh] = [f"@{prefix}/{gh}"]
        exp.Next()
    return out


def main():
    target = BRepPrimAPI_MakeBox(*TARGET).Shape()
    tool = BRepPrimAPI_MakeBox(*TOOL).Shape()

    target_lineage = _face_lineage(target, "T")
    tool_lineage = _face_lineage(tool, "U")

    shape, diff = boolean_cut_with_diff(target, tool)

    body = Body(
        id="body_t",
        created_by="featT",
        shape=_ensure_occ(shape),
        brep_diff=diff,
        face_lineage=dict(target_lineage),
    )
    _transfer_boolean_lineage(body, _ensure_occ(target), _ensure_occ(tool),
                              tool_lineage, None)

    # Sort token lists for order-insensitive comparison.
    def _sorted(d):
        return {k: sorted(v) for k, v in d.items()}

    fixture = {
        "target": TARGET,
        "tool": TOOL,
        "target_face_lineage": target_lineage,
        "tool_face_lineage": tool_lineage,
        "result_face_lineage": _sorted(body.face_lineage),
        "result_edge_lineage": _sorted(body.edge_lineage),
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "booleanLineage.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path}: "
          f"{len(fixture['result_face_lineage'])} face / "
          f"{len(fixture['result_edge_lineage'])} edge lineage entries")


if __name__ == "__main__":
    main()
