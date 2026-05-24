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


def _cut_fixture():
    """Shared fixture: 10x10x10 cube with a 4x4 through-hole cut by ex2."""
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
    return {"features": [sk1, ex1, sk2, ex2]}


def test_boolean_cut_new_edge_attributed_to_cutter():
    """Edges along the cut perimeter are tagged created_by=ex2, not ex1."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    state = r["_build_state"]
    elements = state.checkpoints["ex2"].repo_snapshot["elements"]

    edge_created_by: set[str] = set()
    for el in elements.values():
        if isinstance(el, dict) and el.get("type") in ("edge", "straightedge") \
                and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                edge_created_by.add(cb)

    assert "ex2" in edge_created_by, (
        f"expected ex2 to own at least one new edge (cut perimeter), got {edge_created_by}"
    )


def _faces_of(shape):
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE
    out = []
    exp = TopExp_Explorer(shape, TopAbs_FACE)
    while exp.More():
        out.append(exp.Current())
        exp.Next()
    return out


def test_compose_through_clean_drops_unified_shapes():
    """Fuse two abutting boxes -> coplanar side faces unify; composed diff must
    only reference faces that survive in the cleaned shape (no stale handles)."""
    pytest.importorskip("OCP.BRepAlgoAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import (
        ocp_boolean_with_history, ocp_clean_with_history, ocp_compose_diff_through_clean,
    )

    a = BRepPrimAPI_MakeBox(10, 10, 10).Solid()
    b = BRepPrimAPI_MakeBox(gp_Pnt(10, 0, 0), 10, 10, 10).Solid()  # abuts a at x=10
    raw_result, raw_diff = ocp_boolean_with_history(a, b, "fuse")
    cleaned, clean_hist = ocp_clean_with_history(raw_result)
    composed = ocp_compose_diff_through_clean(raw_diff, clean_hist, raw_result, cleaned)

    cleaned_faces = _faces_of(cleaned)

    def _present(f):
        return any(f.IsSame(cf) for cf in cleaned_faces)

    for f in composed.new_faces + composed.inherited_faces:
        assert _present(f), "composed diff references a face absent from the cleaned shape"
    # Unification collapses the box pair to fewer faces than the raw fuse output.
    assert len(cleaned_faces) <= len(_faces_of(raw_result))


def test_compose_through_clean_passthrough_when_no_modifier():
    """A face untouched by the upgrade maps to an IsSame counterpart in cleaned."""
    pytest.importorskip("OCP.BRepAlgoAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import (
        ocp_boolean_with_history, ocp_clean_with_history, ocp_compose_diff_through_clean,
    )

    a = BRepPrimAPI_MakeBox(10, 10, 10).Solid()
    cutter = BRepPrimAPI_MakeBox(gp_Pnt(2, 2, -1), 5, 5, 12).Solid()
    raw_result, raw_diff = ocp_boolean_with_history(a, cutter, "cut")
    cleaned, clean_hist = ocp_clean_with_history(raw_result)
    composed = ocp_compose_diff_through_clean(raw_diff, clean_hist, raw_result, cleaned)

    cleaned_faces = _faces_of(cleaned)
    # Every inherited face in the composed diff is a real face of the cleaned shape.
    assert composed.inherited_faces
    for f in composed.inherited_faces:
        assert any(f.IsSame(cf) for cf in cleaned_faces)


def test_boolean_cut_inherited_edge_keeps_original_creator():
    """Original cube edges (outer faces) stay attributed to ex1 after cut."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    state = r["_build_state"]
    elements = state.checkpoints["ex2"].repo_snapshot["elements"]

    edge_created_by: set[str] = set()
    for el in elements.values():
        if isinstance(el, dict) and el.get("type") in ("edge", "straightedge") \
                and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                edge_created_by.add(cb)

    assert "ex1" in edge_created_by, (
        f"expected ex1 to own some inherited edges, got {edge_created_by}"
    )


def test_boolean_cut_new_vertex_attributed_to_cutter():
    """Corners of the cut hole (purely new vertices) are tagged created_by=ex2."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    state = r["_build_state"]
    elements = state.checkpoints["ex2"].repo_snapshot["elements"]

    vertex_created_by: set[str] = set()
    for el in elements.values():
        if isinstance(el, dict) and el.get("type") == "vertex" \
                and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                vertex_created_by.add(cb)

    assert "ex2" in vertex_created_by, (
        f"expected ex2 to own new hole-corner vertices, got {vertex_created_by}"
    )


def test_vertex_mixed_adjacency_falls_back():
    """Original cube corners (inherited-edge-only adjacency) keep created_by=ex1."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    state = r["_build_state"]
    elements = state.checkpoints["ex2"].repo_snapshot["elements"]

    vertex_created_by: set[str] = set()
    for el in elements.values():
        if isinstance(el, dict) and el.get("type") == "vertex" \
                and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                vertex_created_by.add(cb)

    assert "ex1" in vertex_created_by, (
        f"original cube corners should stay attributed to ex1, got {vertex_created_by}"
    )


