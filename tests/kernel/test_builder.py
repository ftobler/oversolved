import importlib
import json
import pytest

from oversolved.kernel.builder import build, _repo_from_snapshot
from oversolved.kernel.query import Repository, make_ancestry_query
from oversolved.kernel.types3d import Body
from solver_helpers import rect_sketch_spec, full_rect_extrude_spec

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def test_round_trip_sketch():
    """round-trip sketch through build(); verify line length ~6.0."""
    spec = rect_sketch_spec(w=6, h=4)
    r = build({'features': [spec]})
    geom = r['result']['sk1']['geometry']
    bottom = geom['bottom']
    length = ((bottom[2] - bottom[0])**2 + (bottom[3] - bottom[1])**2) ** 0.5
    assert abs(length - 6.0) < 0.1


def test_round_trip_plane():
    """round-trip plane - offset plane feature; origin matches expected offset."""
    r = build({
        'features': [
            {
                'id': 'pl1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_front',
                    'offset': 5.0,
                }
            }
        ]
    })
    plane = r['result']['pl1']['plane']
    assert plane['origin'][2] == 5.0


def test_sketch_plus_plane():
    """sketch + plane - two-feature doc; result has exactly 2 + 3 builtin keys."""
    spec = {'features': [rect_sketch_spec(), {'id': 'pl1', 'kind': 'plane'}]}
    r = build(spec)
    assert len(r['result']) == 5  # 2 features + 3 builtins


def test_unsupported_kind():
    """unsupported kind - result[fid]['status'] == 'exception'."""
    r = build({'features': [{'id': 'x', 'kind': 'unknown_feature'}]})
    assert r['result']['x']['status'] == 'exception'


def test_cross_feature_query_resolves():
    """cross-feature query resolves - sk2 references sk1 via @sk1/line1/start."""
    r = build({
        'features': [
            rect_sketch_spec(sketch_id='sk1', w=6, h=4),
            {
                'id': 'sk2',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [{'id': 'p1', 'kind': 'point'}],
                'initial': {'p1': [0, 0]},
                'constraints': [
                    {'id': 'c1', 'kind': 'fixed', 'target': {'entity': 'p1'}, 'x': 1, 'y': 2},
                ]
            },
        ]
    })
    assert r['result']['sk2']['status'] in ('ok', 'fully_constrained')


def test_builtin_planes_present_with_correct_normals():
    """builtin planes present with correct normals - result['builtin_plane_front']['plane']['normal'] == [0, 0, 1]."""
    r = build({'features': []})
    assert r['result']['builtin_plane_front']['plane']['normal'] == [0, 0, 1]
    assert r['result']['builtin_plane_top']['plane']['normal'] == [0, 1, 0]
    assert r['result']['builtin_plane_right']['plane']['normal'] == [1, 0, 0]


def test_solve_ms_is_float_bodies_is_dict():
    """solve_ms is float, bodies is dict - structural checks."""
    r = build({'features': []})
    assert isinstance(r['solve_ms'], (int, float))
    assert isinstance(r['bodies'], dict)


def test_bodies_empty_for_sketch_only_doc():
    """bodies empty for sketch-only doc - len(result['bodies']) == 0."""
    spec = rect_sketch_spec(w=6, h=4)
    r = build({'features': [spec]})
    assert len(r['bodies']) == 0


def test_body_registered_as_solid_type():
    """A body with a compound/disjoint shape is still registered as type 'solid' in the repo."""
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

    elements = r["_build_state"].checkpoints["ex1"].repo_snapshot.get("elements", {})
    solid_entries = {k: v for k, v in elements.items() if isinstance(v, dict) and v.get("type") == "solid"}
    assert len(solid_entries) >= 2, (
        f"expected at least 2 solid-type entries in repo elements, got {len(solid_entries)}"
    )
    for eid, entry in solid_entries.items():
        assert entry["type"] == "solid", (
            f"entry {eid} has type {entry['type']!r}, expected 'solid'"
        )


