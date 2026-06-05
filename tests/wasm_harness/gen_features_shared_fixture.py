"""Generate reference outputs for the TS features/shared.ts parity test (phase 2e).

Drives the OCC-free functions of solver_features_shared.py over inputs covering
their branches and writes
`frontend/src/kernel/occ/__fixtures__/featuresShared.json`. The TS test
(features/shared.test.ts) feeds identical inputs through the port and asserts
identical outputs. These functions feed the boolean/lineage machinery, so the
gate is exact (coords compared within 1e-9).

Run: .venv/bin/python tests/wasm_harness/gen_features_shared_fixture.py
"""

import json
import os

from oversolved.kernel.query import Repository
from oversolved.kernel.types3d import Body, BrepDiff
from oversolved.kernel.solver_features_shared import (
    _tessellate_edge,
    _extract_profile_loops,
    _register_top_face,
    _resolve_direction,
    _resolve_body,
    _resolve_merge_targets,
    _brep_diff_is_empty,
    _resolve_direction_query,
    _resolve_axis_query,
)


def _tessellate_edge_cases():
    cases = []

    def case(name, edge):
        cases.append({"name": name, "edge": edge, "expected": _tessellate_edge(edge)})

    case("line", {"kind": "line", "start": [0, 0], "end": [3, 4]})
    case("line_default_kind", {"end": [1, 2]})
    case("line_no_end", {"kind": "line"})
    case("arc_ccw_quarter", {
        "kind": "arc", "center": [0, 0], "radius": 5.0,
        "angle_start_deg": 0.0, "angle_end_deg": 90.0, "ccw": True,
    })
    case("arc_cw_half", {
        "kind": "arc", "center": [1, 1], "radius": 2.0,
        "angle_start_deg": 180.0, "angle_end_deg": 0.0, "ccw": False,
    })
    case("arc_full_default_angles", {"kind": "arc", "center": [0, 0], "radius": 1.0})
    case("arc_ccw_wrap", {
        "kind": "arc", "center": [0, 0], "radius": 3.0,
        "angle_start_deg": 350.0, "angle_end_deg": 10.0, "ccw": True,
    })
    return cases


def _surface(boundary):
    return {"boundary": boundary}


def _extract_profile_loops_cases():
    cases = []

    def case(name, surfaces):
        cases.append({
            "name": name, "surfaces": surfaces,
            "expected": _extract_profile_loops(surfaces),
        })

    case("empty", [])
    case("square", [_surface([
        {"kind": "line", "start": [0, 0], "end": [10, 0]},
        {"kind": "line", "start": [10, 0], "end": [10, 10]},
        {"kind": "line", "start": [10, 10], "end": [0, 10]},
        {"kind": "line", "start": [0, 10], "end": [0, 0]},
    ])])
    # Out-of-order edges, one needing reversal.
    case("square_unordered_reversed", [_surface([
        {"kind": "line", "start": [0, 0], "end": [10, 0]},
        {"kind": "line", "start": [10, 10], "end": [10, 0]},  # reversed
        {"kind": "line", "start": [10, 10], "end": [0, 10]},
        {"kind": "line", "start": [0, 10], "end": [0, 0]},
    ])])
    case("with_arc", [_surface([
        {"kind": "line", "start": [0, 0], "end": [10, 0]},
        {"kind": "arc", "start": [10, 0], "end": [10, 10],
         "center": [10, 5], "radius": 5.0,
         "angle_start_deg": -90.0, "angle_end_deg": 90.0, "ccw": True},
        {"kind": "line", "start": [10, 10], "end": [0, 10]},
        {"kind": "line", "start": [0, 10], "end": [0, 0]},
    ])])
    # Reversed arc to exercise the angle/ccw swap branch.
    case("reversed_arc", [_surface([
        {"kind": "line", "start": [0, 0], "end": [10, 0]},
        {"kind": "arc", "start": [10, 10], "end": [10, 0],
         "center": [10, 5], "radius": 5.0,
         "angle_start_deg": 90.0, "angle_end_deg": -90.0, "ccw": False},
        {"kind": "line", "start": [10, 10], "end": [0, 10]},
        {"kind": "line", "start": [0, 10], "end": [0, 0]},
    ])])
    return cases


