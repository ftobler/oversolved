"""Generate reference geometry hashes for the TS geomHash.ts parity test.

Runs the canonical `oversolved.kernel.geom_hash` functions over a battery of
inputs chosen to stress the float-rounding / shortest-repr boundary (negatives,
negative zero, integer-valued floats, half-way rounding, tiny magnitudes,
radians-vs-degrees arc angles, spline curve_data with mixed scalar types) and
writes `frontend/src/kernel/occ/__fixtures__/geomHashes.json`. The TS test feeds
the same inputs through the port and asserts every digest matches byte-for-byte.

Run: .venv/bin/python tests/wasm_harness/gen_geomhash_fixture.py
"""

import json
import math
import os

from oversolved.kernel import geom_hash as gh


def _faces():
    cases = [
        {"centroid": [5.0, 5.0, 0.0], "normal": [0.0, 0.0, -1.0]},
        {"centroid": [-2.675, 0.12345, 99999.99995], "normal": [0.5773502691896258] * 3},
        {"centroid": [-1.25, 0.00004, 0.00006], "normal": [-0.00006, 1.0000000001, 0.0]},
        {"centroid": [1234567.89012, 0.123449999, 123.45605], "normal": [0.0, -0.0001, 0.7071067811865476]},
    ]
    return [
        {
            "centroid": c["centroid"],
            "normal": c["normal"],
            "face_geometry_hash": gh.face_geometry_hash(c["centroid"], c["normal"]),
            "face_normal_hash": gh.face_normal_hash(c["normal"]),
        }
        for c in cases
    ]


def _edges():
    cases = [
        {"kind": "line", "start": [0.0, 0.0, 0.0], "end": [10.0, 0.0, 0.0]},
        {"kind": "line", "start": [-1.5, 2.25, -7.125], "end": [3.33333, 4.44444, 5.55555]},
        {"kind": "circle", "radius": 3.0, "center": [0.0, 0.0, 0.0]},
        {"kind": "circle", "radius": 2.675, "center": [-2.675, 0.00006, 99999.99995]},
        # arc with degree angle keys + orientation axes
        {
            "kind": "arc", "radius": 5.0, "center": [1.0, 2.0, 3.0],
            "angle_start_deg": 0.0, "angle_end_deg": 180.0,
            "axis": [0.0, 0.0, 1.0], "x_axis": [1.0, 0.0, 0.0],
        },
        # arc with radian angle keys (converted to degrees) + non-default axes
        {
            "kind": "arc", "radius": 5.0, "center": [1.0, 2.0, 3.0],
            "angle_start": 0.0, "angle_end": math.pi,
            "axis": [0.0, 0.0, -1.0], "x_axis": [-1.0, 0.0, 0.0],
        },
        # arc using all defaults for axis/x_axis
        {
            "kind": "arc", "radius": 1.5, "center": [0.0, 0.0, 0.0],
            "angle_start_deg": 45.0, "angle_end_deg": 135.0,
        },
        # spline via exact curve_data: nested control points, flat float knots,
        # a string type tag, and bools (Python bool-is-int -> "0"/"1"). The
        # integer-typed `degree` scalar is intentionally omitted: JS cannot
        # distinguish an int from a float-valued number, so degree's int
        # formatting is a parity gap deferred to the spline-reader port (2e/2f).
        {
            "kind": "spline",
            "curve_data": {
                "control_points": [[0.0, 0.0, 0.0], [1.0, 2.0, 0.0], [3.3333, -4.4444, 5.5555]],
                "knots": [0.0, 0.0, 1.0, 1.0],
                "periodic": False,
                "rational": True,
                "type": "BSpline",
            },
        },
        # spline fallback to sampled points (no curve_data)
        {"kind": "spline", "points": [[0.0, 0.0, 0.0], [1.1111, 2.2222, 3.3333]]},
        # unknown kind, no curve_data, no points -> default point
        {"kind": "mystery"},
    ]
    return [{"edge": c, "edge_geometry_hash": gh.edge_geometry_hash(c)} for c in cases]


def _vertices():
    cases = [
        [0.0, 0.0, 0.0],
        [-3.5, 0.00004, 0.00006],
        [1234567.89012, -2.675, 0.12345],
    ]
    return [{"pt": p, "vertex_geometry_hash": gh.vertex_geometry_hash(p)} for p in cases]


def _classifiers():
    cases = [
        {"point": [10.0, 0.0, 5.0], "center": [0.0, 0.0, 0.0], "half_extents": [10.0, 10.0, 5.0]},
        {"point": [-10.0, -10.0, -5.0], "center": [0.0, 0.0, 0.0], "half_extents": [10.0, 10.0, 5.0]},
        {"point": [0.0, 0.0, 0.0], "center": [0.0, 0.0, 0.0], "half_extents": [10.0, 0.0, 5.0]},
        {"point": [1.0, 1.0, 1.0], "center": [0.0, 0.0, 0.0], "half_extents": [10.0, 10.0, 10.0]},
    ]
    return [
        {**c, "classifiers": gh.geometry_classifiers(c["point"], c["center"], c["half_extents"])}
        for c in cases
    ]


def main():
    fixture = {
        "faces": _faces(),
        "edges": _edges(),
        "vertices": _vertices(),
        "classifiers": _classifiers(),
        "geom_keyed_lineage": [
            {"lineage": {"gface_abc": 1}, "prefix": "gface_", "expected": True},
            {"lineage": {"gedge_abc": 1}, "prefix": "gface_", "expected": False},
            {"lineage": {"123": 1}, "prefix": "gedge_", "expected": False},
            {"lineage": {}, "prefix": "gface_", "expected": False},
            {"lineage": None, "prefix": "gface_", "expected": False},
        ],
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "geomHashes.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