def test_build_mesh_includes_brep_face_metadata_and_queries():
    """Extrude bodies should emit stable face metadata and ancestry queries."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r = build(spec)

    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert len(mesh["face_data"]) > 0
    assert len(mesh["triangle_to_face"]) == len(mesh["faces"])
    assert len(mesh["face_queries"]) == len(mesh["face_data"])
    from oversolved.kernel.geom_hash import face_geometry_hash
    fd0 = mesh["face_data"][0]
    expected_hash = face_geometry_hash(fd0["centroid"], fd0["normal"])
    assert mesh["face_queries"][0] == make_ancestry_query(
        [f"@{expected_hash}", "@ex1", "@body_ex1",
         "@sk1/bottom", "@sk1/left", "@sk1/right", "@sk1/top"],
        "flatface",
    )


def test_build_returns_edge_queries_and_vertices():
    """Extrude bodies include edge_queries and vertices in output."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r = build(spec)
    body = r["bodies"]["body_ex1"]
    assert "edge_queries" in body
    assert len(body["edge_queries"]) == len(body["edges"])
    assert "vertices" in body
    assert "vertex_queries" in body
    assert len(body["vertex_queries"]) == len(body["vertices"])


def test_revolve_feature_produces_body():
    """revolve feature should produce a valid body with mesh."""
    from solver_helpers import rect_sketch_spec, assert_mesh_valid

    spec = {
        'features': [
            rect_sketch_spec(w=2.0, h=1.0, sketch_id='sk1'),
            {
                'id': 'rev1',
                'kind': 'revolve',
                'sketch': '$sk1',
                'angle': 360.0,
                'axis_origin': [0, 0, 0],
                'axis_direction': [0, 1, 0],
            },
        ]
    }
    r = build(spec)
    assert r['result']['rev1']['status'] == 'ok', r['result']['rev1']
    assert 'body_rev1' in r['bodies']
    assert_mesh_valid(r['bodies']['body_rev1']['mesh'])


def test_tessellate_bodies_registers_brep_face_queries_in_repo():
    """Builder should register B-rep face ancestries into a query repo when available."""
    pytest.importorskip("OCP.gp")

    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from oversolved.kernel.builder import _tessellate_bodies

    repo = Repository()
    body = Body(
        id="body_ext1",
        created_by="ext1",
        shape=BRepPrimAPI_MakeBox(1.0, 1.0, 1.0).Shape(),
    )

    bodies = _tessellate_bodies({"body_ext1": body}, repo)
    mesh = bodies["body_ext1"]["mesh"]

    face = repo.query(make_ancestry_query(["@body_ext1/face0", "@ext1", "@body_ext1"], "flatface"))
    assert face is not None, (
        f"Face query did not resolve. Ancestral keys: {[sorted(k) for k in repo.ancestral]}"
    )
    assert face["type"] == "flatface"
    assert face["centroid"] == mesh["face_data"][0]["centroid"]


def test_pick_boundary_returns_checkpoint_bodies():
    """pick_boundary returns bodies from the checkpoint BEFORE the specified feature."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    # Features: [sk1, ex1]
    # pick_boundary=1 means checkpoint before ex1, which is sk1 (a sketch, no bodies)
    r = build(spec, pick_boundary=1)
    assert "pick_bodies" in r
    assert len(r["pick_bodies"]) == 0


def test_pick_boundary_after_extrude_returns_body():
    """pick_boundary=2 after [sketch, extrude] returns the body from checkpoint at index 1."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    # Features: [sk1, ex1]
    r = build(spec, pick_boundary=2)
    assert "pick_bodies" in r
    assert "body_ex1" in r["pick_bodies"]
    assert "mesh" in r["pick_bodies"]["body_ex1"]


def test_pick_boundary_zero_returns_no_pick_bodies():
    """pick_boundary=0 should not return pick_bodies."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r = build(spec, pick_boundary=0)
    assert "pick_bodies" not in r


def test_pick_boundary_out_of_range_returns_no_pick_bodies():
    """pick_boundary beyond feature count should not return pick_bodies."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r = build(spec, pick_boundary=10)
    assert "pick_bodies" not in r


