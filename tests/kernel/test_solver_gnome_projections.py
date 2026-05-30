import numpy as np
from oversolved.kernel.solver import solve_features

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


# ── Body geometry projection (face / edge / vertex via ancestry queries) ──


def test_resolve_source_geometry_face():
    """_resolve_source_geometry resolves a face ancestry query to 3D centroid."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_plane import _resolve_source_geometry

    repo = Repository()
    face_key = make_ancestry_query(["@body_1", "@feat_A"], "flatface")
    repo.register_ancestor(["@body_1", "@feat_A"], {
        "type": "flatface",
        "centroid": [10.0, 20.0, 30.0],
        "origin": [10.0, 20.0, 30.0],
        "normal": [0.0, 0.0, 1.0],
    })
    kind, data = _resolve_source_geometry(face_key, repo)
    assert kind == "point"
    assert data == [10.0, 20.0, 30.0]


def test_resolve_source_geometry_face_origin_fallback():
    """When centroid is absent, origin is used as fallback for face centroid."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_plane import _resolve_source_geometry

    repo = Repository()
    face_key = make_ancestry_query(["@body_1", "@feat_A"], "flatface")
    repo.register_ancestor(["@body_1", "@feat_A"], {
        "type": "flatface",
        "origin": [5.0, 6.0, 7.0],
        "normal": [0.0, 0.0, 1.0],
    })
    kind, data = _resolve_source_geometry(face_key, repo)
    assert kind == "point"
    assert data == [5.0, 6.0, 7.0]


def test_resolve_source_geometry_edge():
    """_resolve_source_geometry resolves an edge ancestry query to 3D line."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_plane import _resolve_source_geometry

    repo = Repository()
    edge_key = make_ancestry_query(["@body_1", "@feat_A"], "straightedge")
    repo.register_ancestor(["@body_1", "@feat_A"], {
        "type": "straightedge",
        "start": [0.0, 0.0, 0.0],
        "end": [3.0, 4.0, 0.0],
    })
    kind, data = _resolve_source_geometry(edge_key, repo)
    assert kind == "line"
    assert data["start"] == [0.0, 0.0, 0.0]
    assert data["end"] == [3.0, 4.0, 0.0]


def test_resolve_source_geometry_curved_edge_raises_clear_error():
    """A curved edge has no straight endpoints; resolving must fail cleanly,
    not crash with 'NoneType - float' when the None coords reach the projection."""
    import pytest
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_plane import _resolve_source_geometry

    repo = Repository()
    edge_key = make_ancestry_query(["@body_1", "@feat_A"], "edge")
    # Curved edge: circle/arc/spline carry no start/end in the ancestry payload.
    repo.register_ancestor(["@body_1", "@feat_A"], {
        "type": "edge",
        "kind": "circle",
        "start": None,
        "end": None,
    })
    with pytest.raises(ValueError, match="no straight"):
        _resolve_source_geometry(edge_key, repo)


def test_resolve_source_geometry_vertex():
    """_resolve_source_geometry resolves a vertex ancestry query to 3D point."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_plane import _resolve_source_geometry

    repo = Repository()
    vertex_key = make_ancestry_query(["@body_1", "_v0", "vertex"], "vertex")
    repo.register_ancestor(["@body_1", "_v0", "vertex"], {
        "type": "vertex",
        "x": 7.0,
        "y": 8.0,
        "z": 9.0,
    })
    kind, data = _resolve_source_geometry(vertex_key, repo)
    assert kind == "point"
    assert data == [7.0, 8.0, 9.0]


def test_project_body_edge_onto_sketch():
    """Project a 3D body edge onto a sketch plane via ancestry query source."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_constants import _FRONT_PLANE
    from oversolved.kernel.solver_plane import _project_source_to_params

    repo = Repository()
    edge_key = make_ancestry_query(["@body_1", "@feat_ext"], "straightedge")
    repo.register_ancestor(["@body_1", "@feat_ext"], {
        "type": "straightedge",
        "start": [1.0, 2.0, 0.0],
        "end": [4.0, 5.0, 0.0],
    })
    params = _project_source_to_params(
        "projected_line", edge_key, _FRONT_PLANE, repo,
    )
    assert len(params) == 4
    # On the front plane (z=0), 2D equals the XY components.
    assert params[0:2] == [1.0, 2.0]
    assert params[2:4] == [4.0, 5.0]


def test_project_body_face_centroid_onto_sketch():
    """Project a 3D body face centroid onto a sketch plane."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_constants import _FRONT_PLANE
    from oversolved.kernel.solver_plane import _project_source_to_params

    repo = Repository()
    face_key = make_ancestry_query(["@body_1", "@feat_ext"], "flatface")
    repo.register_ancestor(["@body_1", "@feat_ext"], {
        "type": "flatface",
        "centroid": [2.5, 3.5, 0.0],
        "origin": [2.5, 3.5, 0.0],
        "normal": [0.0, 0.0, 1.0],
    })
    params = _project_source_to_params(
        "projected_point", face_key, _FRONT_PLANE, repo,
    )
    assert len(params) == 2
    assert params == [2.5, 3.5]


def test_project_body_vertex_onto_sketch():
    """Project a 3D body vertex onto a sketch plane."""
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_constants import _FRONT_PLANE
    from oversolved.kernel.solver_plane import _project_source_to_params

    repo = Repository()
    vertex_key = make_ancestry_query(["@body_1", "v0", "vertex"], "vertex")
    repo.register_ancestor(["@body_1", "v0", "vertex"], {
        "type": "vertex",
        "x": 9.0,
        "y": 7.0,
        "z": 0.0,
    })
    params = _project_source_to_params(
        "projected_point", vertex_key, _FRONT_PLANE, repo,
    )
    assert len(params) == 2
    assert params == [9.0, 7.0]


def test_project_cross_plane_with_body_repo():
    """Project a line across planes using a Repository pre-populated with body-like geometry.

    The projection resolver uses _resolve_source_geometry to turn a query into 3D
    coords, then _project_source_to_params to project onto the target plane.
    Face/edge/vertex types carry 3D world coords directly (no source-plane transform).
    """
    from oversolved.kernel.query import Repository, make_ancestry_query
    from oversolved.kernel.solver_constants import _FRONT_PLANE, _BUILTIN_PLANES
    from oversolved.kernel.solver_plane import _project_source_to_params

    repo = Repository()
    top_plane = _BUILTIN_PLANES["builtin_plane_top"]

    edge_key = make_ancestry_query(["@body_1", "@feat_ext"], "straightedge")
    repo.register_ancestor(["@body_1", "@feat_ext"], {
        "type": "straightedge",
        # Edge on front plane in world space: from (1,0,0) to (3,0,0)
        "start": [1.0, 0.0, 0.0],
        "end": [3.0, 0.0, 0.0],
    })
    params = _project_source_to_params(
        "projected_line", edge_key, top_plane, repo,
    )
    # Projected to top plane (XZ): world X → sketch X, world Z → sketch Y
    # start=(1,0,0) → (1, 0), end=(3,0,0) → (3, 0)
    assert params[0:2] == [1.0, 0.0]
    assert params[2:4] == [3.0, 0.0]
