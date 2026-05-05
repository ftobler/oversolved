import pytest

from oversolved.kernel.builder import build, _repo_from_snapshot
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


def test_partial_rebuild_sketch_on_face_after_fuse_no_ambiguous_query():
    """Sketch placed on a B-rep face must not cause AmbiguousQueryError after a fuse.

    Sequence: sk1 -> ex1 -> sk2 (plane=face of ex1) -> ex2 (fused into ex1 body).
    Modifying sk2 triggers a partial rebuild that restores ex1's checkpoint, which
    previously carried both the early and enriched face registrations, causing two
    flatface entries for the same ancestry key.
    """
    pytest.importorskip("OCP.gp")

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    r1 = build({'features': [sk1, ex1]})

    face_query = r1['bodies']['body_ex1']['mesh']['face_queries'][0]

    sk2 = {
        'id': 'sk2',
        'kind': 'sketch',
        'plane': face_query,
        'entities': [{'id': 'l1', 'kind': 'line'}, {'id': 'l2', 'kind': 'line'},
                     {'id': 'l3', 'kind': 'line'}, {'id': 'l4', 'kind': 'line'}],
        'initial': {'l1': [0, 0, 4, 0], 'l2': [4, 0, 4, 4],
                    'l3': [4, 4, 0, 4], 'l4': [0, 4, 0, 0]},
        'constraints': [],
    }
    ex2 = extrude_spec('sk2', 'ex2', 2.0)
    spec_full = {'features': [sk1, ex1, sk2, ex2]}
    r_full = build(spec_full)

    assert r_full['result']['sk2'].get('status') != 'exception', (
        f"sk2 failed in full build: {r_full['result']['sk2'].get('exception')}"
    )

    sk2_v2 = {**sk2, 'label': 'modified'}
    spec_partial = {'features': [sk1, ex1, sk2_v2, ex2]}
    r_partial = build(spec_partial, prev_state=r_full['_build_state'])

    assert r_partial['result']['sk2'].get('status') != 'exception', (
        f"sk2 failed in partial rebuild: {r_partial['result']['sk2'].get('exception')}"
    )


def test_checkpoint_face_ancestry_uses_pre_fuse_geometry_after_undo():
    """Checkpoint for ex1 must report its own (pre-fuse) face positions,
    not the merged body's face positions, when a later fuse is undone.

    Sequence:
      full build:  sk1 -> ex1 (5mm) -> sk2 (on ex1 top face) -> ex2 (fuse 2mm)
      undo build:  sk1 -> ex1 (5mm) -> sk3 (on ex1 top face, same query)
                   using prev_state from full build

    ex1's top face (normal +Z) should have plane_transform.origin.z == 5.0.
    With the bug, the enriched checkpoint carries the post-fuse face index which
    resolves to a different face (wrong origin/normal).
    """
    pytest.importorskip("OCP.gp")

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    r_base = build({'features': [sk1, ex1]})

    face_data = r_base['bodies']['body_ex1']['mesh']['face_data']
    face_queries = r_base['bodies']['body_ex1']['mesh']['face_queries']
    top_query = next(
        fq for fd, fq in zip(face_data, face_queries)
        if fd['normal'][2] > 0.9
    )

    # sk2 needs real entities so ex2 actually creates geometry and fuses into ex1.
    sk2 = rect_sketch_spec(w=8.0, h=8.0, sketch_id='sk2', plane=top_query)
    ex2 = extrude_spec('sk2', 'ex2', 2.0)
    r_full = build({'features': [sk1, ex1, sk2, ex2]})

    assert r_full['result']['ex2']['status'] == 'ok', (
        f"ex2 failed in full build: {r_full['result']['ex2'].get('exception')}"
    )

    sk3 = {
        'id': 'sk3', 'kind': 'sketch', 'plane': top_query,
        'entities': [], 'constraints': [],
    }
    r_undo = build({'features': [sk1, ex1, sk3]}, prev_state=r_full['_build_state'])

    assert r_undo['result']['sk3']['status'] != 'exception', (
        f"sk3 failed after undo: {r_undo['result']['sk3'].get('exception')}"
    )
    origin = r_undo['result']['sk3']['plane_transform']['origin']
    assert abs(origin[2] - 5.0) < 0.1, (
        f"sk3 plane_transform origin z={origin[2]:.3f}, expected 5.0 (pre-fuse top face). "
        f"Got wrong value -- checkpoint enrichment bug confirmed."
    )


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
    ancestry_ids = repo.ancestral[frozenset(["@ex1face0", "@ex1"])]

    assert repo.query(face_query)["body_id"] == "body_ex1"
    assert len(ancestry_ids) == 1


def test_partial_rebuild_preserves_shape_identity():
    """After partial rebuild, unchanged feature's body.shape is the same object."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    spec = {'features': [sk1, ex1]}
    r1 = build(spec)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec2 = {'features': [sk1, ex1, sk2]}
    r2 = build(spec2, prev_state=r1['_build_state'])
    shape1 = r1['_build_state'].checkpoints['ex1'].body_store_snapshot['body_ex1'].shape
    shape2 = r2['_build_state'].checkpoints['ex1'].body_store_snapshot['body_ex1'].shape
    assert shape1 is shape2


def test_body_addition_in_dirty_range():
    """Insert a sketch between sk1 and ex1; ex1 re-solved but still ok."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    spec = {'features': [sk1, ex1]}
    r1 = build(spec)
    new_sk = rect_sketch_spec(w=3.0, h=2.0, sketch_id='sk_insert')
    spec2 = {'features': [sk1, new_sk, ex1]}
    r2 = build(spec2, prev_state=r1['_build_state'])
    assert r2['result']['ex1']['status'] == 'ok'