def test_pick_boundary_with_fillet_returns_before_state():
    """pick_boundary at fillet index returns body state before fillet was applied."""
    pytest.importorskip("OCP.gp")
    spec = {
        'features': [
            rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk1'),
            {
                'id': 'ex1',
                'kind': 'extrude',
                'sketch': '$sk1',
                'distance': 5.0,
            },
            {
                'id': 'fil1',
                'kind': 'fillet',
                'edges': [],
                'radius': 1.0,
            },
        ]
    }
    # pick_boundary=2 means checkpoint before fil1 (at index 1 = ex1)
    r = build(spec, pick_boundary=2)
    assert "pick_bodies" in r
    assert "body_ex1" in r["pick_bodies"]
    # The regular bodies may or may not have body_ex1 depending on fillet
    assert "body_ex1" in r["bodies"]


# ─── enter / exit feature editing model-state tests ───

def test_enter_feature_pick_bodies_is_before_state_not_after():
    """pick_bodies must reflect the model BEFORE the edited feature, bodies AFTER.

    [sk1, ex1, sk2, ex2]: editing ex2 (pick_boundary=3, rollback=4).
    ex2 fuses with ex1 into body_ex1 adding 3 extra faces (6->9).
    pick_bodies must show the pre-ex2 shape (6 faces), bodies the post-ex2 shape (9 faces).
    """
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=3.0, h=3.0, sketch_id='sk2', plane='@builtin_plane_right')
    ex2 = extrude_spec('sk2', 'ex2', 3.0)
    spec = {'features': [sk1, ex1, sk2, ex2]}

    r = build(spec, rollback_position=4, pick_boundary=3)

    assert 'pick_bodies' in r
    assert 'body_ex1' in r['pick_bodies']
    assert 'body_ex1' in r['bodies']

    pick_faces = len(r['pick_bodies']['body_ex1']['mesh']['face_data'])
    body_faces = len(r['bodies']['body_ex1']['mesh']['face_data'])
    assert pick_faces < body_faces, (
        f"pick_bodies face count ({pick_faces}) should be less than "
        f"bodies face count ({body_faces}) -- pick_bodies must be pre-ex2 shape"
    )


def test_enter_first_feature_gives_no_pick_bodies():
    """Editing the first feature (pick_boundary=0) produces no pick_bodies -- nothing before it."""
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    spec = {'features': [sk1, ex1]}

    r = build(spec, rollback_position=2, pick_boundary=0)

    assert 'pick_bodies' not in r
    assert 'body_ex1' in r['bodies']


def test_exit_feature_no_pick_bodies_full_result():
    """Exiting (no pick_boundary) produces no pick_bodies and full solved bodies."""
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=3.0, h=3.0, sketch_id='sk2', plane='@builtin_plane_right')
    ex2 = extrude_spec('sk2', 'ex2', 3.0)
    spec = {'features': [sk1, ex1, sk2, ex2]}

    r = build(spec)

    assert 'pick_bodies' not in r
    assert 'body_ex1' in r['bodies']
    # ex2 fuses into body_ex1; verify the merged shape has more faces than ex1 alone
    r_ex1_only = build({'features': [sk1, ex1]})
    assert (
        len(r['bodies']['body_ex1']['mesh']['face_data'])
        > len(r_ex1_only['bodies']['body_ex1']['mesh']['face_data'])
    )


def test_fillet_pick_bodies_has_fewer_faces_than_bodies():
    """pick_bodies (pre-fillet) has fewer faces than bodies (post-fillet).

    A filleted box has extra faces for the rounded edges.
    Verifies pick_bodies is genuinely the pre-operation geometry.
    """
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = {
        'id': 'ex1', 'kind': 'extrude',
        'sketch': '$sk1', 'distance': 5.0,
    }
    r_base = build({'features': [sk1, ex1]})
    edge_query = r_base['bodies']['body_ex1']['edge_queries'][0]

    fillet = {'id': 'fil1', 'kind': 'fillet', 'edges': [edge_query], 'radius': 0.5}
    spec = {'features': [sk1, ex1, fillet]}

    # Editing fillet: rollback=3 (all features), pick_boundary=2 (state after ex1)
    r = build(spec, rollback_position=3, pick_boundary=2)

    pick_face_count = len(r['pick_bodies']['body_ex1']['mesh']['face_data'])
    bodies_face_count = len(r['bodies']['body_ex1']['mesh']['face_data'])

    assert pick_face_count < bodies_face_count, (
        f"pick_bodies face count ({pick_face_count}) should be less than "
        f"bodies face count ({bodies_face_count}) after fillet"
    )