def _resolve_direction_cases():
    cases = []
    plane = {"origin": [1, 2, 3], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1]}

    def case(name, normal, direction, distance):
        vec, dist, eff = _resolve_direction(normal, plane, direction, distance)
        # eff may be the same dict or a shifted dict; normalise to the four fields.
        eff_d = {
            "origin": list(eff["origin"]),
            "x_axis": list(eff["x_axis"]),
            "y_axis": list(eff["y_axis"]),
            "normal": list(eff["normal"]),
        }
        cases.append({
            "name": name, "normal": normal, "plane": plane,
            "direction": direction, "distance": distance,
            "expected": {"vec": vec, "distance": dist, "plane": eff_d},
        })

    case("forward", [0, 0, 1], "", 10.0)
    case("reverse", [0, 0, 1], "reverse", 10.0)
    case("symmetric", [0, 0, 1], "symmetric", 10.0)
    case("symmetric_tilted", [0.0, 0.6, 0.8], "symmetric", 5.0)
    return cases


def _body(bid, created_by):
    return Body(id=bid, created_by=created_by, shape=object())


def _resolve_body_cases():
    cases = []
    # bodies described as {id: created_by}; reconstructed identically in TS.
    store_spec = {
        "body_feat_a": "feat_a",
        "feat_b": "feat_b",
        "body_feat_c_1": "feat_c",
    }

    def make_store():
        return {bid: _body(bid, cb) for bid, cb in store_spec.items()}

    def case(name, ref, expect_id=None, error=False):
        store = make_store()
        try:
            body = _resolve_body(ref, store)
            cases.append({"name": name, "store": store_spec, "ref": ref,
                          "expected_id": body.id, "error": False})
        except ValueError:
            cases.append({"name": name, "store": store_spec, "ref": ref,
                          "expected_id": None, "error": True})

    case("direct_key", "body_feat_a")
    case("at_prefixed", "@feat_b")
    case("body_prefixed", "feat_a")          # -> body_feat_a
    case("by_created_by", "feat_c")          # -> body_feat_c_1
    case("viewport_face", "face:feat_b:7")   # -> feat_b
    case("viewport_body_prefixed", "body:feat_a:0")  # -> body_feat_a via candidate
    case("not_found", "nonexistent_xyz", error=True)
    return cases


def _resolve_merge_targets_cases():
    cases = []
    store_spec = {"body_feat_a": "feat_a", "feat_b": "feat_b"}

    def make_store():
        return {bid: _body(bid, cb) for bid, cb in store_spec.items()}

    def case(name, merge_target, error=False):
        store = make_store()
        try:
            result = _resolve_merge_targets(merge_target, store)
            cases.append({"name": name, "store": store_spec, "merge_target": merge_target,
                          "expected": result, "error": False})
        except ValueError:
            cases.append({"name": name, "store": store_spec, "merge_target": merge_target,
                          "expected": None, "error": True})

    case("none_all", None)
    case("empty_all", "")
    case("direct", "body_feat_a")
    case("at_prefixed", "@feat_b")
    case("by_created_by", "feat_a")
    case("not_found", "nope", error=True)
    return cases


def _diff(**kw):
    return BrepDiff(**kw)


def _brep_diff_is_empty_cases():
    cases = []

    def case(name, diff_obj, diff_repr):
        cases.append({"name": name, "diff": diff_repr,
                      "expected": _brep_diff_is_empty(diff_obj)})

    case("none", None, None)
    case("empty", _diff(), {})
    case("has_new_face", _diff(new_faces=["f"]), {"new_faces": ["f"]})
    case("has_modified_edge", _diff(modified_input_edges=["e"]),
         {"modified_input_edges": ["e"]})
    # inherited_* present but no new/deleted/modified -> still empty
    case("inherited_only", _diff(inherited_faces=["f"], inherited_edges=["e"]),
         {"inherited_faces": ["f"], "inherited_edges": ["e"]})
    return cases