def test_partial_rebuild_feature_inserted():
    """[sk1, ex1] -> [sk1, fillet, ex1]: fillet checkpoint created, ex rebuilt."""
    pytest.importorskip("OCP.gp")

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)

    # Full build: [sk1, ex1]
    r1 = build({"features": [sk1, ex1]})
    state1 = r1["_build_state"]

    # Get an edge query from the extruded body
    edge_query = r1["bodies"]["body_ex1"]["edge_queries"][0]

    # Insert fillet at index 1 (between sk1 and ex1): [sk1, fillet, ex1]
    fillet = {"id": "fil1", "kind": "fillet", "edges": [edge_query], "radius": 1.0}
    r2 = build({"features": [sk1, fillet, ex1]}, prev_state=state1)
    state2 = r2["_build_state"]

    # sk1 checkpoint has the correct spec
    assert state2.checkpoints["sk1"].spec == sk1
    # fillet checkpoint exists
    assert "fil1" in state2.checkpoints
    # ex1 checkpoint exists and ex1 succeeded
    assert "ex1" in state2.checkpoints
    assert r2["result"]["ex1"]["status"] == "ok"


def test_partial_rebuild_feature_deleted():
    """[sk1, fillet, ex1] -> [sk1, ex1]: fillet checkpoint gone, ex rebuilt."""
    pytest.importorskip("OCP.gp")

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")

    # Use a temp build to get valid edge queries
    temp = build({"features": [
        rect_sketch_spec(w=10.0, h=10.0, sketch_id="s"),
        extrude_spec("s", "e", 5.0),
    ]})
    edge_query = temp["bodies"]["body_e"]["edge_queries"][0]

    fillet = {"id": "fil1", "kind": "fillet", "edges": [edge_query], "radius": 1.0}
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)

    # Full build: [sk1, fillet, ex1]
    r1 = build({"features": [sk1, fillet, ex1]})
    state1 = r1["_build_state"]

    # Delete fillet: [sk1, ex1]
    r2 = build({"features": [sk1, ex1]}, prev_state=state1)
    state2 = r2["_build_state"]

    # sk1 checkpoint has the correct spec
    assert state2.checkpoints["sk1"].spec == sk1
    # fillet checkpoint gone
    assert "fil1" not in state2.checkpoints
    # ex1 checkpoint exists and ex1 succeeded
    assert "ex1" in state2.checkpoints
    assert r2["result"]["ex1"]["status"] == "ok"


def test_partial_rebuild_feature_reordered():
    """[sk1, ex1, fillet] -> [sk1, fillet, ex1]: all after index 0 rebuilt."""
    pytest.importorskip("OCP.gp")

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)

    # Temp build to get edge queries
    temp = build({"features": [
        rect_sketch_spec(w=10.0, h=10.0, sketch_id="s"),
        extrude_spec("s", "e", 5.0),
    ]})
    edge_query = temp["bodies"]["body_e"]["edge_queries"][0]

    fillet = {"id": "fil1", "kind": "fillet", "edges": [edge_query], "radius": 1.0}

    # Full build: [sk1, ex1, fillet]
    r1 = build({"features": [sk1, ex1, fillet]})
    state1 = r1["_build_state"]

    # Reorder: [sk1, fillet, ex1]
    r2 = build({"features": [sk1, fillet, ex1]}, prev_state=state1)
    state2 = r2["_build_state"]

    # sk1 checkpoint has the correct spec
    assert state2.checkpoints["sk1"].spec == sk1
    # fillet checkpoint exists
    assert "fil1" in state2.checkpoints
    # ex1 checkpoint exists
    assert "ex1" in state2.checkpoints
    # feature_order reflects new order
    assert state2.feature_order == ["sk1", "fil1", "ex1"]
    # ex1 succeeded after reorder
    assert r2["result"]["ex1"]["status"] == "ok"


def test_partial_rebuild_add_sketch_mid_stack():
    """[sk1, ex1] -> [sk1, sk2, ex1, ex2]: sk1 checkpoint reused."""
    pytest.importorskip("OCP.gp")

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)

    # Full build: [sk1, ex1]
    r1 = build({"features": [sk1, ex1]})
    state1 = r1["_build_state"]

    # Add sketch mid-stack: [sk1, sk2, ex1, ex2]
    sk2 = rect_sketch_spec(w=5.0, h=5.0, sketch_id="sk2")
    ex2 = extrude_spec("sk2", "ex2", distance=3.0)
    r2 = build({"features": [sk1, sk2, ex1, ex2]}, prev_state=state1)
    state2 = r2["_build_state"]

    # sk1 checkpoint has the correct spec
    assert state2.checkpoints["sk1"].spec == sk1
    # sk2 checkpoint created
    assert "sk2" in state2.checkpoints
    # ex1 checkpoint exists
    assert "ex1" in state2.checkpoints
    # ex2 checkpoint created
    assert "ex2" in state2.checkpoints
    # feature_order reflects all 4 features
    assert state2.feature_order == ["sk1", "sk2", "ex1", "ex2"]
    # Both extrudes succeeded
    assert r2["result"]["ex1"]["status"] == "ok"
    assert r2["result"]["ex2"]["status"] == "ok"
    # At least body_ex1 is present (ex2 may fuse into the same body)
    assert "body_ex1" in r2["bodies"]


def test_corrupted_checkpoint_missing_body_id():
    """Missing body_id in body_store_snapshot should not crash."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    spec = {'features': [sk1, ex1]}
    r1 = build(spec)
    r1['_build_state'].checkpoints['ex1'].body_store_snapshot.pop('body_ex1', None)
    sk_new = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk_new')
    spec2 = {'features': [sk1, ex1, sk_new]}
    r2 = build(spec2, prev_state=r1['_build_state'])
    assert r2['result']['sk_new']['status'] != 'exception'
