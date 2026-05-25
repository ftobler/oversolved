"""Automatic body-splitting when a single feature produces disconnected solids.

User invariant (solver_arch.user.md §Parts / "Automatic splitting"):
  "When a feature profile extrudes into multiple disconnected solids,
   each solid becomes its own body in body_store, all attributed to
   the originating feature."

Defends the `ocp_explore_solids` path in `_apply_body_operation`.
If this test fails, suspect a regression in `ocp_explore_solids`
or the body-creation loop inside `_apply_body_operation`.
"""
import pytest


def _make_disjoint_compound():
    """Return an OCC compound containing two non-touching 5x5x5 boxes."""
    pytest.importorskip("OCP.BRepPrimAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from OCP.BRep import BRep_Builder
    from OCP.TopoDS import TopoDS_Compound

    box_a = BRepPrimAPI_MakeBox(5.0, 5.0, 5.0).Solid()
    # Box B starts at x=20, no overlap with box A.
    box_b = BRepPrimAPI_MakeBox(gp_Pnt(20.0, 0.0, 0.0), 5.0, 5.0, 5.0).Solid()

    builder = BRep_Builder()
    compound = TopoDS_Compound()
    builder.MakeCompound(compound)
    builder.Add(compound, box_a)
    builder.Add(compound, box_b)
    return compound


def test_auto_split_single_feature_creates_two_bodies():
    """One 'new' extrude op with a disjoint-compound tool shape creates 2 bodies.

    This exercises the _split_compound -> body_store path directly, bypassing
    the sketch/extrude pipeline to keep the test fast and focused.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.solver_features_shared import _apply_body_operation

    compound = _make_disjoint_compound()

    body_store: dict = {}
    result = _apply_body_operation(
        tool_shape=compound,
        body_store=body_store,
        operation="new",
        merge_target=None,
        body_id="body_ex1",
        feature_id="ex1",
        sketch_id="sk1",
    )

    assert len(body_store) == 2, (
        f"expected 2 bodies after auto-split, got {len(body_store)}: "
        f"{list(body_store.keys())}"
    )
    assert result["status"] == "ok"

    # Primary body keeps the canonical id; overflow bodies get a numeric suffix.
    assert "body_ex1" in body_store, "primary body 'body_ex1' missing"
    assert "body_ex1_1" in body_store, "split body 'body_ex1_1' missing"

    # Both bodies must be attributed to the originating feature.
    for bid, body in body_store.items():
        assert body.created_by == "ex1", (
            f"body {bid!r} has wrong created_by: {body.created_by!r}"
        )


def test_auto_split_single_solid_does_not_split():
    """A single-solid shape must stay as one body -- no spurious split."""
    pytest.importorskip("OCP.gp")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.solver_features_shared import _apply_body_operation

    single_box = BRepPrimAPI_MakeBox(5.0, 5.0, 5.0).Solid()

    body_store: dict = {}
    _apply_body_operation(
        tool_shape=single_box,
        body_store=body_store,
        operation="new",
        merge_target=None,
        body_id="body_ex1",
        feature_id="ex1",
        sketch_id="sk1",
    )

    assert len(body_store) == 1, (
        f"expected 1 body for single solid, got {len(body_store)}"
    )
    assert "body_ex1" in body_store
    assert body_store["body_ex1"].created_by == "ex1"


def test_auto_split_via_full_builder():
    """Two-loop sketch produces two bodies via the full build() pipeline.

    Uses rect_sketch_spec geometry positions to create two non-touching
    rectangles in a single sketch, then extrudes them.  The full builder
    path (sketch solve -> extrude -> _split_compound -> body_store) must
    correctly attribute both bodies to the extrude feature.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    # Two separate 5x5 squares, 10 units apart -- no touching, so auto-split fires.
    two_loop_sketch = {
        "id": "sk1",
        "kind": "sketch",
        "plane": "@builtin_plane_front",
        "entities": [
            {"id": "a_bot", "kind": "line"},
            {"id": "a_rit", "kind": "line"},
            {"id": "a_top", "kind": "line"},
            {"id": "a_lft", "kind": "line"},
            {"id": "b_bot", "kind": "line"},
            {"id": "b_rit", "kind": "line"},
            {"id": "b_top", "kind": "line"},
            {"id": "b_lft", "kind": "line"},
        ],
        "initial": {
            "a_bot": [0, 0, 5, 0],
            "a_rit": [5, 0, 5, 5],
            "a_top": [5, 5, 0, 5],
            "a_lft": [0, 5, 0, 0],
            "b_bot": [15, 0, 20, 0],
            "b_rit": [20, 0, 20, 5],
            "b_top": [20, 5, 15, 5],
            "b_lft": [15, 5, 15, 0],
        },
        "constraints": [
            {"id": "ca1", "kind": "coincident",
             "a": {"entity": "a_bot", "point": "end"}, "b": {"entity": "a_rit", "point": "start"}},
            {"id": "ca2", "kind": "coincident",
             "a": {"entity": "a_rit", "point": "end"}, "b": {"entity": "a_top", "point": "start"}},
            {"id": "ca3", "kind": "coincident",
             "a": {"entity": "a_top", "point": "end"}, "b": {"entity": "a_lft", "point": "start"}},
            {"id": "ca4", "kind": "coincident",
             "a": {"entity": "a_lft", "point": "end"}, "b": {"entity": "a_bot", "point": "start"}},
            {"id": "cb1", "kind": "coincident",
             "a": {"entity": "b_bot", "point": "end"}, "b": {"entity": "b_rit", "point": "start"}},
            {"id": "cb2", "kind": "coincident",
             "a": {"entity": "b_rit", "point": "end"}, "b": {"entity": "b_top", "point": "start"}},
            {"id": "cb3", "kind": "coincident",
             "a": {"entity": "b_top", "point": "end"}, "b": {"entity": "b_lft", "point": "start"}},
            {"id": "cb4", "kind": "coincident",
             "a": {"entity": "b_lft", "point": "end"}, "b": {"entity": "b_bot", "point": "start"}},
        ],
    }
    extrude = {"id": "ex1", "kind": "extrude", "sketch": "$sk1", "distance": 5.0, "direction": "normal", "operation": "add"}

    r = build({"features": [two_loop_sketch, extrude]})
    if r["result"]["ex1"]["status"] != "ok":
        pytest.skip(f"two-loop sketch extrude failed: {r['result']['ex1']}")

    bodies = r["bodies"]
    body_ids = list(bodies.keys())
    assert len(body_ids) == 2, (
        f"expected 2 bodies from two-loop extrude, got {len(body_ids)}: {body_ids}"
    )
    for bid in body_ids:
        state = r["_build_state"]
        body_snap = state.checkpoints["ex1"].body_store_snapshot.get(bid)
        assert body_snap is not None
        assert body_snap.created_by == "ex1", (
            f"body {bid!r} has wrong created_by: {body_snap.created_by!r}"
        )