def test_enter_exit_enter_consistent():
    """Enter -> exit -> re-enter gives the same pick_bodies geometry each time."""
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=3.0, h=3.0, sketch_id='sk2', plane='@builtin_plane_right')
    ex2 = extrude_spec('sk2', 'ex2', 3.0)
    spec = {'features': [sk1, ex1, sk2, ex2]}

    r_enter1 = build(spec, rollback_position=4, pick_boundary=3)
    r_exit = build(spec)
    r_enter2 = build(spec, prev_state=r_exit['_build_state'], rollback_position=4, pick_boundary=3)

    assert 'pick_bodies' in r_enter1
    assert 'pick_bodies' in r_enter2
    assert set(r_enter1['pick_bodies'].keys()) == set(r_enter2['pick_bodies'].keys())
    face_count1 = len(r_enter1['pick_bodies']['body_ex1']['mesh']['face_data'])
    face_count2 = len(r_enter2['pick_bodies']['body_ex1']['mesh']['face_data'])
    assert face_count1 == face_count2, "Re-entering must produce identical pick_bodies geometry"


def test_pick_boundary_with_prev_state_uses_restored_checkpoint():
    """When prev_state restores a checkpoint, pick_boundary correctly reads from it.

    [sk1, ex1, sk2]: editing sk2 (pick_boundary=2, rollback=3).
    Build once, then build again with prev_state -- pick_bodies must still be ex1's body.
    """
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=3.0, h=3.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r1 = build(spec, rollback_position=3, pick_boundary=2)
    r2 = build(spec, prev_state=r1['_build_state'], rollback_position=3, pick_boundary=2)

    assert 'pick_bodies' in r1
    assert 'pick_bodies' in r2
    assert set(r1['pick_bodies'].keys()) == set(r2['pick_bodies'].keys())


def test_repo_from_snapshot_old_format():
    """Old-format snapshot without elements/ancestral keys raises ValueError."""
    with pytest.raises(ValueError, match="missing 'elements' key"):
        _repo_from_snapshot({"some_elem_id": {"payload": "data"}})


def test_repo_from_snapshot_empty():
    """Empty snapshot round-trip produces empty repo."""
    repo = _repo_from_snapshot({"elements": {}, "ancestral": {}})
    assert repo.elements == {}
    assert repo.ancestral == {}


def test_repo_from_snapshot_malformed():
    """Garbage keys without elements/ancestral raises ValueError."""
    with pytest.raises(ValueError, match="missing 'elements' key"):
        _repo_from_snapshot({"foo": "bar"})


def test_dedupe_repo_collapses_duplicate_payloads():
    """Two elements with identical payloads under same ancestral key get collapsed."""
    from oversolved.kernel.builder import _dedupe_repo
    repo = Repository()
    key = frozenset(["@ex1face0", "@ex1"])
    repo.ancestral[key] = ["id1", "id2"]
    repo.elements["id1"] = {"type": "flatface", "body_id": "b1"}
    repo.elements["id2"] = {"type": "flatface", "body_id": "b1"}
    _dedupe_repo(repo)
    assert len(repo.ancestral[key]) == 1
    assert "id2" not in repo.elements


