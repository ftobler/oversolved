from oversolved.builder import _find_first_dirty, BuildState, FeatureCheckpoint


def make_state(feature_specs: list[dict]) -> BuildState:
    """Build a BuildState from a list of feature dicts (no real repo/body data)."""
    checkpoints = {}
    for f in feature_specs:
        fid = f['id']
        checkpoints[fid] = FeatureCheckpoint(
            spec=f,
            result={'status': 'ok'},
            repo_snapshot={},
            body_store_snapshot={},
        )
    return BuildState(
        feature_order=[f['id'] for f in feature_specs],
        checkpoints=checkpoints,
    )


def test_no_prev_state_returns_zero():
    features = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    assert _find_first_dirty(features, None) == 0


def test_identical_spec_returns_len():
    features = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    state = make_state(features)
    assert _find_first_dirty(features, state) == 2


def test_first_feature_changed_returns_zero():
    old = [{'id': 'a', 'kind': 'sketch', 'x': 1}, {'id': 'b', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'sketch', 'x': 2}, {'id': 'b', 'kind': 'sketch'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0


def test_second_feature_changed_returns_one():
    old = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch', 'x': 1}]
    new = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch', 'x': 2}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_feature_added_at_end_returns_old_len():
    old = [{'id': 'a', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_feature_removed_from_end():
    old = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'sketch'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_feature_id_changed_at_position_one():
    old = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}, {'id': 'c', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'sketch'}, {'id': 'X', 'kind': 'sketch'}, {'id': 'c', 'kind': 'sketch'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_empty_features_with_prev_state_returns_zero():
    state = make_state([{'id': 'a', 'kind': 'sketch'}])
    assert _find_first_dirty([], state) == 0


def test_empty_features_no_prev_state_returns_zero():
    assert _find_first_dirty([], None) == 0


def test_all_features_changed():
    old = [{'id': 'a', 'x': 1}, {'id': 'b', 'x': 1}]
    new = [{'id': 'a', 'x': 2}, {'id': 'b', 'x': 2}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0


def test_nested_field_change_detected():
    old = [{'id': 'a', 'kind': 'sketch', 'entities': [{'id': 'line1', 'kind': 'line'}]}]
    new = [{'id': 'a', 'kind': 'sketch', 'entities': [{'id': 'line1', 'kind': 'circle'}]}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0
