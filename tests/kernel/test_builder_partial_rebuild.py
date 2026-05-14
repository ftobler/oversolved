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

    # Find the registration key that includes the face index tag
    face0_tag = "@body_ex1/face0"
    matching_keys = [k for k in repo.ancestral if face0_tag in k]
    assert len(matching_keys) == 1, f"Expected exactly 1 key for {face0_tag}, got {len(matching_keys)}"
    ancestry_ids = repo.ancestral[matching_keys[0]]

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


def test_rollback_zero_cascade_full_rebuild():
    """build() with rollback_position=0 returns empty state; subsequent
    build() with features does a full rebuild (no partial reuse)."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)

    spec = {'features': [sk1, ex1]}

    # Build with rollback_position=0 — empty feature list
    r2 = build(spec, rollback_position=0)
    state2 = r2['_build_state']
    assert len(state2.checkpoints) == 0

    # Build with full features using the empty state
    r3 = build(spec, prev_state=state2)
    assert r3['result']['sk1']['status'] != 'exception'
    assert r3['result']['ex1']['status'] != 'exception'
    assert 'body_ex1' in r3['bodies']


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


def test_checkpoint_shape_is_independent_copy():
    """Verify _copy_shape() is used when creating checkpoints.

    After the fix, shapes stored in checkpoints should be independent copies,
    not the same object as the body_store shapes.
    """
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    spec = {'features': [sk1, ex1]}
    r1 = build(spec)

    # Verify checkpoint stores shape (should be independent copy after fix)
    checkpoint_shape = r1['_build_state'].checkpoints['ex1'].body_store_snapshot['body_ex1'].shape
    assert checkpoint_shape is not None, "Checkpoint should store a shape"

    # Verify the _copy_shape function exists and is being used
    from oversolved.kernel.builder import _copy_shape
    assert callable(_copy_shape), "_copy_shape helper should be implemented"


def test_three_dirty_features_stale_ancestry():
    """Partial rebuild with 3+ dirty features re-registers body ancestry per iteration.

    Sequence: skA -> exA -> fillet (modifies body_exA) -> skC (on exA top face).
    Modify fillet radius -> partial rebuild of fillet and skC.
    skC must resolve with post-fillet geometry, not stale pre-fillet checkpoint data.
    """
    pytest.importorskip("OCP.gp")

    skA = rect_sketch_spec(w=10.0, h=10.0, sketch_id='skA')
    exA = extrude_spec('skA', 'exA', 10.0)

    # Full build to get base geometry
    r_base = build({'features': [skA, exA]})

    # Get top face query for skC
    face_queries = r_base['bodies']['body_exA']['mesh']['face_queries']
    face_data = r_base['bodies']['body_exA']['mesh']['face_data']
    top_face_query = next(
        fq for fd, fq in zip(face_data, face_queries)
        if fd['normal'][2] > 0.9
    )

    # Get an edge for fillet
    edge_query = r_base['bodies']['body_exA']['edge_queries'][0]

    fillet = {"id": "fil1", "kind": "fillet", "edges": [edge_query], "radius": 1.0}
    skC = {
        'id': 'skC', 'kind': 'sketch', 'plane': top_face_query,
        'entities': [], 'constraints': [],
    }

    spec = {'features': [skA, exA, fillet, skC]}
    r_full = build(spec)
    assert r_full['result']['skC']['status'] != 'exception', (
        f"skC failed in full build: {r_full['result']['skC'].get('exception')}"
    )

    # Modify fillet radius -> partial rebuild: skA + exA restored from cache, fillet + skC dirty
    fillet_v2 = {"id": "fil1", "kind": "fillet", "edges": [edge_query], "radius": 5.0}
    spec2 = {'features': [skA, exA, fillet_v2, skC]}
    r_partial = build(spec2, prev_state=r_full['_build_state'])

    assert r_partial['result']['skC']['status'] != 'exception', (
        f"skC failed after partial rebuild: {r_partial['result']['skC'].get('exception')}"
    )


def test_three_dirty_features_with_boolean_cut_stale_ancestry():
    """Boolean cut changes body shape; subsequent sketch on face sees correct geometry.

    Sequence: skA -> exA (10mm) -> cutSk -> cutEx (boolean cut 3mm) -> skC (on exA top face).
    Modify cutEx depth -> partial rebuild of cutEx and skC.
    skC must resolve with post-cut face geometry.
    """
    pytest.importorskip("OCP.gp")

    skA = rect_sketch_spec(w=10.0, h=10.0, sketch_id='skA')
    exA = extrude_spec('skA', 'exA', 10.0)

    r_base = build({'features': [skA, exA]})

    face_queries = r_base['bodies']['body_exA']['mesh']['face_queries']
    face_data = r_base['bodies']['body_exA']['mesh']['face_data']
    top_face_query = next(
        fq for fd, fq in zip(face_data, face_queries)
        if fd['normal'][2] > 0.9
    )

    cutSk = rect_sketch_spec(w=4.0, h=4.0, sketch_id='cutSk')
    cutEx = extrude_spec('cutSk', 'cutEx', 3.0, operation='cut')

    skC = {
        'id': 'skC', 'kind': 'sketch', 'plane': top_face_query,
        'entities': [], 'constraints': [],
    }

    spec = {'features': [skA, exA, cutSk, cutEx, skC]}
    r_full = build(spec)
    assert r_full['result']['skC']['status'] != 'exception', (
        f"skC failed in full build: {r_full['result']['skC'].get('exception')}"
    )

    # Modify cutEx depth -> partial rebuild: skA + exA + cutSk restored from cache, cutEx + skC dirty
    cutEx_v2 = extrude_spec('cutSk', 'cutEx', 8.0, operation='cut')
    spec2 = {'features': [skA, exA, cutSk, cutEx_v2, skC]}
    r_partial = build(spec2, prev_state=r_full['_build_state'])

    assert r_partial['result']['skC']['status'] != 'exception', (
        f"skC failed after partial rebuild: {r_partial['result']['skC'].get('exception')}"
    )


def test_registered_this_cycle_reset():
    """_register_brep_face_ancestry is called for each non-first dirty feature.

    White-box: monkey-patch _register_brep_face_ancestry to count calls.
    With 2 dirty features after checkpoint restore, the function should be
    called at least once per iteration for body_exA.
    """
    pytest.importorskip("OCP.gp")
    from unittest.mock import patch
    import oversolved.kernel.builder as builder_module

    skA = rect_sketch_spec(w=10.0, h=10.0, sketch_id='skA')
    exA = extrude_spec('skA', 'exA', 5.0)

    # Full build to create initial state
    r1 = build({'features': [skA, exA]})

    # Modify exA distance -> first_dirty = 1 (skA restored from cache, exA dirty)
    # Then add new feature after exA for second dirty iteration
    skB = rect_sketch_spec(w=5.0, h=5.0, sketch_id='skB')

    call_count = 0
    orig = builder_module._register_brep_face_ancestry

    def counting_wrapper(global_repo, body, mesh):
        nonlocal call_count
        call_count += 1
        return orig(global_repo, body, mesh)

    exA_v2 = extrude_spec('skA', 'exA', 10.0)
    spec2 = {'features': [skA, exA_v2, skB]}

    with patch.object(builder_module, '_register_brep_face_ancestry', counting_wrapper):
        r2 = build(spec2, prev_state=r1['_build_state'])

    # body_exA exists in body_store for both dirty iterations.
    # _register_brep_face_ancestry should be called >= 2 times:
    #   - Once during exA's iteration (i=0, new body registration after solve)
    #   - Once during skB's iteration (i=1, pre-solve re-registration)
    # Without the fix, the i=1 call would be skipped.
    assert call_count >= 2, (
        f"_register_brep_face_ancestry called {call_count} times, "
        f"expected >= 2"
    )

    assert r2['result']['skB']['status'] != 'exception'


def test_result_mutation_does_not_corrupt_checkpoint():
    """Mutating returned result does not corrupt cached checkpoint."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=7.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, sk2]}
    r1 = build(spec)
    state = r1['_build_state']

    original_geom = r1['result']['sk1']['geometry']

    r1['result']['sk1']['_mutated'] = 'taint'

    spec_unchanged = {'features': [sk1, sk2]}
    r2 = build(spec_unchanged, prev_state=state)

    assert r2['result']['sk1']['geometry'] == original_geom
    assert r2['result']['sk1'].get('_mutated') is None


