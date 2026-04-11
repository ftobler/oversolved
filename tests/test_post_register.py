import pytest
from oversolved.solver import _post_register, _init_global_repo


def test_post_register_geometry_goes_into_repo():
    repo = _init_global_repo()
    feature = {'id': 'sk1', 'kind': 'sketch', 'plane': '@builtin_plane_front', 'entities': []}
    feature_result = {
        'status': 'ok',
        'geometry': {'line1': [0.0, 0.0, 1.0, 0.0]},
        'plane_transform': {'rotation': [1, 0, 0, 0, 1, 0, 0, 0, 1], 'origin': [0, 0, 0]},
        'topology': {'surfaces': []},
    }
    _post_register(repo, 'sk1', feature, feature_result)
    assert '_pt_sk1' in repo.elements
    pt = repo.elements['_pt_sk1']
    assert 'rotation' in pt or 'normal' in pt


def test_post_register_plane_result():
    repo = _init_global_repo()
    feature = {'id': 'pl1', 'kind': 'plane'}
    feature_result = {
        'status': 'ok',
        'plane': {'origin': [0, 0, 5], 'x_axis': [1, 0, 0], 'y_axis': [0, 1, 0], 'normal': [0, 0, 1]},
        'plane_transform': {'rotation': [1, 0, 0, 0, 1, 0, 0, 0, 1], 'origin': [0, 0, 5]},
    }
    _post_register(repo, 'pl1', feature, feature_result)
    assert '_pt_pl1' in repo.elements
    pt = repo.elements['_pt_pl1']
    assert pt.get('origin', [None, None, None])[2] == pytest.approx(5.0)


def test_post_register_topology_result():
    repo = _init_global_repo()
    feature = {'id': 'sk1', 'kind': 'sketch', 'entities': []}
    surfaces = [{'boundary': [{'start': [0, 0], 'end': [1, 0]}]}]
    feature_result = {
        'status': 'ok',
        'geometry': {},
        'plane_transform': {'rotation': [1, 0, 0, 0, 1, 0, 0, 0, 1], 'origin': [0, 0, 0]},
        'topology': {'surfaces': surfaces},
    }
    _post_register(repo, 'sk1', feature, feature_result)
    assert '_topo_sk1' in repo.elements


def test_post_register_exception_result_is_no_op():
    """Failed feature results must not pollute global_repo."""
    repo = _init_global_repo()
    before = set(repo.elements.keys())
    feature = {'id': 'sk1', 'kind': 'sketch', 'entities': []}
    feature_result = {'status': 'exception', 'exception': 'something broke'}
    _post_register(repo, 'sk1', feature, feature_result)
    after = set(repo.elements.keys())
    assert before == after, "exception result must not add keys to repo"
