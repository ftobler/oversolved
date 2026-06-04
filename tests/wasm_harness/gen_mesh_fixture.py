"""Generate reference meshes for the TS tessellation.ts dual-run parity test.

Builds the same solids the TS make-a-body path builds (box, cylinder, extruded
square), tessellates them with the canonical `solid_to_mesh`, and writes
`frontend/src/kernel/occ/__fixtures__/meshFixtures.json`. The TS test builds the
same solids with OCC.js, tessellates with `solidToMesh`, and asserts mesh
parity (vertex/triangle counts, vertex multiset, sorted face_data) within
tessellation tolerance.

Run: .venv/bin/python tests/wasm_harness/gen_mesh_fixture.py
"""

import json
import os

from cadquery.occ_impl import shapes as cq_shapes
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox

from oversolved.kernel.cadquery_ops import (
    extrude_face,
    make_cylinder,
    make_face_from_wires,
    make_line_edge,
    make_wire,
)
from oversolved.kernel.geometry_tessellation import solid_to_mesh


def _box_solid(dx, dy, dz):
    return cq_shapes.Shape.cast(BRepPrimAPI_MakeBox(dx, dy, dz).Shape())


def _extruded_square(side, height):
    loop = [[0, 0, 0], [side, 0, 0], [side, side, 0], [0, side, 0]]
    edges = [make_line_edge(loop[i], loop[(i + 1) % len(loop)]) for i in range(len(loop))]
    wire = make_wire(edges)
    face = make_face_from_wires(wire)
    return extrude_face(face, [0.0, 0.0, 1.0], height)


def _mesh_payload(solid):
    m = solid_to_mesh(solid)
    return {
        "vertices": m["vertices"],
        "faces": m["faces"],
        "triangle_to_face": m["triangle_to_face"],
        "face_data": [
            {
                "centroid": fd["centroid"],
                "normal": fd["normal"],
                "area": fd["area"],
                "surface_type": fd["surface_type"],
            }
            for fd in m["face_data"]
        ],
    }


def main():
    fixtures = {
        "box_10x10x5": {
            "kind": "box",
            "params": {"dx": 10.0, "dy": 10.0, "dz": 5.0},
            "mesh": _mesh_payload(_box_solid(10.0, 10.0, 5.0)),
        },
        "cylinder_r3_h10": {
            "kind": "cylinder",
            "params": {"center": [0.0, 0.0, 0.0], "axis": [0.0, 0.0, 1.0], "radius": 3.0, "height": 10.0},
            "mesh": _mesh_payload(make_cylinder([0.0, 0.0, 0.0], [0.0, 0.0, 1.0], 3.0, 10.0)),
        },
        "extruded_square_10x10x5": {
            "kind": "extrude",
            "params": {
                "loop": [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]],
                "direction": [0.0, 0.0, 1.0],
                "distance": 5.0,
            },
            "mesh": _mesh_payload(_extruded_square(10.0, 5.0)),
        },
    }

    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "meshFixtures.json")
    with open(out_path, "w") as f:
        json.dump(fixtures, f, indent=2)
    counts = {k: (len(v["mesh"]["vertices"]), len(v["mesh"]["faces"])) for k, v in fixtures.items()}
    print(f"wrote {out_path}; (verts, tris) per fixture: {counts}")


if __name__ == "__main__":
    main()