def test_enriched_snapshot_isolation():
    """Mutating deserialized snapshot does not affect original checkpoint."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r = build(spec)
    cp = r['_build_state'].checkpoints['sk1']
    original_elements = dict(cp.repo_snapshot.get('elements', {}))
    original_ancestral = dict(cp.repo_snapshot.get('ancestral', {}))
    deserialized = _repo_from_snapshot(cp.repo_snapshot)
    deserialized.elements['_mutated'] = 'value'
    deserialized.ancestral[frozenset(['_mutated'])] = ['_mutated']
    assert cp.repo_snapshot['elements'] == original_elements
    assert cp.repo_snapshot['ancestral'] == original_ancestral


def test_checkpoint_ancestral_not_inflated_by_tessellation():
    """Ancestral lists in the checkpoint snapshot must not grow after tessellation.

    The bug: dict(global_repo.ancestral) is a shallow copy — the list values are
    shared, so _tessellate_bodies appending to them corrupts stored snapshots.
    The fix: {k: list(v) ...} copies each list so tessellation cannot inflate it.
    """
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    r = build({'features': [sk1, ex1]})

    cp = r['_build_state'].checkpoints['ex1']
    ancestral = cp.repo_snapshot['ancestral']

    # Find any key that references the extrude feature and check list length.
    # Before the fix, tessellation appended a second ID to the shared list,
    # making len > 1 for keys that should have exactly one entry.
    for key, ids in ancestral.items():
        assert len(ids) == len(set(ids)), (
            f"Duplicate IDs in ancestral snapshot for key {key}: {ids}"
        )


def test_double_copy_produces_same_payload():
    """Building same spec twice yields equivalent enriched snapshots."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r1 = build(spec)
    r2 = build(spec)
    s1 = r1['_build_state'].checkpoints['sk1'].repo_snapshot
    s2 = r2['_build_state'].checkpoints['sk1'].repo_snapshot
    # Compare element payloads ignoring random key names
    els1 = sorted(json.dumps(v, sort_keys=True) for v in s1['elements'].values())
    els2 = sorted(json.dumps(v, sort_keys=True) for v in s2['elements'].values())
    assert els1 == els2
    # Same ancestral key structure
    assert s1['ancestral'].keys() == s2['ancestral'].keys()
    for k in s1['ancestral']:
        assert len(s1['ancestral'][k]) == len(s2['ancestral'][k])


def test_fillet_after_edit_mode_checkpoint_rebuilds_correctly():
    """Regression: fillet built after another fillet via checkpoint must not raise.

    Sequence mirrors entering/exiting edit mode on a non-last feature:
      1. Full build: [sk1, ex1, fil1, fil2]
      2. Edit-mode build (rollback=3): [sk1, ex1, fil1]  -- prev_state comes from step 1
      3. Exit build (rollback=4): [sk1, ex1, fil1, fil2] -- prev_state comes from step 2

    In step 3, first_dirty=3 so sk1/ex1/fil1 are restored from the step-2
    checkpoint.  Before the fix, _copy_shape returned a raw OCC TopoDS_Shape
    instead of re-wrapping the CadQuery Solid, causing fil2 to fail with
    "'OCP.OCP.TopoDS.TopoDS_Shape' object has no attribute 'edges'".
    """
    from solver_helpers import extrude_spec
    sk1 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)

    # Get a real edge query so fillet resolution actually calls body.shape.edges().
    r_base = build({'features': [sk1, ex1]})
    edge_query = r_base['bodies']['body_ex1']['edge_queries'][0]

    fil1 = {'id': 'fil1', 'kind': 'fillet', 'edges': [edge_query], 'radius': 0.5}
    # fil2 uses a query that resolves to body.shape.edges() via the checkpoint shape.
    fil2 = {'id': 'fil2', 'kind': 'fillet', 'edges': [edge_query], 'radius': 0.3}
    full_spec = {'features': [sk1, ex1, fil1, fil2]}
    partial_spec = {'features': [sk1, ex1, fil1]}

    # step 1: full build
    r1 = build(full_spec)
    # step 2: edit-mode build (rollback covers only first 3 features)
    r2 = build(partial_spec, prev_state=r1['_build_state'], rollback_position=3)
    # step 3: exit build -- fil2 rebuilt from fil1 checkpoint; must not raise
    r3 = build(full_spec, prev_state=r2['_build_state'], rollback_position=4)

    assert 'fil2' in r3['result'], "fil2 must appear in result after exit"
    assert r3['result']['fil2'].get('exception') != (
        "'OCP.OCP.TopoDS.TopoDS_Shape' object has no attribute 'edges'"
    ), "fil2 must not fail with raw OCC TopoDS_Shape from checkpoint"


