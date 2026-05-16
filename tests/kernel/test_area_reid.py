"""Tests for heuristic area re-identification after topology changes.

Covers: match_area_reid() in profile_loops.py, and the integration in
_post_register() that registers new surfaces under old ancestry keys.
"""
import math

from oversolved.kernel.query import _init_global_repo, make_ancestry_query
from oversolved.kernel.solver_registry import _post_register
from oversolved.kernel.topology import detect_topology
from oversolved.kernel.profile_loops import match_area_reid


# ─── geometry helpers ───


def _line(x1, y1, x2, y2):
    return {"start": [x1, y1], "end": [x2, y2]}


def _arc(cx, cy, r, a_start_deg, a_end_deg):
    a0 = math.radians(a_start_deg)
    a1 = math.radians(a_end_deg)
    return {
        "center": [cx, cy], "radius": r,
        "angle_start": a_start_deg, "angle_end": a_end_deg,
        "start": [cx + r * math.cos(a0), cy + r * math.sin(a0)],
        "end": [cx + r * math.cos(a1), cy + r * math.sin(a1)],
    }


def _front_plane_transform():
    return {"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "origin": [0, 0, 0]}


def _post_register_topo(repo, sketch_id, entities_list, topo):
    """Helper: call _post_register with the given topology."""
    feature = {"id": sketch_id, "kind": "sketch", "entities": entities_list}
    feature_result = {
        "status": "ok",
        "geometry": {},
        "plane_transform": _front_plane_transform(),
        "topology": topo,
    }
    _post_register(repo, sketch_id, feature, feature_result)


def test_area_reid_line_to_arc():
    """Triangle with one edge swapped from a line to an arc: the old surface
    ancestry query still resolves after re-solve."""
    sid = "sk_reid_l2a"

    # First solve: triangle with lines a, b, c.
    old_geom = {
        "a": _line(0, 0, 2, 0),
        "b": _line(2, 0, 1, 2),
        "c": _line(1, 2, 0, 0),
    }
    old_topo = detect_topology(old_geom, feature_id=sid)
    assert len(old_topo["surfaces"]) == 1, "setup: triangle must produce 1 surface"
    old_surface_query = old_topo["surfaces"][0]["query"]

    repo = _init_global_repo()
    _post_register_topo(
        repo, sid,
        [{"id": "a", "kind": "line"}, {"id": "b", "kind": "line"}, {"id": "c", "kind": "line"}],
        old_topo,
    )

    # Confirm the old query resolves before topology change.
    assert repo.query(old_surface_query) is not None, "old query must resolve on first solve"

    # Second solve: replace line b with arc1 (same endpoints, slightly curved).
    cx, cy = 1.5, 1.0
    r = math.hypot(2 - cx, 0 - cy)
    a0 = math.degrees(math.atan2(0 - cy, 2 - cx))
    a1 = math.degrees(math.atan2(2 - cy, 1 - cx))
    new_geom = {
        "a": _line(0, 0, 2, 0),
        "arc1": _arc(cx, cy, r, a0, a1),
        "c": _line(1, 2, 0, 0),
    }
    new_topo = detect_topology(new_geom, feature_id=sid)
    assert len(new_topo["surfaces"]) == 1, "setup: arc-triangle must produce 1 surface"

    _post_register_topo(
        repo, sid,
        [{"id": "a", "kind": "line"}, {"id": "arc1", "kind": "arc"}, {"id": "c", "kind": "line"}],
        new_topo,
    )

    # Old query must still resolve after the re-solve.
    resolved = repo.query(old_surface_query)
    assert resolved is not None, "area re-id: old surface query must survive line→arc swap"
    assert resolved.get("type") == "flatface"


def test_area_reid_split_both_win():
    """An inserted line splits one area into two; the re-id map captures both new areas,
    and query_all on the old surface key returns both flatface payloads."""
    sid = "sk_reid_split"

    # First solve: a simple 2x2 square (4 lines).
    old_geom = {
        "top": _line(0, 2, 2, 2),
        "right": _line(2, 2, 2, 0),
        "bottom": _line(2, 0, 0, 0),
        "left": _line(0, 0, 0, 2),
    }
    old_topo = detect_topology(old_geom, feature_id=sid)
    assert len(old_topo["surfaces"]) == 1, "setup: square must produce 1 surface"
    old_surface_query = old_topo["surfaces"][0]["query"]

    repo = _init_global_repo()
    _post_register_topo(
        repo, sid,
        [{"id": k, "kind": "line"} for k in ("top", "right", "bottom", "left")],
        old_topo,
    )

    # Second solve: add a vertical divider that splits the square into two rectangles.
    new_geom = {
        "top": _line(0, 2, 2, 2),
        "right": _line(2, 2, 2, 0),
        "bottom": _line(2, 0, 0, 0),
        "left": _line(0, 0, 0, 2),
        "divider": _line(1, 0, 1, 2),  # splits into two 1x2 rectangles
    }
    new_topo = detect_topology(new_geom, feature_id=sid)
    assert len(new_topo["surfaces"]) == 2, "setup: divided square must produce 2 surfaces"

    _post_register_topo(
        repo, sid,
        [{"id": k, "kind": "line"} for k in ("top", "right", "bottom", "left", "divider")],
        new_topo,
    )

    # The re-id map must identify that the old area maps to both new areas.
    old_surfaces = old_topo["surfaces"]
    new_surfaces = new_topo["surfaces"]
    reid_map = match_area_reid(old_surfaces, new_surfaces)
    assert reid_map, "reid_map must be non-empty for split case"
    mapped_new_keys = next(iter(reid_map.values()))
    assert len(mapped_new_keys) >= 1, "split must map old area to at least one new area"

    # Both new surfaces must be registered under the old ancestry key,
    # accessible via query_all (split means multiple results, both are valid).
    all_resolved = repo.query_all(old_surface_query)
    assert len(all_resolved) >= 1, (
        "area re-id split: query_all on old key must return at least one new flatface"
    )
    assert all(r.get("type") == "flatface" for r in all_resolved), (
        "all resolved surfaces must be flatface type"
    )


def test_area_reid_collapse_marks_feature_red():
    """Sketch edit that destroys any overlap: old surface query fails to resolve
    and returns None (downstream feature can detect and surface an error)."""
    sid = "sk_reid_collapse"

    # First solve: triangle a, b, c.
    old_geom = {
        "a": _line(0, 0, 2, 0),
        "b": _line(2, 0, 1, 2),
        "c": _line(1, 2, 0, 0),
    }
    old_topo = detect_topology(old_geom, feature_id=sid)
    assert len(old_topo["surfaces"]) == 1
    old_surface_query = old_topo["surfaces"][0]["query"]

    repo = _init_global_repo()
    _post_register_topo(
        repo, sid,
        [{"id": "a", "kind": "line"}, {"id": "b", "kind": "line"}, {"id": "c", "kind": "line"}],
        old_topo,
    )

    # Second solve: completely redrawn sketch with entirely new entity IDs
    # and different topology -- zero overlap with the old surface.
    new_geom = {
        "p": _line(10, 10, 20, 10),
        "q": _line(20, 10, 15, 20),
        "r": _line(15, 20, 10, 10),
    }
    new_topo = detect_topology(new_geom, feature_id=sid)
    assert len(new_topo["surfaces"]) == 1

    _post_register_topo(
        repo, sid,
        [{"id": "p", "kind": "line"}, {"id": "q", "kind": "line"}, {"id": "r", "kind": "line"}],
        new_topo,
    )

    # Old query must fail to resolve -- no match means None (resolver signals missing).
    resolved = repo.query(old_surface_query)
    assert resolved is None, (
        "area re-id: query for destroyed area must return None so downstream can flag error"
    )


def test_area_reid_no_match_means_new_identity():
    """Redrawn sketch with all-new entity IDs produces no false re-identification.

    The new surfaces must NOT be registered under any of the old surface keys.
    """
    sid = "sk_reid_newid"

    # First solve: triangle x, y, z.
    old_geom = {
        "x": _line(0, 0, 4, 0),
        "y": _line(4, 0, 2, 4),
        "z": _line(2, 4, 0, 0),
    }
    old_topo = detect_topology(old_geom, feature_id=sid)
    assert len(old_topo["surfaces"]) == 1
    old_surface_query = old_topo["surfaces"][0]["query"]

    repo = _init_global_repo()
    _post_register_topo(
        repo, sid,
        [{"id": k, "kind": "line"} for k in ("x", "y", "z")],
        old_topo,
    )

    # Second solve: entirely different entity names and geometry.
    new_geom = {
        "m1": _line(5, 5, 9, 5),
        "m2": _line(9, 5, 7, 9),
        "m3": _line(7, 9, 5, 5),
    }
    new_topo = detect_topology(new_geom, feature_id=sid)
    assert len(new_topo["surfaces"]) == 1

    _post_register_topo(
        repo, sid,
        [{"id": k, "kind": "line"} for k in ("m1", "m2", "m3")],
        new_topo,
    )

    # Old query must not resolve (no false re-id).
    resolved = repo.query(old_surface_query)
    assert resolved is None, "no false re-id: unrelated surface must not satisfy old query"

    # New surface's own query must resolve correctly.
    new_surface_query = new_topo["surfaces"][0]["query"]
    new_resolved = repo.query(new_surface_query)
    assert new_resolved is not None, "new surface's own query must resolve"
    assert new_resolved.get("type") == "flatface"
