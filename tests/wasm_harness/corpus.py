"""Parametric corpus for the WASM full-doc parity gate (phase 4b.4).

The 20 hand specs in ``extract_fixtures.py`` are curated regression anchors and
stay as-is. This module *grows* them into a parametric corpus, tagged by
feature kind + query tier, so the TS-vs-Python full-doc gate measures broad
coverage rather than 20 points.

It leads with the under-measured paths the handoff flags (handoff lines 18-23):
**picks** (features that read solved geometry/topology back through a query) and
**dimensions** (fully-constrained sketches whose solved coords are gauge-compared).

Each family yields ``{"label", "spec", "tags": {"feature_kind", "query_tier"}}``.
``run_specs`` ignores the ``tags`` key; ``extract_fixtures`` peels it off into a
separate coverage manifest, so the baseline schema is untouched.

Query tiers:
- ``dimension_*``  fully-constrained sketch; solved geometry compared (Rust LM vs scipy)
- ``slash_point``  hole reads a sketch point via the @feature/entity/xy slash registry
- ``edge_query``   fillet/chamfer resolves a B-rep edge by query
- ``plane_query``  mirror resolves a builtin plane registered as a repo element
"""

from __future__ import annotations

from typing import Any

from solver_helpers import rect_sketch_spec, extrude_spec, point_sketch_spec, hole_spec
from parseable_fixture import make_sketch, make_doc

ORIGIN = "@builtin_origin"


def _case(label: str, spec: dict, feature_kind: str, query_tier: str) -> dict[str, Any]:
    return {"label": label, "spec": spec, "tags": {"feature_kind": feature_kind, "query_tier": query_tier}}


# ─── Pick families (read solved state back through a query) ───

def _hole_at_points(n: int) -> dict:
    """Box + an n-point sketch + a hole; exercises the @sketch/pt/xy slash registry."""
    pts = [(2.0 + 2.0 * i, 2.0 + 1.0 * i) for i in range(n)]
    sk_box = rect_sketch_spec(w=12, h=12, sketch_id="sk1")
    ex_box = extrude_spec("sk1", "ex1", distance=5)
    pt_sk = point_sketch_spec(pts, sketch_id="pts")
    hole = hole_spec("pts", "hole1", diameter=2, depth=5, depth_mode="blind")
    return make_doc(sk_box, ex_box, pt_sk, hole)


def _fillet_edge(idx: int, radius: float) -> dict:
    sk = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=5)
    feat = {"id": "fillet1", "kind": "fillet", "edges": [f"?body_ex1:edge:{idx}"], "radius": radius}
    return make_doc(sk, ex, feat)


def _chamfer_edge(idx: int, distance: float) -> dict:
    sk = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=5)
    feat = {"id": "chamfer1", "kind": "chamfer", "edges": [f"?body_ex1:edge:{idx}"], "distance": distance}
    return make_doc(sk, ex, feat)


def _mirror_about(plane: str) -> dict:
    sk = rect_sketch_spec(w=4, h=6, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=3)
    feat = {"id": "mirror1", "kind": "mirror",
            "mirror": {"body": "@ex1", "operation": "new", "plane": f"@{plane}"}}
    return make_doc(sk, ex, feat)


# ─── Dimension families (fully constrained -> solved coords compared) ───

def _dim_rect(w: float, h: float) -> dict:
    """Rectangle anchored at the origin so it is fully constrained (not just shape-locked)."""
    sk = rect_sketch_spec(w=w, h=h, sketch_id="sk1")
    sk["constraints"].append(
        {"id": "c_anchor", "kind": "fixed", "target": {"entity": "bottom", "point": "start"}, "x": 0, "y": 0}
    )
    return make_doc(sk)


def _dim_line_len(length: float) -> dict:
    sk = make_sketch("sk1", entities=[{"id": "l1", "kind": "line"}], initial={"l1": [0, 0, length, 0]}, constraints=[
        {"id": "c_fix", "kind": "fixed", "target": {"entity": "l1", "point": "start"}, "x": 0, "y": 0},
        {"id": "c_h", "kind": "horizontal", "target": {"entity": "l1"}},
        {"id": "c_len", "kind": "length", "target": {"entity": "l1"}, "value": length},
    ])
    return make_doc(sk)


