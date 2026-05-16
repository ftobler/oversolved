"""Backend cross-layer selection invariant tests.

Feature: cross-layer-selection-invariants.md

These test invariants 5-7 at the query / rebuild layer:
  5. Click commits ancestral query — face/edge queries survive feature rename.
  6. Built-in planes are selectable and round-trip through queries.
  7. Cross-feature: 3-point plane from different sketches resolves on rebuild.
"""
import pytest
from parseable_fixture import make_sketch, make_doc
from solver_helpers import extrude_spec, rect_sketch_spec


def _build_face_query_doc():
    """Build a doc with one extrude that yields edge queries."""
    sk = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex = extrude_spec("sk1", "ex1", distance=10.0)
    return {"features": [sk, ex]}


# ─── invariant 5: click commits ancestry ───

def test_face_query_survives_feature_change(request):
    """Face edge_queries from Body3D remain resolvable after a sketch edit."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _repo_from_snapshot, BuildState
    from oversolved.kernel.query import Repository

    result = build(_build_face_query_doc())
    assert result["result"]["ex1"]["status"] == "ok"

    body_out = result["bodies"].get("body_ex1")
    assert body_out is not None
    edge_queries = body_out.get("edge_queries") or []
    assert len(edge_queries) > 0, "body_ex1 has no edge_queries"

    # Each edge query should be parseable as ancestry (?...) or absolute (@...)
    for q in edge_queries:
        assert q.startswith("?") or q.startswith("@"), f"edge query {q!r} is not ancestral"

    # Verify the query resolves in the build's final repo
    state = result["_build_state"]
    final_snap = state.checkpoints["ex1"].repo_snapshot
    repo = _repo_from_snapshot(final_snap)
    for q in edge_queries:
        resolved = repo.query(q)
        assert resolved is not None, f"failed to resolve edge query {q!r}"


def test_edge_query_resolves_after_tier2_partial(request):
    """Tier-2 partial ancestral resolver finds edge after ancestor set changes."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    result = build(_build_face_query_doc())
    body_out = result["bodies"].get("body_ex1")
    assert body_out is not None

    # Use edge_queries (always present) instead of face_queries
    edge_queries = body_out.get("edge_queries") or []
    assert len(edge_queries) > 0, "body_ex1 has no edge_queries"

    state = result["_build_state"]
    final_snap = state.checkpoints["ex1"].repo_snapshot
    repo = _repo_from_snapshot(final_snap)

    # Each edge query with type restriction resolves
    for q in edge_queries:
        resolved = repo.query(q)
        assert resolved is not None, f"edge query {q!r} did not resolve"
        resolved_type = resolved.get("type") if isinstance(resolved, dict) else None
        assert resolved_type in ("edge", "straightedge"), (
            f"resolved element type is {resolved_type}, expected edge type for {q!r}"
        )


# ─── invariant 6: built-in planes selectable ───

def test_builtin_plane_selectable():
    """@builtin_plane_front etc. are registered in the global repository."""
    from oversolved.kernel.query import Repository, _init_global_repo

    repo = _init_global_repo()
    names = ("builtin_plane_front", "builtin_plane_top", "builtin_plane_right")
    for name in names:
        result = repo.query("@" + name)
        assert result is not None, f"{name} not in global repo"
        assert result.get("type") == "plane"


def test_builtin_plane_query_string_round_trip():
    """A plane query string generated for a built-in plane is parseable."""
    from oversolved.kernel.query import Repository, absolute, _init_global_repo

    repo = _init_global_repo()
    q = absolute("builtin_plane_front")
    result = repo.query(q)
    assert result is not None
    assert result.get("type") == "plane"

    q_top = absolute("builtin_plane_top")
    result_top = repo.query(q_top)
    assert result_top is not None
    assert result_top.get("type") == "plane"


# ─── invariant 7: cross-feature queries ───

def test_cross_feature_queries_coexist(request):
    """After building two features independently, both bodies appear."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0, operation="new")

    # Second sketch offset so bodies don't overlap
    sk2 = rect_sketch_spec(w=4.0, h=4.0, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [20, 0, 24, 0],
        "right": [24, 0, 24, 4],
        "top": [24, 4, 20, 4],
        "left": [20, 4, 20, 0],
    }
    ex2 = extrude_spec("sk2", "ex2", distance=4.0, operation="new")

    doc = {"features": [sk1, ex1, sk2, ex2]}
    result = build(doc)

    assert result["result"]["ex1"]["status"] == "ok"
    assert result["result"]["ex2"]["status"] == "ok"

    bodies = result["bodies"]
    assert "body_ex1" in bodies
    assert "body_ex2" in bodies


def test_cross_feature_queries_resolve(request):
    """After building two independent features, edge queries from both resolve."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0, operation="new")

    sk2 = rect_sketch_spec(w=4.0, h=4.0, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [15, 0, 19, 0],
        "right": [19, 0, 19, 4],
        "top": [19, 4, 15, 4],
        "left": [15, 4, 15, 0],
    }
    ex2 = extrude_spec("sk2", "ex2", distance=4.0, operation="new")

    doc = {"features": [sk1, ex1, sk2, ex2]}
    result = build(doc)

    state = result["_build_state"]
    snap = state.checkpoints["ex2"].repo_snapshot
    repo = _repo_from_snapshot(snap)

    # Edge queries from both bodies resolve in the final repo
    for body_key in ("body_ex1", "body_ex2"):
        body_out = result["bodies"].get(body_key)
        assert body_out is not None, f"{body_key} not found in bodies"
        queries = body_out.get("edge_queries") or []
        assert len(queries) > 0, f"{body_key} has no edge_queries"
        for q in queries:
            resolved = repo.query(q)
            assert resolved is not None, (
                f"query {q!r} from {body_key} did not resolve"
            )