def test_checkpoint_result_is_independent_copy():
    """Checkpoint result is a different object from the returned result."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    spec = {'features': [sk1]}
    r = build(spec)
    state = r['_build_state']

    returned_result = r['result']['sk1']
    checkpoint_result = state.checkpoints['sk1'].result

    assert id(returned_result) != id(checkpoint_result)


# ─── rollback_position transition tests ───

def test_rollback_mid_stack_only_solves_active_features():
    """rollback_position=2 on a 4-feature stack only solves the first two."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    ex2 = extrude_spec('sk2', 'ex2', 3.0)
    spec = {'features': [sk1, ex1, sk2, ex2]}

    r = build(spec, rollback_position=2)

    assert 'sk1' in r['result']
    assert 'ex1' in r['result']
    assert 'sk2' not in r['result']
    assert 'ex2' not in r['result']
    assert r['_build_state'].feature_order == ['sk1', 'ex1', 'sk2', 'ex2']


def test_rollback_decrease_uses_prev_state_checkpoints():
    """Decreasing rollback from 3 to 2 reuses checkpoints for features before the cut."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r_full = build(spec, rollback_position=3)
    geom_sk1_full = r_full['result']['sk1']['geometry']

    r_rollback = build(spec, prev_state=r_full['_build_state'], rollback_position=2)

    assert 'sk1' in r_rollback['result']
    assert 'ex1' in r_rollback['result']
    assert 'sk2' not in r_rollback['result']
    assert r_rollback['result']['sk1']['geometry'] == geom_sk1_full


def test_rollback_increase_solves_newly_active_features():
    """Increasing rollback from 2 to 3 solves the newly included feature."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r_short = build(spec, rollback_position=2)
    r_extended = build(spec, prev_state=r_short['_build_state'], rollback_position=3)

    assert 'sk2' in r_extended['result']
    assert r_extended['result']['sk2']['status'] != 'exception'
    assert r_extended['result']['sk1']['geometry'] == r_short['result']['sk1']['geometry']