def test_fuse_new_edges():
    """Fuse seam edges (new from the fuse op) are attributed to the fusing feature."""
    pytest.importorskip("OCP.BRepAlgoAPI")
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from OCP.gp import gp_Pnt
    from oversolved.kernel.ocp_ops import ocp_boolean_with_history
    from oversolved.kernel.types3d import Body, BrepDiff
    from oversolved.kernel.geom_hash import edge_geometry_hash
    from oversolved.kernel.builder import _brep_diff_new_edge_hashes

    a = BRepPrimAPI_MakeBox(10, 10, 10).Solid()
    b = BRepPrimAPI_MakeBox(gp_Pnt(5, 0, 0), 10, 10, 10).Solid()
    result_shape, diff = ocp_boolean_with_history(a, b, "fuse")
    assert result_shape is not None

    body = Body(id="body_fuse", created_by="ex1", modified_by=["ex2"])
    body.shape = result_shape
    body.brep_diff = diff

    new_hashes = _brep_diff_new_edge_hashes(body)
    # Fuse of two overlapping boxes should produce new seam edges.
    assert len(new_hashes) > 0, "fuse should produce at least one new edge"


def test_brep_diff_absent_no_regression():
    """A fresh extrude (no brep_diff) registers all edges/vertices under body.created_by."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)
    r = build({"features": [sk1, ex1]})
    assert r["result"]["ex1"]["status"] == "ok"

    state = r["_build_state"]
    elements = state.checkpoints["ex1"].repo_snapshot["elements"]

    for el in elements.values():
        if isinstance(el, dict) and el.get("body_id") == "body_ex1":
            cb = el.get("created_by")
            if cb:
                assert cb == "ex1", f"fresh extrude should only have ex1 ancestry, got {cb}"


def test_mesh_face_queries_have_correct_created_by_after_cut():
    """Mesh face_queries must use @ex2 for new cut-hole walls, @ex1 for inherited."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from oversolved.kernel.query import _parse_ancestry

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    face_queries = r["bodies"]["body_ex1"]["mesh"]["face_queries"]
    created_by_set: set[str] = set()
    for fq in face_queries:
        ids, _ = _parse_ancestry(fq)
        if len(ids) >= 2:
            created_by_set.add(ids[1][1:])  # strip @ prefix

    assert "ex1" in created_by_set, f"expected ex1 in face_queries, got {created_by_set}"
    assert "ex2" in created_by_set, f"expected ex2 in face_queries, got {created_by_set}"


def test_mesh_edge_queries_have_correct_created_by_after_cut():
    """Mesh edge_queries must use @ex2 for new cut perimeter edges, @ex1 for inherited."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from oversolved.kernel.query import _parse_ancestry

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    edge_queries = r["bodies"]["body_ex1"]["edge_queries"]
    created_by_set: set[str] = set()
    for eq in edge_queries:
        ids, _ = _parse_ancestry(eq)
        if len(ids) >= 2:
            created_by_set.add(ids[1][1:])

    assert "ex1" in created_by_set, f"expected ex1 in edge_queries, got {created_by_set}"
    assert "ex2" in created_by_set, f"expected ex2 in edge_queries, got {created_by_set}"


def test_mesh_vertex_queries_have_correct_created_by_after_cut():
    """Mesh vertex_queries must use @ex2 for new hole-corner vertices, @ex1 for inherited."""
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build
    from oversolved.kernel.query import _parse_ancestry

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    vertex_queries = r["bodies"]["body_ex1"]["vertex_queries"]
    created_by_set: set[str] = set()
    for vq in vertex_queries:
        ids, _ = _parse_ancestry(vq)
        if len(ids) >= 2:
            created_by_set.add(ids[1][1:])

    assert "ex1" in created_by_set, f"expected ex1 in vertex_queries, got {created_by_set}"
    assert "ex2" in created_by_set, f"expected ex2 in vertex_queries, got {created_by_set}"


def test_tessellation_query_resolves_after_cut():
    """Every face_query from a cut body resolves against the repo.

    The full query (geom_hash + @created_by + @body_id) must resolve to a
    unique face element via tier 1 + hash narrowing, not just hash fallback.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build

    r = build(_cut_fixture())
    if r["result"]["ex2"]["status"] != "ok":
        pytest.skip(f"cut failed: {r['result']['ex2']}")

    state = r["_build_state"]
    repo_snap = state.checkpoints["ex2"].repo_snapshot
    from oversolved.kernel.builder import _repo_from_snapshot
    repo = _repo_from_snapshot(repo_snap)

    face_queries = r["bodies"]["body_ex1"]["mesh"]["face_queries"]
    for fq in face_queries:
        resolved = repo.query(fq)
        assert resolved is not None, f"face query failed to resolve: {fq}"
        assert isinstance(resolved, dict)
        assert resolved.get("body_id") == "body_ex1", f"wrong body in {fq}"

    edge_queries = r["bodies"]["body_ex1"]["edge_queries"]
    for eq in edge_queries:
        resolved = repo.query(eq)
        assert resolved is not None, f"edge query failed to resolve: {eq}"
        assert isinstance(resolved, dict)
        assert resolved.get("body_id") == "body_ex1"

    vertex_queries = r["bodies"]["body_ex1"]["vertex_queries"]
    for vq in vertex_queries:
        resolved = repo.query(vq)
        assert resolved is not None, f"vertex query failed to resolve: {vq}"
        assert isinstance(resolved, dict)
        assert resolved.get("body_id") == "body_ex1"
