"""Query ancestral stability across feature reorder.

User invariant (solver_arch.user.md §Query Stability):
  "Queries never change once captured. A query captured for edge E from
   extrude1 must still resolve after the feature list is reordered, as long
   as the geometry of the originating feature is unchanged."

Defends the entire layer model: if queries become invalid after innocuous
reorders, every downstream reference (pick chips, dimension targets, plane
refs) silently breaks.  If this test fails, suspect a regression in the
ancestral resolver or in how `_repo_from_snapshot` reconstructs the repo.
"""
import pytest

from solver_helpers import rect_sketch_spec, extrude_spec


def _build_two_extrude_stack():
    """Two independent extrudes on the front plane.

    sk1/ex1 and sk2/ex2 share no geometry -- swapping their order must not
    change the geometry of either body.
    """
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)

    # Offset sk2 so it doesn't touch sk1's extrusion.
    sk2 = rect_sketch_spec(w=4.0, h=4.0, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [20, 0, 24, 0],
        "right": [24, 0, 24, 4],
        "top": [24, 4, 20, 4],
        "left": [20, 4, 20, 0],
    }
    ex2 = extrude_spec("sk2", "ex2", distance=4.0)
    return sk1, ex1, sk2, ex2


def test_query_ancestral_stability():
    """Edge query from ex1 still resolves with created_by=ex1 after sk2/ex2 moves first."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _repo_from_snapshot

    sk1, ex1, sk2, ex2 = _build_two_extrude_stack()
    doc_original = {"features": [sk1, ex1, sk2, ex2]}

    r1 = build(doc_original)
    assert r1["result"]["ex1"]["status"] == "ok", f"ex1 failed: {r1['result']['ex1']}"

    body_out = r1["bodies"].get("body_ex1")
    assert body_out is not None, "body_ex1 not in bodies"
    edge_queries = body_out.get("edge_queries") or []
    assert edge_queries, "body_ex1 has no edge_queries"
    captured_query = edge_queries[0]

    # Verify the query resolves in the original build's final repo.
    state1 = r1["_build_state"]
    final_snap1 = state1.checkpoints["ex2"].repo_snapshot
    repo1 = _repo_from_snapshot(final_snap1)
    resolved1 = repo1.query(captured_query)
    assert resolved1 is not None, f"query did not resolve in original build: {captured_query!r}"
    assert resolved1.get("created_by") == "ex1", (
        f"created_by mismatch in original build: {resolved1.get('created_by')!r}"
    )

    # Reorder: put sk2/ex2 before sk1/ex1 and rebuild.
    doc_reordered = {"features": [sk2, ex2, sk1, ex1]}
    r2 = build(doc_reordered)
    assert r2["result"]["ex1"]["status"] == "ok", f"ex1 failed after reorder: {r2['result']['ex1']}"

    state2 = r2["_build_state"]
    final_snap2 = state2.checkpoints["ex1"].repo_snapshot
    repo2 = _repo_from_snapshot(final_snap2)
    resolved2 = repo2.query(captured_query)

    # The captured query must still resolve -- and to the same feature owner.
    assert resolved2 is not None, (
        f"query became unresolvable after feature reorder: {captured_query!r}"
    )
    assert resolved2.get("created_by") == "ex1", (
        f"created_by changed after reorder: {resolved2.get('created_by')!r}; "
        "expected 'ex1'"
    )