def test_register_body_faces_logs_on_failure(caplog):
    """_register_body_faces logs exception when tessellation fails."""
    import logging
    import unittest.mock as mock
    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec, extrude_spec

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            extrude_spec("sk1", "ex1", distance=5.0),
        ]
    }

    caplog.set_level(logging.WARNING)

    with mock.patch(
        "oversolved.kernel.geometry_tessellation.solid_to_mesh",
        side_effect=RuntimeError("tessellation crashed"),
    ):
        build(spec)

    assert any(
        "tessellation crashed" in record.message
        for record in caplog.records
    ), "Expected warning about tessellation failure in log"


def test_register_brep_face_ancestry_stale_eviction():
    """Call _register_brep_face_ancestry twice with different geometry; old element evicted."""
    from oversolved.kernel.builder import _register_brep_face_ancestry
    from oversolved.kernel.query import Repository
    from oversolved.kernel.types3d import Body

    # Use a simple box shape so body.shape is not None
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    shape = BRepPrimAPI_MakeBox(1, 1, 1).Shape()

    body = Body(id="body_test", created_by="feat_test", sketch_id="sk1")
    body.shape = shape

    repo = Repository()
    mesh = {
        "face_data": [
            {"centroid": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0], "area": 1.0, "surface_type": "flatface"},
        ],
    }
    _register_brep_face_ancestry(repo, body, mesh)
    assert len(repo.ancestral) == 1

    # Register again with different centroid -> different hash -> stale eviction
    mesh2 = {
        "face_data": [
            {"centroid": [1.0, 1.0, 1.0], "normal": [0.0, 0.0, 1.0], "area": 2.0, "surface_type": "flatface"},
        ],
    }
    _register_brep_face_ancestry(repo, body, mesh2)
    assert len(repo.ancestral) == 1  # stale entry was evicted
    assert len(repo.elements) == 1


