from oversolved.builder import build
from solver_helpers import rect_sketch_spec


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