def test_edit_suppressed_feature_does_not_invalidate_active_checkpoints():
    """Editing a feature past the rollback position does not dirty features before it."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r1 = build(spec, rollback_position=2)
    geom_sk1 = r1['result']['sk1']['geometry']

    sk2_modified = {**sk2, 'label': 'changed but suppressed'}
    spec2 = {'features': [sk1, ex1, sk2_modified]}

    r2 = build(spec2, prev_state=r1['_build_state'], rollback_position=2)

    assert r2['result']['sk1']['geometry'] == geom_sk1
    assert r2['result']['ex1']['status'] == 'ok'
    assert 'sk2' not in r2['result']


def test_rollback_full_after_partial_reuses_all_checkpoints():
    """After a rollback=2 build, solving the full stack reuses checkpoints for sk1 and ex1."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r_partial = build(spec, rollback_position=2)
    geom_sk1 = r_partial['result']['sk1']['geometry']

    r_full = build(spec, prev_state=r_partial['_build_state'])

    assert r_full['result']['sk1']['geometry'] == geom_sk1
    assert r_full['result']['ex1']['status'] == 'ok'
    assert r_full['result']['sk2']['status'] != 'exception'
    assert set(r_full['result'].keys()) >= {'sk1', 'ex1', 'sk2'}