def _register_top_face_cases():
    cases = []

    def case(name, feature_id, plane, surfaces, distance):
        repo = Repository()
        _register_top_face(repo, feature_id, plane, surfaces, distance)
        registered = {
            feature_id + "/top_face": repo.elements.get(feature_id + "/top_face"),
            feature_id + "/top_face/edge0": repo.elements.get(feature_id + "/top_face/edge0"),
        }
        registered = {k: v for k, v in registered.items() if v is not None}
        cases.append({
            "name": name, "feature_id": feature_id, "plane": plane,
            "surfaces": surfaces, "distance": distance, "expected": registered,
        })

    square = [_surface([
        {"kind": "line", "start": [0, 0], "end": [10, 0]},
        {"kind": "line", "start": [10, 0], "end": [10, 10]},
        {"kind": "line", "start": [10, 10], "end": [0, 10]},
        {"kind": "line", "start": [0, 10], "end": [0, 0]},
    ])]
    front = {"origin": [0, 0, 0], "x_axis": [1, 0, 0], "y_axis": [0, 1, 0], "normal": [0, 0, 1]}
    tilted = {"origin": [1, 2, 3], "x_axis": [1, 0, 0], "y_axis": [0, 0, 1], "normal": [0, -1, 0]}
    case("front_square", "feat_x", front, square, 10.0)
    case("tilted_square", "feat_y", tilted, square, 4.0)
    case("no_surfaces", "feat_z", front, [], 5.0)
    return cases


def _resolve_direction_query_cases():
    cases = []

    def case(name, registered, query, fallback, plane_elems=None):
        repo = Repository()
        for eid, obj in registered.items():
            repo.register(eid, obj)
        for eid, obj in (plane_elems or {}).items():
            repo.register(eid, obj)
        result = _resolve_direction_query(query, repo, fallback)
        cases.append({
            "name": name, "registered": registered, "plane_elems": plane_elems or {},
            "query": query, "fallback": fallback, "expected": result,
        })

    case("empty_query", {}, "", [0, 0, 1])
    case("missing", {}, "@missing", [0, 0, 1])
    case("edge_3d", {"e1": {"start": [0, 0, 0], "end": [0, 0, 5]}}, "@e1", [1, 0, 0])
    case("edge_zero_len", {"e1": {"start": [1, 1, 1], "end": [1, 1, 1]}}, "@e1", [1, 0, 0])
    case(
        "external_line",
        {"ln": {"external_params": [0, 0, 3, 0], "kind": "line", "sketch_id": "sk1"}},
        "@ln", [0, 1, 0],
        plane_elems={"_pt_sk1": {"origin": [0, 0, 0], "x_axis": [1, 0, 0],
                                 "y_axis": [0, 1, 0], "normal": [0, 0, 1]}},
    )
    return cases


def _resolve_axis_query_cases():
    cases = []

    def case(name, registered, query, fo, fd, plane_elems=None):
        repo = Repository()
        for eid, obj in registered.items():
            repo.register(eid, obj)
        for eid, obj in (plane_elems or {}).items():
            repo.register(eid, obj)
        origin, direction = _resolve_axis_query(query, repo, fo, fd)
        cases.append({
            "name": name, "registered": registered, "plane_elems": plane_elems or {},
            "query": query, "fallback_origin": fo, "fallback_direction": fd,
            "expected": {"origin": origin, "direction": direction},
        })

    case("empty_query", {}, "", [0, 0, 0], [0, 0, 1])
    case("edge_3d", {"a1": {"start": [1, 2, 3], "end": [1, 2, 8]}}, "@a1", [0, 0, 0], [1, 0, 0])
    case(
        "external_line",
        {"ln": {"external_params": [2, 0, 2, 4], "kind": "line", "sketch_id": "sk1"}},
        "@ln", [0, 0, 0], [1, 0, 0],
        plane_elems={"_pt_sk1": {"origin": [0, 0, 0], "x_axis": [1, 0, 0],
                                 "y_axis": [0, 1, 0], "normal": [0, 0, 1]}},
    )
    return cases


def main():
    fixture = {
        "tessellate_edge": _tessellate_edge_cases(),
        "extract_profile_loops": _extract_profile_loops_cases(),
        "resolve_direction": _resolve_direction_cases(),
        "resolve_body": _resolve_body_cases(),
        "resolve_merge_targets": _resolve_merge_targets_cases(),
        "brep_diff_is_empty": _brep_diff_is_empty_cases(),
        "register_top_face": _register_top_face_cases(),
        "resolve_direction_query": _resolve_direction_query_cases(),
        "resolve_axis_query": _resolve_axis_query_cases(),
    }
    here = os.path.dirname(__file__)
    out_dir = os.path.abspath(
        os.path.join(here, "..", "..", "frontend", "src", "kernel", "occ", "__fixtures__")
    )
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, "featuresShared.json")
    with open(out_path, "w") as f:
        json.dump(fixture, f, indent=2)
    total = sum(len(v) for v in fixture.values())
    print(f"wrote {out_path} ({total} cases across {len(fixture)} functions)")


if __name__ == "__main__":
    main()