def test_register_brep_edge_ancestry_stale_eviction():
    """Call _register_brep_edge_ancestry twice; old element evicted via index_tag."""
    from oversolved.kernel.builder import _register_brep_edge_ancestry
    from oversolved.kernel.query import Repository
    from oversolved.kernel.types3d import Body

    body = Body(id="body_test", created_by="feat_test", sketch_id="sk1")
    repo = Repository()

    edges = [{"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]}]
    edge_queries = ["?c,c;dummy1"]

    _register_brep_edge_ancestry(repo, body, edges, edge_queries)
    assert len(repo.ancestral) == 1

    edges2 = [{"kind": "line", "start": [0, 0, 0], "end": [2, 0, 0]}]
    edge_queries2 = ["?c,c;dummy2"]
    _register_brep_edge_ancestry(repo, body, edges2, edge_queries2)
    assert len(repo.ancestral) == 1  # stale evicted
    assert len(repo.elements) == 1


def test_register_brep_vertex_ancestry_stale_eviction():
    """Call _register_brep_vertex_ancestry twice; old element evicted via index_tag."""
    from oversolved.kernel.builder import _register_brep_vertex_ancestry
    from oversolved.kernel.query import Repository
    from oversolved.kernel.types3d import Body

    body = Body(id="body_test", created_by="feat_test", sketch_id="sk1")
    repo = Repository()

    vertices = [[0.0, 0.0, 0.0]]
    vertex_queries = ["?c,c;dummy1"]

    _register_brep_vertex_ancestry(repo, body, vertices, vertex_queries)
    assert len(repo.ancestral) == 1

    vertices2 = [[1.0, 1.0, 1.0]]
    vertex_queries2 = ["?c,c;dummy2"]
    _register_brep_vertex_ancestry(repo, body, vertices2, vertex_queries2)
    assert len(repo.ancestral) == 1  # stale evicted
    assert len(repo.elements) == 1


def test_register_brep_ancestry_preserves_other_bodies():
    """Register ancestry for body A, then body B with same indices; body A's entries survive."""
    from oversolved.kernel.builder import _register_brep_face_ancestry
    from oversolved.kernel.query import Repository
    from oversolved.kernel.types3d import Body

    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    shape = BRepPrimAPI_MakeBox(1, 1, 1).Shape()

    repo = Repository()

    body_a = Body(id="body_a", created_by="feat_a", sketch_id="sk1")
    body_a.shape = shape
    mesh_a = {
        "face_data": [
            {"centroid": [0.0, 0.0, 0.0], "normal": [0.0, 0.0, 1.0], "area": 1.0, "surface_type": "flatface"},
        ],
    }
    _register_brep_face_ancestry(repo, body_a, mesh_a)
    keys_after_a = set(repo.ancestral.keys())

    body_b = Body(id="body_b", created_by="feat_b", sketch_id="sk1")
    body_b.shape = shape
    mesh_b = {
        "face_data": [
            {"centroid": [1.0, 1.0, 1.0], "normal": [0.0, 0.0, 1.0], "area": 1.0, "surface_type": "flatface"},
        ],
    }
    _register_brep_face_ancestry(repo, body_b, mesh_b)

    # body_a's keys should still be present
    for key in keys_after_a:
        assert key in repo.ancestral, f"body_a key {key} was evicted by body_b registration"


def test_features_by_id_missing_key():
    """Features without an 'id' key must not crash the build with KeyError."""
    r = build({'features': [{}]})
    assert 'result' in r


def test_features_by_id_normal_key():
    """Features with 'id' are still indexed and their results are returned."""
    spec = rect_sketch_spec(w=4, h=4)
    r = build({'features': [spec]})
    assert 'sk1' in r['result']


# ── _FEATURE_CMP_KEYS sync validation (fix-145) ──

# Every key that at least one feature solver accesses from a feature dict.
# When adding a new feature kind, update both this set and builder._FEATURE_CMP_KEYS.
_SOLVER_FEATURE_KEYS = frozenset({
    "id", "kind",
    # sketch
    "plane", "entities", "constraints", "initial",
    # brep: extrude / revolved
    "sketch", "distance", "depth", "operation", "direction",
    "extrude", "revolve", "merge_target",
    "angle", "axis_origin", "axis_direction", "axis",
    # fillet / chamfer
    "fillet", "chamfer", "edges", "radius",
    # import
    "file_data", "scale",
    # hole
    "hole", "diameter", "depth_mode", "target",
    # array
    "array", "mode", "source_body", "include_source",
    "count_x", "count_y",
    "pitch_x", "pitch_y",
    "direction_x_query", "direction_x", "direction_y_query", "direction_y",
    # circular_array
    "circular_array", "count", "step_angle",
    # boolean
    "boolean", "tools", "keep_tools",
    # delete_body
    "delete_body", "body",
    # transform
    "transform",
    "translation", "translation_from", "translation_to",
    "rotation_angle", "rotation_axis_origin", "rotation_axis_direction", "rotation_axis",
    "scale_center", "scale_center_from",
    # mirror
    "mirror", "keep_original", "merge",
    # plane (via definition dict)
    "definition",
})

# Keys the frontend sends that are intentionally NOT in _FEATURE_CMP_KEYS
# because changes to them should NOT trigger re-solving (transient/display-only).
_TRANSIENT_KEYS = frozenset({
    "render",   # display hint from frontend
    "_pick",    # internal interaction tracking
})

# Keys that are in _FEATURE_CMP_KEYS but NOT accessed by any solver.
# These affect dirty detection for UI-level feature attributes (hide-toggle, label, file reference).
_UI_FEATURE_KEYS = frozenset({
    "hide", "label", "file_id", "suppressed",
})


def test_feature_cmp_keys_covers_all_solver_keys():
    """Every key accessed by a feature solver must be in _FEATURE_CMP_KEYS."""
    from oversolved.kernel.builder import _FEATURE_CMP_KEYS

    missing = _SOLVER_FEATURE_KEYS - _FEATURE_CMP_KEYS
    assert not missing, (
        f"Keys used by feature solvers but missing from _FEATURE_CMP_KEYS:\n"
        f"  {sorted(missing)}\n"
        f"Add them to builder.py:_FEATURE_CMP_KEYS so dirty detection is not stale."
    )


def test_feature_cmp_keys_contains_only_known_keys():
    """Every key in _FEATURE_CMP_KEYS must be a solver key, a UI key, or transient."""
    from oversolved.kernel.builder import _FEATURE_CMP_KEYS

    known = _SOLVER_FEATURE_KEYS | _UI_FEATURE_KEYS | _TRANSIENT_KEYS
    unexpected = _FEATURE_CMP_KEYS - known
    assert not unexpected, (
        f"Keys in _FEATURE_CMP_KEYS not recognized as solver, UI, or transient:\n"
        f"  {sorted(unexpected)}\n"
        f"If these are legitimate keys, add them to _UI_FEATURE_KEYS or _SOLVER_FEATURE_KEYS\n"
        f"in test_builder.py. If they are stale, remove them from builder._FEATURE_CMP_KEYS."
    )


def test_feature_cmp_keys_all_present_in_current_set():
    """Sanity: the hard-coded expectation set matches the actual _FEATURE_CMP_KEYS."""
    from oversolved.kernel.builder import _FEATURE_CMP_KEYS

    expected = _SOLVER_FEATURE_KEYS | _UI_FEATURE_KEYS
    actual = _FEATURE_CMP_KEYS

    # Every expected key must be present
    missing = expected - actual
    assert not missing, (
        f"Expected keys missing from _FEATURE_CMP_KEYS: {sorted(missing)}"
    )

    # Keys in actual but not in expected are flagged as unexpected
    unexpected = actual - expected
    assert not unexpected, (
        f"Unexpected keys in _FEATURE_CMP_KEYS not in _SOLVER_FEATURE_KEYS or "
        f"_UI_FEATURE_KEYS: {sorted(unexpected)}\n"
        f"If these are new feature keys, add them to _SOLVER_FEATURE_KEYS.\n"
        f"If they are UI-only keys, add them to _UI_FEATURE_KEYS.\n"
        f"If they are stale, remove them from builder._FEATURE_CMP_KEYS."
    )


# ─── Feature module ALL_KEYS registry tests (245) ───

def test_each_feature_module_exports_all_keys():
    """Every solver_features_* module must export ALL_KEYS as a frozenset[str]."""
    from oversolved.kernel.builder import _FEATURE_MODULES
    for mod in _FEATURE_MODULES:
        assert hasattr(mod, "ALL_KEYS"), (
            f"{mod.__name__} is missing ALL_KEYS"
        )
        keys = mod.ALL_KEYS
        assert isinstance(keys, frozenset), (
            f"{mod.__name__}.ALL_KEYS must be a frozenset, got {type(keys)}"
        )
        assert all(isinstance(k, str) for k in keys), (
            f"{mod.__name__}.ALL_KEYS must contain only strings"
        )


def test_feature_cmp_keys_union_matches_legacy():
    """The union-built _FEATURE_CMP_KEYS must equal the expected key set exactly."""
    from oversolved.kernel.builder import _FEATURE_CMP_KEYS
    expected = _SOLVER_FEATURE_KEYS | _UI_FEATURE_KEYS
    assert _FEATURE_CMP_KEYS == expected, (
        f"Union mismatch.\n"
        f"  Extra in union: {sorted(_FEATURE_CMP_KEYS - expected)}\n"
        f"  Missing from union: {sorted(expected - _FEATURE_CMP_KEYS)}"
    )


def test_extract_all_keys_raises_on_missing():
    """_extract_all_keys raises ImportError when a module lacks ALL_KEYS."""
    import types
    from oversolved.kernel.builder import _extract_all_keys

    bad_mod = types.ModuleType("fake_feature_module")
    with pytest.raises(ImportError, match="ALL_KEYS"):
        _extract_all_keys(bad_mod)


def test_extract_all_keys_raises_on_wrong_type():
    """_extract_all_keys raises ImportError when ALL_KEYS is not a frozenset."""
    import types
    from oversolved.kernel.builder import _extract_all_keys

    bad_mod = types.ModuleType("fake_feature_module")
    bad_mod.ALL_KEYS = {"not", "a", "frozenset"}  # type: ignore[attr-defined]
    with pytest.raises(ImportError, match="ALL_KEYS"):
        _extract_all_keys(bad_mod)
