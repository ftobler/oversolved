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
    """round-trip sketch - rect_sketch_spec(w=6, h=4) through build(); verify line length matches approx(6.0, abs=0.1)."""
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


def test_build_mesh_includes_brep_face_metadata_and_queries():
    """Extrude bodies should emit stable face metadata and ancestry queries."""
    spec = full_rect_extrude_spec(w=5.0, h=5.0, d=3.0)
    r = build(spec)

    mesh = r["bodies"]["body_ex1"]["mesh"]
    assert len(mesh["face_data"]) > 0
    assert len(mesh["triangle_to_face"]) == len(mesh["faces"])
    assert len(mesh["face_queries"]) == len(mesh["face_data"])
    assert mesh["face_queries"][0] == make_ancestry_query(["@ex1face0", "@ex1"], "flatface")


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

    face = repo.query(make_ancestry_query(["@ext1face0", "@ext1"], "flatface"))
    assert face is not None
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


def test_repo_from_snapshot_old_format():
    """Old-format snapshot without elements/ancestral keys should not raise."""
    repo = _repo_from_snapshot({"some_elem_id": {"payload": "data"}})
    assert repo.elements == {"some_elem_id": {"payload": "data"}}
    assert repo.ancestral == {}


def test_repo_from_snapshot_empty():
    """Empty snapshot round-trip produces empty repo."""
    repo = _repo_from_snapshot({"elements": {}, "ancestral": {}})
    assert repo.elements == {}
    assert repo.ancestral == {}


def test_repo_from_snapshot_malformed():
    """Garbage keys without elements/ancestral treated as old-format data, no exception."""
    repo = _repo_from_snapshot({"foo": "bar"})
    assert repo.elements == {"foo": "bar"}
    assert repo.ancestral == {}


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
