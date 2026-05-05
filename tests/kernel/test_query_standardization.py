"""Tests for unified plane/point type handling across geometry kinds."""
import numpy as np
import pytest
from oversolved.kernel.solver import (
    is_plane_type,
    is_point_type,
    _get_point_3d,
    _resolve_plane_early,
    _init_global_repo,
    _FRONT_PLANE,
)
from oversolved.kernel.query import Repository


# Group 1: Helper unit tests (no OCC required)


def test_is_plane_type_accepts_plane():
    assert is_plane_type({"type": "plane"}) is True
    assert is_plane_type({"type": "face"}) is True


def test_is_plane_type_rejects_non_plane():
    assert is_plane_type({"type": "vertex"}) is False
    assert is_plane_type({"type": "edge"}) is False
    assert is_plane_type({}) is False


def test_is_point_type_accepts_point_and_vertex():
    assert is_point_type({"type": "point"}) is True
    assert is_point_type({"type": "vertex"}) is True


def test_is_point_type_rejects_non_point():
    assert is_point_type({"type": "plane"}) is False
    assert is_point_type({"type": "face"}) is False
    assert is_point_type({}) is False


def test_get_point_3d_handles_vertex_type():
    repo = Repository()
    vertex = {"type": "vertex", "origin": [1.0, 2.0, 3.0]}
    result = _get_point_3d(vertex, repo)
    np.testing.assert_array_almost_equal(result, [1.0, 2.0, 3.0])


def test_get_point_3d_handles_origin_without_normal():
    repo = Repository()
    pt = {"origin": [4.0, 5.0, 6.0]}
    result = _get_point_3d(pt, repo)
    np.testing.assert_array_almost_equal(result, [4.0, 5.0, 6.0])


def test_get_point_3d_rejects_origin_with_normal():
    repo = Repository()
    plane_like = {"origin": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0]}
    with pytest.raises(ValueError):
        _get_point_3d(plane_like, repo)


def test_resolve_plane_early_accepts_face_via_dollar_prefix():
    repo = _init_global_repo()
    face = {
        "type": "face",
        "centroid": [0, 0, 0],
        "normal": [0, 0, 1],
        "origin": [0, 0, 0],
        "x_axis": [1, 0, 0],
        "y_axis": [0, 1, 0],
    }
    repo.register("f1", face)
    result = _resolve_plane_early("$f1", repo)
    assert result is face


def test_resolve_plane_early_rejects_vertex_via_dollar_prefix():
    repo = _init_global_repo()
    vertex = {"type": "vertex", "origin": [1.0, 2.0, 3.0]}
    repo.register("v1", vertex)
    result = _resolve_plane_early("$v1", repo)
    assert result is _FRONT_PLANE


# Group 2: B-rep vertex registration (requires OCC)


def test_vertex_registered_in_repo_after_build():
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=5, h=5, d=3)
    r = build(spec)

    vertices_in_repo = []
    for body in r.get("bodies", {}).values():
        for q in body.get("vertex_queries", []):
            assert q, "vertex query should not be empty"
        for v in body.get("vertices", []):
            assert len(v) == 3, "vertex should have 3 coordinates"
            vertices_in_repo.append(v)

    assert vertices_in_repo, "expected at least one vertex after build"

    top_verts = [v for v in vertices_in_repo if abs(v[2] - 3.0) < 0.01]
    assert len(top_verts) >= 3, "expected at least 3 top-face vertices at z=3"


# Group 3: B-rep vertex as point in plane definitions (requires OCC)


def _top_vertex_queries(r: dict, d: float, count: int = 3) -> list:
    """Return up to count vertex query strings for vertices at z ~ d."""
    found = []
    for body in r.get("bodies", {}).values():
        verts = body.get("vertices", [])
        queries = body.get("vertex_queries", [])
        for v, q in zip(verts, queries):
            if abs(v[2] - d) < 0.01:
                found.append(q)
                if len(found) >= count:
                    return found
    return found


def test_three_point_plane_from_brep_vertices():
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    d = 3.0
    spec = full_rect_extrude_spec(w=5, h=5, d=d)
    r1 = build(spec)

    top_queries = _top_vertex_queries(r1, d, count=3)
    assert len(top_queries) == 3, f"need 3 top vertices, got {len(top_queries)}"

    plane_feature = {
        "id": "plane1",
        "kind": "plane",
        "definition": {
            "mode": "three_point",
            "p1": top_queries[0],
            "p2": top_queries[1],
            "p3": top_queries[2],
        },
    }
    spec2 = dict(spec)
    spec2["features"] = list(spec["features"]) + [plane_feature]

    r2 = build(spec2)
    plane_result = r2["result"].get("plane1", {})
    assert plane_result.get("status") != "exception", (
        f"plane failed: {plane_result.get('exception')}"
    )

    plane = plane_result.get("plane", {})
    normal = np.array(plane["normal"])
    assert abs(abs(normal[2]) - 1.0) < 0.01, f"expected z-normal, got {normal}"
    assert abs(plane["origin"][2] - d) < 0.01


def test_plane_point_mode_with_brep_vertex():
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    d = 7.0
    spec = full_rect_extrude_spec(w=5, h=5, d=d)
    r1 = build(spec)

    top_queries = _top_vertex_queries(r1, d, count=1)
    assert top_queries, "expected a vertex at z=d"
    vertex_query = top_queries[0]

    plane_feature = {
        "id": "plane1",
        "kind": "plane",
        "definition": {
            "mode": "plane_point",
            "plane": "@builtin_plane_front",
            "point": vertex_query,
        },
    }
    spec2 = dict(spec)
    spec2["features"] = list(spec["features"]) + [plane_feature]

    r2 = build(spec2)
    plane_result = r2["result"].get("plane1", {})
    assert plane_result.get("status") != "exception", (
        f"plane failed: {plane_result.get('exception')}"
    )

    plane = plane_result.get("plane", {})
    assert abs(plane["origin"][2] - d) < 0.01


# Group 4: B-rep face as plane in plane feature (requires OCC)


def _top_face_query(r: dict, d: float) -> str | None:
    """Return face query for the face with centroid closest to z=d."""
    best_q = None
    best_dist = float("inf")
    for body in r.get("bodies", {}).values():
        mesh = body.get("mesh") or {}
        face_data = mesh.get("face_data") or []
        face_queries = mesh.get("face_queries") or []
        for fd, q in zip(face_data, face_queries):
            dist = abs(fd["centroid"][2] - d)
            if dist < best_dist:
                best_dist = dist
                best_q = q
    return best_q


def test_plane_on_face_mode_from_brep_face():
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    d = 4.0
    spec = full_rect_extrude_spec(w=5, h=5, d=d)
    r1 = build(spec)

    face_q = _top_face_query(r1, d)
    assert face_q is not None, "expected a face query for the top face"

    plane_feature = {
        "id": "plane1",
        "kind": "plane",
        "definition": {
            "mode": "on_face",
            "face": face_q,
        },
    }
    spec2 = dict(spec)
    spec2["features"] = list(spec["features"]) + [plane_feature]

    r2 = build(spec2)
    plane_result = r2["result"].get("plane1", {})
    assert plane_result.get("status") != "exception", (
        f"plane failed: {plane_result.get('exception')}"
    )

    plane = plane_result.get("plane", {})
    normal = np.array(plane["normal"])
    assert abs(abs(normal[2]) - 1.0) < 0.01, f"expected z-normal, got {normal}"
    assert abs(plane["origin"][2] - d) < 0.01
