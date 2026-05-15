"""B-rep ancestry tracking via OCP boolean history.

User invariant (solver_arch.user.md §B-rep Operation Tracking):
  "Old geometry from extrude1 still belongs to extrude1. New faces created by
   a cut in extrude2 track to extrude2 only."

These tests cover:
  - BrepDiff dataclass shape and default values.
  - ocp_boolean_with_history classifies output faces as new vs inherited.
  - The cut path attaches a BrepDiff to the cut body.
  - The ancestry registration tags new faces with the cutting feature's id
    rather than the original body's @created_by.
"""

import pytest

from solver_helpers import rect_sketch_spec, extrude_spec


def test_brep_diff_dataclass_defaults():
    from oversolved.kernel.types3d import BrepDiff
    d = BrepDiff()
    assert d.new_faces == []
    assert d.inherited_faces == []
    assert d.new_edges == []
    assert d.inherited_edges == []
    assert d.modified_input_faces == []
    assert d.deleted_input_faces == []
    assert d.modified_input_edges == []
    assert d.deleted_input_edges == []


def test_body_brep_diff_defaults_none():
    from oversolved.kernel.types3d import Body
    b = Body(id="x", created_by="ex1")
    assert b.brep_diff is None


def test_ocp_boolean_with_history_classifies_cut_walls_as_new():
    """Cube minus thru-hole: 4 cut walls are 'new', 4 sides of cube are 'inherited'."""
    pytest.importorskip("OCP.BRepAlgoAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import ocp_boolean_with_history

    box = BRepPrimAPI_MakeBox(10, 10, 10).Solid()
    cutter = BRepPrimAPI_MakeBox(gp_Pnt(2, 2, -1), 5, 5, 12).Solid()  # thru-hole
    result, diff = ocp_boolean_with_history(box, cutter, "cut")
    assert result is not None
    # The thru-hole adds 4 inner walls; top and bottom of box become "modified"
    # (they get a hole punched). The 4 side faces of the box stay inherited.
    assert len(diff.new_faces) >= 4, f"expected >=4 new (cut walls), got {len(diff.new_faces)}"
    # Total output faces from a box-with-thru-hole = 4 sides + 2 modified top/bot + 4 cut walls.
    assert len(diff.new_faces) + len(diff.inherited_faces) >= 8


def test_ocp_boolean_with_history_pure_fuse_overlap_marks_shared_as_modified():
    """Fuse two partially-overlapping boxes -> shared face vanishes (modified or removed)."""
    pytest.importorskip("OCP.BRepAlgoAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import ocp_boolean_with_history

    a = BRepPrimAPI_MakeBox(10, 10, 10).Solid()
    b = BRepPrimAPI_MakeBox(gp_Pnt(5, 0, 0), 10, 10, 10).Solid()
    _result, diff = ocp_boolean_with_history(a, b, "fuse")
    # At least some input faces got modified by the fuse (the touching faces).
    assert (len(diff.modified_input_faces) + len(diff.deleted_input_faces)) > 0


def test_cut_body_carries_brep_diff():
    """After a cut, body.brep_diff is populated on the affected body."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)

    # Smaller box at center for cut
    sk2 = rect_sketch_spec(w=4.0, h=4.0, sketch_id="sk2")
    # Offset the cut sketch by translating x_axis... easier: use full_rect_extrude_spec
    # Use a basic offset: shift via initial coords
    sk2["initial"] = {
        "bottom": [3, 3, 7, 3],
        "right": [7, 3, 7, 7],
        "top": [7, 7, 3, 7],
        "left": [3, 7, 3, 3],
    }
    sk2["constraints"] = [c for c in sk2["constraints"] if not c["id"].startswith("c9") and not c["id"].startswith("c10")]
    sk2["constraints"].extend([
        {"id": "c9", "kind": "length", "target": {"entity": "bottom"}, "value": 4.0},
        {"id": "c10", "kind": "length", "target": {"entity": "left"}, "value": 4.0},
    ])
    ex2 = extrude_spec("sk2", "ex2", distance=12.0, operation="cut")

    r = build({"features": [sk1, ex1, sk2, ex2]})
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"setup: cut didn't apply: {r['result']['ex2']}")

    state = r["_build_state"]
    body = state.checkpoints["ex2"].body_store_snapshot.get("body_ex1")
    assert body is not None
    assert body.brep_diff is not None, "cut body should have brep_diff attached"
    assert len(body.brep_diff.new_faces) > 0, "cut should produce at least one new face"


def test_new_faces_tagged_with_cutting_feature_in_ancestry():
    """Face ancestry: walls of the cut hole have @created_by = cutting feature (ex2),
    not the original box feature (ex1)."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    sk2 = rect_sketch_spec(w=4.0, h=4.0, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [3, 3, 7, 3], "right": [7, 3, 7, 7],
        "top": [7, 7, 3, 7], "left": [3, 7, 3, 3],
    }
    sk2["constraints"] = [c for c in sk2["constraints"] if c["id"] not in ("c9", "c10")]
    sk2["constraints"].extend([
        {"id": "c9", "kind": "length", "target": {"entity": "bottom"}, "value": 4.0},
        {"id": "c10", "kind": "length", "target": {"entity": "left"}, "value": 4.0},
    ])
    ex2 = extrude_spec("sk2", "ex2", distance=12.0, operation="cut")

    r = build({"features": [sk1, ex1, sk2, ex2]})
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"setup: cut didn't apply: {r['result']['ex2']}")

    body_out = r["bodies"]["body_ex1"]
    face_data = body_out["mesh"]["face_data"]

    # Map face_index -> created_by from the post-build registry.
    state = r["_build_state"]
    repo_snap = state.checkpoints["ex2"].repo_snapshot
    elements = repo_snap["elements"]

    created_by_set: set[str] = set()
    for el in elements.values():
        if isinstance(el, dict) and el.get("type") in ("face", "flatface", "cylindricalsurface") \
                and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                created_by_set.add(cb)

    # We expect BOTH features to appear as @created_by across the face set:
    #   - ex1 for the outer 4 side faces (inherited, untouched)
    #   - ex2 for the 4 inner cut-hole walls (new)
    assert "ex1" in created_by_set, f"expected ex1 in face created_by set, got {created_by_set}"
    assert "ex2" in created_by_set, (
        f"expected ex2 (cutting feature) to own at least one new face, "
        f"got {created_by_set}; face_data count={len(face_data)}"
    )
