import numpy as np
from oversolved.solver import solve_features

# ── Projected entity tests ──


def test_project_line_front_to_front():
    """Project a line from sketch0 (front) to sketch1 (front). Coords unchanged."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {'line1': [1.0, 2.0, 3.0, 4.0]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pl1', 'kind': 'projected_line', 'source': '@sketch0/line1'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][1]['geometry']

    assert 'pl1' in geometry
    pl1 = geometry['pl1']
    np.testing.assert_array_almost_equal(pl1['start'], [1, 2], decimal=5)
    np.testing.assert_array_almost_equal(pl1['end'], [3, 4], decimal=5)
    assert pl1.get('projected') is True


def test_project_point_front_to_front():
    """Project a point from sketch0 (front) to sketch1 (front)."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                ],
                'initial': {'p1': [2.5, 3.5]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pp1', 'kind': 'projected_point', 'source': '@sketch0/p1/xy'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][1]['geometry']

    assert 'pp1' in geometry
    pp1 = geometry['pp1']
    np.testing.assert_array_almost_equal(pp1['xy'], [2.5, 3.5], decimal=5)
    assert pp1.get('projected') is True


def test_project_line_front_to_top():
    """Project a line from front (XY) to top (XZ). Points on X axis stay on X axis."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {'line1': [1.0, 0.0, 3.0, 0.0]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_top',
                'entities': [
                    {'id': 'pl1', 'kind': 'projected_line', 'source': '@sketch0/line1'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][1]['geometry']
    pl1 = geometry['pl1']
    # Points at [1,0,0] and [3,0,0] in world, projected to top (x=[1,0,0], y=[0,0,-1])
    # x_2d = dot([1,0,0], [1,0,0]) = 1, y_2d = dot([1,0,0], [0,0,-1]) = 0
    np.testing.assert_array_almost_equal(pl1['start'], [1, 0], decimal=5)
    np.testing.assert_array_almost_equal(pl1['end'], [3, 0], decimal=5)


def test_project_line_front_to_rotated_plane():
    """Project line to a rotated custom plane."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                    {'id': 'p2', 'kind': 'point'},
                    {'id': 'p3', 'kind': 'point'},
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [0.0, 1.0],
                    'line1': [1.0, 0.0, 2.0, 0.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                },
                'rotation': 90.0,
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '$plane1',
                'entities': [
                    {'id': 'pl1', 'kind': 'projected_line', 'source': '@sketch0/line1'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][2]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][2]['geometry']
    assert 'pl1' in geometry
    assert geometry['pl1'].get('projected') is True


def test_project_circle_onto_plane():
    """Project a circle to another plane - center and radius preserved."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'circle1', 'kind': 'circle'},
                ],
                'initial': {'circle1': [2.0, 3.0, 1.5]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pc1', 'kind': 'projected_circle', 'source': '@sketch0/circle1'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][1]['geometry']

    pc1 = geometry['pc1']
    np.testing.assert_array_almost_equal(pc1['center'], [2, 3], decimal=5)
    np.testing.assert_almost_equal(pc1['radius'], 1.5, decimal=5)
    assert pc1.get('projected') is True


def test_project_arc_onto_plane():
    """Project an arc to another plane - center, radius, angles preserved."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'arc1', 'kind': 'arc'},
                ],
                'initial': {'arc1': [0.0, 0.0, 1.0, 0.0, 90.0]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pa1', 'kind': 'projected_arc', 'source': '@sketch0/arc1'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][1]['geometry']

    pa1 = geometry['pa1']
    np.testing.assert_array_almost_equal(pa1['center'], [0, 0], decimal=5)
    np.testing.assert_almost_equal(pa1['radius'], 1.0, decimal=5)
    assert pa1.get('projected') is True


def test_projected_entity_is_fixed():
    """Adding a conflicting fixed constraint on a projected point causes overconstrained."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                ],
                'initial': {'p1': [1.0, 1.0]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pp1', 'kind': 'projected_point', 'source': '@sketch0/p1/xy'},
                ],
                'initial': {},
                'constraints': [
                    # Conflicting: projected entity already pinned at [1,1], this tries [2,2]
                    {
                        'id': 'extra_fix',
                        'kind': 'fixed',
                        'target': {'entity': 'pp1', 'point': 'xy'},
                        'x': 2.0,
                        'y': 2.0,
                    },
                ],
            },
        ]
    }
    result = solve_features(spec)

    # The projected entity is pinned at [1,1] and an extra fixed at [2,2] is overconstrained
    assert result['features'][1]['status'] == 'overconstrained'


def test_projected_entity_as_constraint_target():
    """A non-projected line can be coincident with a projected point."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                ],
                'initial': {'p1': [2.0, 3.0]},
                'constraints': [],
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pp1', 'kind': 'projected_point', 'source': '@sketch0/p1/xy'},
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {'line1': [0.0, 0.0, 1.0, 1.0]},
                'constraints': [
                    {
                        'id': 'c1',
                        'kind': 'coincident',
                        'a': {'entity': 'line1', 'point': 'start'},
                        'b': {'entity': 'pp1', 'point': 'xy'},
                    },
                ],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    geometry = result['features'][1]['geometry']

    # pp1 should stay at [2, 3]
    np.testing.assert_array_almost_equal(geometry['pp1']['xy'], [2, 3], decimal=5)
    # line1 start should have moved to [2, 3]
    np.testing.assert_array_almost_equal(geometry['line1']['start'], [2, 3], decimal=4)


def test_projection_failure_logged(caplog):
    """An unresolvable source query causes projection failure but should not crash."""
    import logging
    caplog.set_level(logging.WARNING)
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pl1', 'kind': 'projected_line', 'source': '@nonexistent/line1'},
                ],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)
    assert result['features'][0]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert "Projection failed" in caplog.text
