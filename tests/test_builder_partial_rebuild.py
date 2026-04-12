import pytest

from oversolved.builder import build, _repo_from_snapshot
from solver_helpers import extrude_spec, rect_sketch_spec


def test_partial_rebuild_restores_geometry_exactly():
    """Unchanged sketch result is byte-identical after partial rebuild."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=7.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, sk2]}

    r1 = build(spec)
    geom1 = r1['result']['sk1']['geometry']

    sk2_v2 = {**sk2, 'label': 'changed'}
    spec2 = {'features': [sk1, sk2_v2]}
    r2 = build(spec2, prev_state=r1['_build_state'])
    geom2 = r2['result']['sk1']['geometry']

    assert geom1 == geom2, "sk1 geometry must be identical from cache"


def test_partial_rebuild_only_resolves_dirty():
    """Confirm sk1 is restored from cache when only sk2 is mutated."""
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=5.0, h=5.0, sketch_id='sk2')
    spec = {'features': [sk1, sk2]}
    r1 = build(spec)

    sk2_v2 = {**sk2, 'label': 'now changed'}
    spec2 = {'features': [sk1, sk2_v2]}
    r2 = build(spec2, prev_state=r1['_build_state'])

    geom1_v1 = r1['result']['sk1']['geometry']
    geom1_v2 = r2['result']['sk1']['geometry']
    assert geom1_v1 == geom1_v2
    assert r2['result']['sk2']['status'] != 'exception'


def test_partial_rebuild_cross_sketch_reference_correct():
    """Partial rebuild correctly restores repo state for cross-sketch refs."""
    sk1 = rect_sketch_spec(w=8.0, h=6.0, sketch_id='sk1')
    r_full = build({'features': [sk1, rect_sketch_spec(w=3.0, h=3.0, sketch_id='sk2')]})

    sk2_v2 = {**rect_sketch_spec(w=3.0, h=3.0, sketch_id='sk2'), 'label': 'modified'}
    spec3 = {'features': [sk1, sk2_v2]}
    r_partial = build(spec3, prev_state=r_full['_build_state'])

    assert r_partial['result']['sk1']['geometry'] == r_full['result']['sk1']['geometry']


def test_build_returns_build_state_with_correct_order():
    sk1 = rect_sketch_spec(sketch_id='sk1')
    sk2 = rect_sketch_spec(sketch_id='sk2')
    spec = {'features': [sk1, sk2]}
    r = build(spec)
    state = r['_build_state']
    assert state.feature_order == ['sk1', 'sk2']
    assert 'sk1' in state.checkpoints
    assert 'sk2' in state.checkpoints


def test_build_state_is_separate_key():
    """_build_state exists on raw build() result; app.py pops it before jsonify."""
    spec = {'features': [rect_sketch_spec()]}
    r = build(spec)
    assert '_build_state' in r
    import copy
    r2 = copy.copy(r)
    r2.pop('_build_state')
    assert '_build_state' not in r2


def test_partial_rebuild_restores_brep_face_ancestry_queries():
    """A cached build state must keep ?face ancestry queries alive for later solves."""
    pytest.importorskip("OCP.gp")

    sketch = rect_sketch_spec(sketch_id="sk1")
    extrude = extrude_spec("sk1", "ex1", 3.0)
    r1 = build({'features': [sketch, extrude]})

    face_query = r1["bodies"]["body_ex1"]["mesh"]["face_queries"][0]
    plane = {
        "id": "pl1",
        "kind": "plane",
        "definition": {
            "mode": "on_face",
            "face": face_query,
        },
    }

    r2 = build({'features': [sketch, extrude, plane]}, prev_state=r1["_build_state"])

    assert r2["result"]["pl1"]["status"] == "ok"


def test_partial_rebuild_reusing_state_does_not_duplicate_brep_face_ancestry():
    """Rebuilding from the same cached state twice must not duplicate face ancestry."""
    pytest.importorskip("OCP.gp")

    sketch = rect_sketch_spec(sketch_id="sk1")
    extrude = extrude_spec("sk1", "ex1", 3.0)
    spec = {'features': [sketch, extrude]}

    r1 = build(spec)
    r2 = build(spec, prev_state=r1["_build_state"])
    r3 = build(spec, prev_state=r2["_build_state"])

    face_query = r3["bodies"]["body_ex1"]["mesh"]["face_queries"][0]
    repo = _repo_from_snapshot(r3["_build_state"].checkpoints["ex1"].repo_snapshot)
    ancestry_ids = repo.anchestral[frozenset(["@ex1face0"])]

    assert repo.query(face_query)["body_id"] == "body_ex1"
    assert len(ancestry_ids) == 1
