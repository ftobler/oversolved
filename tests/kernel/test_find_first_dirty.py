from oversolved.kernel.builder import _find_first_dirty, _normalize_spec, BuildState, FeatureCheckpoint


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
    old = [{'id': 'a', 'kind': 'sketch', 'label': 'v1'}, {'id': 'b', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'sketch', 'label': 'v2'}, {'id': 'b', 'kind': 'sketch'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0


def test_second_feature_changed_returns_one():
    old = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch', 'label': 'v1'}]
    new = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch', 'label': 'v2'}]
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
    old = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'extrude'}, {'id': 'b', 'kind': 'extrude'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0


def test_feature_inserted_in_middle_returns_index_one():
    old = [{'id': 'sk1'}, {'id': 'sk2'}, {'id': 'sk3'}]
    new = [{'id': 'sk1'}, {'id': 'new'}, {'id': 'sk2'}, {'id': 'sk3'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_feature_deleted_from_middle():
    old = [{'id': 'sk1'}, {'id': 'sk2'}, {'id': 'sk3'}]
    new = [{'id': 'sk1'}, {'id': 'sk3'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_spec_change_via_key_addition():
    old = [{'id': 'a'}]
    new = [{'id': 'a', 'extra': 'val'}]  # 'extra' is not a canonical key
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1  # non-canonical key addition is not dirty


def test_extra_ui_key_not_dirty():
    features = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    state = make_state(features)
    new = [{'id': 'a', 'kind': 'sketch', '_ui_temp': 'selected'}, {'id': 'b', 'kind': 'sketch'}]
    assert _find_first_dirty(new, state) == 2


def test_canonical_key_change_still_dirty():
    old = [{'id': 'a', 'kind': 'sketch'}, {'id': 'b', 'kind': 'sketch'}]
    new = [{'id': 'a', 'kind': 'extrude'}, {'id': 'b', 'kind': 'sketch'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0


def test_unknown_key_on_both_sides_not_dirty():
    old = [{'id': 'a', 'kind': 'sketch', '_extra': 'x'}]
    new = [{'id': 'a', 'kind': 'sketch', '_extra': 'x'}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1


def test_unknown_key_value_change_not_dirty():
    old = [{'id': 'a', 'kind': 'sketch', '_extra': 'x'}]
    new = [{'id': 'a', 'kind': 'sketch', '_extra': 'y'}]  # unknown key value changed
    state = make_state(old)
    assert _find_first_dirty(new, state) == 1  # unknown keys are ignored entirely


def test_normalize_spec_strips_unknown_keys():
    result = _normalize_spec({'id': 'a', 'kind': 'sketch', '_extra': 'x'})
    assert '_extra' not in result
    assert result['id'] == 'a'
    assert result['kind'] == 'sketch'


def test_nested_field_change_detected():
    old = [{'id': 'a', 'kind': 'sketch', 'entities': [{'id': 'line1', 'kind': 'line'}]}]
    new = [{'id': 'a', 'kind': 'sketch', 'entities': [{'id': 'line1', 'kind': 'circle'}]}]
    state = make_state(old)
    assert _find_first_dirty(new, state) == 0