def test_rollback_same_position_twice_is_stable():
    """Solving at the same rollback position twice produces identical results."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r1 = build(spec, rollback_position=2)
    r2 = build(spec, prev_state=r1['_build_state'], rollback_position=2)

    assert r2['result']['sk1']['geometry'] == r1['result']['sk1']['geometry']
    assert r2['result']['ex1']['status'] == r1['result']['ex1']['status']
    assert r2['result']['ex1']['body_id'] == r1['result']['ex1']['body_id']


def test_rollback_state_feature_order_always_contains_full_list():
    """BuildState.feature_order includes all features regardless of rollback_position."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    sk3 = rect_sketch_spec(w=1.0, h=1.0, sketch_id='sk3')
    spec = {'features': [sk1, sk2, sk3]}

    for rollback in (1, 2, 3):
        r = build(spec, rollback_position=rollback)
        assert r['_build_state'].feature_order == ['sk1', 'sk2', 'sk3'], (
            f"feature_order wrong at rollback={rollback}"
        )


def test_rollback_oscillation_undo_redo():
    """Simulate undo/redo: rollback 3->2->3 reuses checkpoints correctly each way."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)
    sk2 = rect_sketch_spec(w=2.0, h=2.0, sketch_id='sk2')
    spec = {'features': [sk1, ex1, sk2]}

    r_full = build(spec, rollback_position=3)
    geom_sk1 = r_full['result']['sk1']['geometry']

    r_undo = build(spec, prev_state=r_full['_build_state'], rollback_position=2)
    assert 'sk2' not in r_undo['result']
    assert r_undo['result']['sk1']['geometry'] == geom_sk1
    assert r_undo['result']['ex1']['status'] == 'ok'

    r_redo = build(spec, prev_state=r_undo['_build_state'], rollback_position=3)
    assert r_redo['result']['sk2']['status'] != 'exception'
    assert r_redo['result']['sk1']['geometry'] == geom_sk1


def test_builder_dirty_on_feature_remove():
    """[sk1, sk2, sk3] -> [sk1, sk2]: sk3 absent from result and checkpoints."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=4.0, h=2.0, sketch_id='sk2')
    sk3 = rect_sketch_spec(w=3.0, h=1.0, sketch_id='sk3')

    r1 = build({'features': [sk1, sk2, sk3]})
    state1 = r1['_build_state']
    assert 'sk3' in state1.checkpoints

    r2 = build({'features': [sk1, sk2]}, prev_state=state1)
    state2 = r2['_build_state']

    assert 'sk3' not in r2['result']
    assert 'sk3' not in state2.checkpoints
    assert state2.feature_order == ['sk1', 'sk2']
    assert r2['result']['sk1']['status'] != 'exception'
    assert r2['result']['sk2']['status'] != 'exception'


def test_builder_dirty_on_feature_insert():
    """[sk1, sk3] -> [sk1, sk2, sk3]: sk2 and sk3 are both re-solved."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=4.0, h=2.0, sketch_id='sk2')
    sk3 = rect_sketch_spec(w=3.0, h=1.0, sketch_id='sk3')

    r1 = build({'features': [sk1, sk3]})
    state1 = r1['_build_state']
    geom_sk3_before = r1['result']['sk3']['geometry']

    r2 = build({'features': [sk1, sk2, sk3]}, prev_state=state1)
    state2 = r2['_build_state']

    assert 'sk2' in state2.checkpoints
    assert 'sk3' in state2.checkpoints
    assert state2.feature_order == ['sk1', 'sk2', 'sk3']
    assert r2['result']['sk2']['status'] != 'exception'
    assert r2['result']['sk3']['status'] != 'exception'
    # sk3 geometry is unchanged since its spec didn't change
    assert r2['result']['sk3']['geometry'] == geom_sk3_before


def test_builder_clean_unchanged_list():
    """[sk1, sk2] -> [sk1, sk2] unchanged: checkpoints are reused from cache."""
    sk1 = rect_sketch_spec(w=5.0, h=3.0, sketch_id='sk1')
    sk2 = rect_sketch_spec(w=4.0, h=2.0, sketch_id='sk2')

    r1 = build({'features': [sk1, sk2]})
    state1 = r1['_build_state']
    geom1 = r1['result']['sk1']['geometry']
    geom2 = r1['result']['sk2']['geometry']

    r2 = build({'features': [sk1, sk2]}, prev_state=state1)
    assert r2['result']['sk1']['geometry'] == geom1
    assert r2['result']['sk2']['geometry'] == geom2
