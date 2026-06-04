"""Generate the regression baseline for the WASM kernel migration harness.

Constructs a curated set of PartDoc specs covering every feature kind and
runs them through the Python kernel.  The output is written to
``frontend/src/wasm-kernel/regression-baseline.json`` and serves as the
ground truth that the vitest harness (and eventually the TS/WASM kernel)
checks against.

Usage::

  python tests/wasm_harness/extract_fixtures.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

# Allow importing from tests/ even when run as a script
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from tests.wasm_harness.run_kernel import run_specs  # noqa: E402
from tests.solver_helpers import (  # noqa: E402
    rect_sketch_spec,
    extrude_spec,
    hole_spec,
    point_sketch_spec,
)
from tests.parseable_fixture import make_sketch, make_doc  # noqa: E402

OUTPUT_PATH = Path(__file__).resolve().parent.parent.parent / "frontend" / "src" / "wasm-kernel" / "regression-baseline.json"


def _make_fixtures() -> list[dict[str, Any]]:
    """Return the fixture list: one entry per spec, with a label."""
    fixtures: list[dict[str, Any]] = []

    # ── 0. Empty doc ──────────────────────────────────────────────────
    fixtures.append({
        "label": "empty_doc",
        "spec": make_doc(),
    })

    # ── 1. Single sketch: fully-constrained rectangle ─────────────────
    fixtures.append({
        "label": "rect_sketch_10x10",
        "spec": make_doc(rect_sketch_spec(w=10, h=10, sketch_id="sk1")),
    })

    # ── 2. Single sketch: underconstrained (just lines, no constraints)
    line_sketch = make_sketch("sk1", entities=[
        {"id": "line1", "kind": "line"},
    ], initial={"line1": [0, 0, 10, 0]})
    fixtures.append({
        "label": "line_sketch_unconstrained",
        "spec": make_doc(line_sketch),
    })

    # ── 3. Extrude: single box ───────────────────────────────────────
    sk = rect_sketch_spec(w=5, h=5, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=5)
    fixtures.append({
        "label": "box_extrude_5x5x5",
        "spec": make_doc(sk, ex),
    })

    # ── 4. Extrude: cut ──────────────────────────────────────────────
    sk_base = rect_sketch_spec(w=10, h=10, sketch_id="sk_base")
    ex_base = extrude_spec("sk_base", "ex_base", distance=5)
    sk_hole = rect_sketch_spec(w=4, h=4, sketch_id="sk_hole")
    ex_cut = extrude_spec("sk_hole", "ex_cut", distance=5, operation="cut")
    fixtures.append({
        "label": "box_with_cut_10x10",
        "spec": make_doc(sk_base, ex_base, sk_hole, ex_cut),
    })

    # ── 5. Extrude: operation=new (second body) ──────────────────────
    sk1 = rect_sketch_spec(w=3, h=3, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=3)
    sk2 = rect_sketch_spec(w=2, h=2, sketch_id="sk2")
    ex2 = extrude_spec("sk2", "ex2", distance=2, operation="new")
    fixtures.append({
        "label": "two_bodies_new_operation",
        "spec": make_doc(sk1, ex1, sk2, ex2),
    })

    # ── 6. Revolve ───────────────────────────────────────────────────
    # Use a rectangle offset from Y axis so revolving produces a ring
    revolve_sketch = rect_sketch_spec(w=2, h=1, sketch_id="sk1")
    # Shift rectangle to x=[1,3]
    for key in revolve_sketch["initial"]:
        vals = revolve_sketch["initial"][key]
        revolve_sketch["initial"][key] = [vals[0] + 1, vals[1], vals[2] + 1, vals[3]]
    revolve_feat = {
        "id": "rev1",
        "kind": "revolve",
        "label": "Revolve",
        "sketch": "$sk1",
        "angle": 360,
        "axis_origin": [0, 0, 0],
        "axis_direction": [0, 1, 0],
    }
    fixtures.append({
        "label": "revolve_360deg",
        "spec": make_doc(revolve_sketch, revolve_feat),
    })

    # ── 7. Hole ──────────────────────────────────────────────────────
    sk_box = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex_box = extrude_spec("sk1", "ex1", distance=5)
    pt_sk = point_sketch_spec([(5, 5)], sketch_id="pts")
    hole = hole_spec("pts", "hole1", diameter=3, depth=5, depth_mode="blind")
    fixtures.append({
        "label": "box_with_hole",
        "spec": make_doc(sk_box, ex_box, pt_sk, hole),
    })

    # ── 8. Fillet ────────────────────────────────────────────────────
    sk_b3 = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex_b3 = extrude_spec("sk1", "ex1", distance=5)
    fillet_feat = {
        "id": "fillet1",
        "kind": "fillet",
        "label": "Fillet",
        "edges": ["?body_ex1:edge:0"],
        "radius": 1.0,
    }
    fixtures.append({
        "label": "box_with_fillet",
        "spec": make_doc(sk_b3, ex_b3, fillet_feat),
    })

    # ── 9. Chamfer ───────────────────────────────────────────────────
    chamfer_feat = {
        "id": "chamfer1",
        "kind": "chamfer",
        "label": "Chamfer",
        "edges": ["?body_ex1:edge:0"],
        "distance": 1.0,
    }
    fixtures.append({
        "label": "box_with_chamfer",
        "spec": make_doc(sk_b3, ex_b3, chamfer_feat),
    })

    # ── 10. Boolean (union) ──────────────────────────────────────────
    sk_a = rect_sketch_spec(w=4, h=4, sketch_id="sk_a")
    ex_a = extrude_spec("sk_a", "ex_a", distance=10, operation="new")
    sk_b = rect_sketch_spec(w=4, h=4, sketch_id="sk_b")
    ex_b = extrude_spec("sk_b", "ex_b", distance=3, operation="new")
    boolean_feat = {
        "id": "bool1",
        "kind": "boolean",
        "boolean": {
            "operation": "union",
            "target": "@ex_a",
            "tools": ["@ex_b"],
        },
    }
    fixtures.append({
        "label": "boolean_union",
        "spec": make_doc(sk_a, ex_a, sk_b, ex_b, boolean_feat),
    })

    # ── 11. Sketch with skyline constraints (circle + tangent) ───────
    circle_sketch = make_sketch("sk1", plane="@builtin_plane_front", entities=[
        {"id": "line1", "kind": "line"},
        {"id": "circle1", "kind": "circle"},
    ], initial={
        "line1": [0, 5, 10, 5],
        "circle1": [5, 0, 2],
    }, constraints=[
        {"id": "c_h", "kind": "horizontal", "target": {"entity": "line1"}},
        {"id": "c_t", "kind": "tangent",
         "line": {"entity": "line1"}, "arc": {"entity": "circle1"}},
    ])
    fixtures.append({
        "label": "sketch_circle_tangent_line",
        "spec": make_doc(circle_sketch),
    })

    # ── 12. Arc sketch ───────────────────────────────────────────────
    arc_sketch = make_sketch("sk1", plane="@builtin_plane_front", entities=[
        {"id": "arc1", "kind": "arc"},
    ], initial={
        "arc1": [0, 0, 5, 0, 90],
    })
    fixtures.append({
        "label": "sketch_arc",
        "spec": make_doc(arc_sketch),
    })

    # ── 13. Plane feature ────────────────────────────────────────────
    plane_feat = {
        "id": "pl1",
        "kind": "plane",
        "definition": {
            "mode": "offset",
            "plane": "@builtin_plane_front",
            "offset": 10.0,
        },
    }
    fixtures.append({
        "label": "plane_offset_10",
        "spec": make_doc(plane_feat),
    })

    # ── 14. Array (rectangular) ──────────────────────────────────────
    sk_arr = rect_sketch_spec(w=3, h=3, sketch_id="sk1")
    ex_arr = extrude_spec("sk1", "ex1", distance=2)
    array_feat = {
        "id": "array1",
        "kind": "array",
        "array": {
            "mode": "rectangular",
            "source_body": "@ex1",
            "count_x": 3,
            "pitch_x": 5,
            "count_y": 2,
            "pitch_y": 5,
        },
    }
    fixtures.append({
        "label": "array_rectangular_3x2",
        "spec": make_doc(sk_arr, ex_arr, array_feat),
    })

    # ── 15. Mirror ───────────────────────────────────────────────────
    mirror_feat = {
        "id": "mirror1",
        "kind": "mirror",
        "mirror": {
            "body": "@ex1",
            "operation": "new",
            "plane": "@builtin_plane_right",
        },
    }
    fixtures.append({
        "label": "mirror_plane_right",
        "spec": make_doc(sk_arr, ex_arr, mirror_feat),
    })

    # ── 16. Point sketch (fixed constraint) ──────────────────────────
    pt_fixed_sketch = make_sketch("sk1", plane="@builtin_plane_front", entities=[
        {"id": "p1", "kind": "point"},
        {"id": "p2", "kind": "point"},
    ], initial={
        "p1": [0, 0],
        "p2": [3, 4],
    }, constraints=[
        {"id": "c_fix", "kind": "fixed", "target": {"entity": "p1"}, "x": 0, "y": 0},
    ])
    fixtures.append({
        "label": "sketch_fixed_point",
        "spec": make_doc(pt_fixed_sketch),
    })

    # ── 17. Angle constraint ─────────────────────────────────────────
    angle_sketch = make_sketch("sk1", plane="@builtin_plane_front", entities=[
        {"id": "line1", "kind": "line"},
        {"id": "line2", "kind": "line"},
    ], initial={
        "line1": [0, 0, 10, 0],
        "line2": [0, 0, 5, 8],
    }, constraints=[
        {"id": "c_fix", "kind": "fixed",
         "target": {"entity": "line1", "point": "start"}, "x": 0, "y": 0},
        {"id": "c_h", "kind": "horizontal", "target": {"entity": "line1"}},
        {"id": "c_ang", "kind": "angle",
         "a": {"entity": "line1"}, "b": {"entity": "line2"},
         "value": 45},
    ])
    fixtures.append({
        "label": "sketch_angle_45",
        "spec": make_doc(angle_sketch),
    })

    # ── 18. Coincident constraint ────────────────────────────────────
    coinc_sketch = make_sketch("sk1", plane="@builtin_plane_front", entities=[
        {"id": "p1", "kind": "point"},
        {"id": "p2", "kind": "point"},
    ], initial={
        "p1": [0, 0],
        "p2": [5, 3],
    }, constraints=[
        {"id": "c_fix", "kind": "fixed", "target": {"entity": "p1"}, "x": 0, "y": 0},
        {"id": "c_coin", "kind": "coincident",
         "a": {"entity": "p1"}, "b": {"entity": "p2"}},
    ])
    fixtures.append({
        "label": "sketch_coincident_points",
        "spec": make_doc(coinc_sketch),
    })

    # ── 19. Distance constraint ──────────────────────────────────────
    dist_sketch = make_sketch("sk1", plane="@builtin_plane_front", entities=[
        {"id": "p1", "kind": "point"},
        {"id": "p2", "kind": "point"},
    ], initial={
        "p1": [0, 0],
        "p2": [8, 6],
    }, constraints=[
        {"id": "c_fix1", "kind": "fixed", "target": {"entity": "p1"}, "x": 0, "y": 0},
        {"id": "c_dist", "kind": "point_distance",
         "a": {"entity": "p1"}, "b": {"entity": "p2"},
         "value": 10},
    ])
    fixtures.append({
        "label": "sketch_distance_10",
        "spec": make_doc(dist_sketch),
    })

    return fixtures


def main() -> None:
    fixtures = _make_fixtures()
    print(f"Running {len(fixtures)} fixtures through Python kernel...", file=sys.stderr)
    results = run_specs(fixtures)

    ok_count = sum(1 for r in results if r["ok"])
    err_count = len(results) - ok_count
    print(f"  ok={ok_count} errors={err_count}", file=sys.stderr)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT_PATH, "w") as f:
        json.dump(results, f, indent=2, sort_keys=True)
    print(f"Written to {OUTPUT_PATH}", file=sys.stderr)


if __name__ == "__main__":
    main()