def _dim_circle_dia(diameter: float) -> dict:
    sk = make_sketch("sk1", entities=[{"id": "c1", "kind": "circle"}], initial={"c1": [0, 0, diameter / 2.0]}, constraints=[
        {"id": "c_fix", "kind": "fixed", "target": {"entity": "c1", "point": "center"}, "x": 0, "y": 0},
        {"id": "c_dia", "kind": "diameter", "target": {"entity": "c1"}, "value": diameter, "pos": [0, 0]},
    ])
    return make_doc(sk)


def _dim_angle(angle_deg: float) -> dict:
    """Two lines sharing a fixed origin: line1 horizontal len 10, line2 at the dimensioned angle len 8."""
    import math
    a = math.radians(angle_deg)
    sk = make_sketch("sk1",
                     entities=[{"id": "l1", "kind": "line"}, {"id": "l2", "kind": "line"}],
                     initial={"l1": [0, 0, 10, 0], "l2": [0, 0, 8 * math.cos(a), 8 * math.sin(a)]},
                     constraints=[
                         {"id": "c_fix", "kind": "fixed", "target": {"entity": "l1", "point": "start"}, "x": 0, "y": 0},
                         {"id": "c_h", "kind": "horizontal", "target": {"entity": "l1"}},
                         {"id": "c_len1", "kind": "length", "target": {"entity": "l1"}, "value": 10},
                         {"id": "c_coin", "kind": "coincident",
                          "a": {"entity": "l1", "point": "start"}, "b": {"entity": "l2", "point": "start"}},
                         {"id": "c_len2", "kind": "length", "target": {"entity": "l2"}, "value": 8},
                         {"id": "c_ang", "kind": "angle", "a": {"entity": "l1"}, "b": {"entity": "l2"}, "value": angle_deg},
                     ])
    return make_doc(sk)


def parametric_fixtures() -> list[dict[str, Any]]:
    """Return the tagged parametric corpus, picks and dimensions first."""
    out: list[dict[str, Any]] = []

    # Picks first (the under-measured paths).
    for n in (1, 2, 3):
        out.append(_case(f"pick_hole_{n}pt", _hole_at_points(n), "hole", "slash_point"))
    for idx in (0, 1):
        out.append(_case(f"pick_fillet_edge{idx}", _fillet_edge(idx, 1.0), "fillet", "edge_query"))
        out.append(_case(f"pick_chamfer_edge{idx}", _chamfer_edge(idx, 1.0), "chamfer", "edge_query"))
    for plane in ("builtin_plane_front", "builtin_plane_top", "builtin_plane_right"):
        short = plane.replace("builtin_plane_", "")
        out.append(_case(f"pick_mirror_{short}", _mirror_about(plane), "mirror", "plane_query"))

    # Origin-coincident patterns (exercises @builtin_origin resolution).
    for dia in (6, 12):
        out.append(_case(f"origin_circle_dia{dia}", _origin_circle(dia), "sketch", "dimension_radius"))

    # Dimensions.
    for (w, h) in ((5, 5), (8, 4), (12, 7)):
        out.append(_case(f"dim_rect_{w}x{h}", _dim_rect(w, h), "sketch", "dimension_length"))
    for length in (3, 7, 15):
        out.append(_case(f"dim_line_len{length}", _dim_line_len(length), "sketch", "dimension_length"))
    for dia in (4, 10, 20):
        out.append(_case(f"dim_circle_dia{dia}", _dim_circle_dia(dia), "sketch", "dimension_radius"))
    for ang in (30, 45, 60):
        out.append(_case(f"dim_angle_{ang}", _dim_angle(ang), "sketch", "dimension_angle"))

    # Multi-feature chains.
    out.append(_case("chain_extrude_fillet", _extrude_then_fillet(), "fillet", "edge_query"))
    out.append(_case("chain_extrude_cut", _extrude_then_cut(), "boolean", "ancestral"))

    # Sweep (straight Z spine).
    out.append(_case("sweep_straight_z", _sweep_along_z(), "sweep", "ancestral"))

    # Transform.
    out.append(_case("transform_translate", _transform_translate(), "transform", "ancestral"))

    # Circular array.
    out.append(_case("circular_array_3copies", _circular_array_3(), "circular_array", "ancestral"))

    # Boolean intersection.
    out.append(_case("boolean_intersect", _boolean_intersect(), "boolean", "ancestral"))

    return out

# ─── New families ────────────────────────────────────────────────────────

def _origin_circle(diameter: float) -> dict:
    """Circle centred at the origin via coincident-with-@builtin_origin + diameter
    (the pattern gap #1 was about)."""
    sk = make_sketch("sk1", plane="@builtin_plane_front", entities=[{"id": "c1", "kind": "circle"}],
                     initial={"c1": [0.0, 0.0, diameter / 2.0]}, constraints=[
        {"id": "c_coin", "kind": "coincident",
         "a": {"entity": "c1", "point": "center"}, "b": "@builtin_origin"},
        {"id": "c_dia", "kind": "diameter", "target": {"entity": "c1"}, "value": diameter},
    ])
    return make_doc(sk)

def _extrude_then_fillet() -> dict:
    """Box + fillet on edge 0 (multi-feature chain)."""
    sk = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=5)
    fillet = {"id": "fillet1", "kind": "fillet",
               "edges": ["?body_ex1:edge:0"], "radius": 1.5}
    return make_doc(sk, ex, fillet)

def _extrude_then_cut() -> dict:
    """Two overlapping boxes, second subtracts from first."""
    sk1 = rect_sketch_spec(w=10, h=10, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=8)
    sk2 = rect_sketch_spec(w=4, h=4, sketch_id="sk2")
    ex2 = {**extrude_spec("sk2", "ex2", distance=8), "operation": "cut"}
    return make_doc(sk1, ex1, sk2, ex2)

def _revolve_then_hole() -> dict:
    """Revolved rectangle makes a cylinder, then drill a hole."""
    sk = rect_sketch_spec(w=4, h=6, sketch_id="sk1")
    rev = {"id": "rev1", "kind": "revolve",
           "revolve": {"sketch": "@sk1", "angle": 360, "axis_origin": [0, 6, 0],
                        "axis_direction": [0, 1, 0], "operation": "new"}}
    pt_sk = point_sketch_spec([(0, 0)], sketch_id="pt_sk")
    hole = {"id": "hole1", "kind": "hole",
            "hole": {"sketch": "@pt_sk", "diameter": 2, "depth": 10,
                     "depth_mode": "blind", "direction": "normal", "target": "@rev1"}}
    return make_doc(sk, rev, pt_sk, hole)

def _sweep_along_z() -> dict:
    """Sweep a 3x3 profile along a vertical Z line spine."""
    prof_sk = rect_sketch_spec(w=3, h=3, sketch_id="prof", plane="@builtin_plane_top")
    spine_sk = make_sketch("spine", plane="@builtin_plane_front",
                           entities=[{"id": "s1", "kind": "line"}],
                           initial={"s1": [0, 0, 0, 10]}, constraints=[
        {"id": "c_fix", "kind": "fixed", "target": {"entity": "s1", "point": "start"}, "x": 0, "y": 0},
        {"id": "c_v", "kind": "vertical", "target": {"entity": "s1"}},
    ])
    sweep = {"id": "sw1", "kind": "sweep",
             "sweep": {"profile": "@prof", "path": "$spine.s1", "operation": "new"}}
    return make_doc(prof_sk, spine_sk, sweep)

def _transform_translate() -> dict:
    """Translate a box by [4, 2, 0]."""
    sk = rect_sketch_spec(w=5, h=5, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=5)
    tr = {"id": "tr1", "kind": "transform",
          "transform": {"body": "@ex1", "operation": "new",
                        "translation": [4, 2, 0], "rotation_angle": 0, "scale": 1}}
    return make_doc(sk, ex, tr)

def _circular_array_3() -> dict:
    """Circular array of a small box: 3 copies around Z."""
    sk = rect_sketch_spec(w=2, h=2, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=2)
    arr = {"id": "arr1", "kind": "circular_array",
           "circular_array": {"body": "@ex1", "count": 3, "include_source": True,
                              "operation": "add", "axis_origin": [0, 0, 0],
                              "axis_direction": [0, 0, 1]}}
    return make_doc(sk, ex, arr)

def _boolean_intersect() -> dict:
    """Union two boxes then intersect."""
    sk1 = rect_sketch_spec(w=5, h=5, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5)
    sk2 = rect_sketch_spec(w=3, h=3, sketch_id="sk2")
    ex2 = {**extrude_spec("sk2", "ex2", distance=5), "operation": "add"}
    boolean = {"id": "bool1", "kind": "boolean",
               "boolean": {"target": "@ex1", "tool": "@ex2", "operation": "intersect", "keep_tools": False}}
    return make_doc(sk1, ex1, sk2, ex2, boolean)
