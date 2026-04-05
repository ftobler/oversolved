"""Test that builtin planes are included in solve results."""
from oversolved.solver import solve


def test_builtin_planes_in_solve_results():
    """Builtin planes should be available in solve() results for frontend access."""
    yaml_str = """
version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
"""
    result = solve(yaml_str)['result']

    # Verify all three builtin planes are in results
    assert 'builtin_plane_front' in result
    assert 'builtin_plane_top' in result
    assert 'builtin_plane_right' in result

    # Verify each has the correct structure
    for plane_id in ['builtin_plane_front', 'builtin_plane_top', 'builtin_plane_right']:
        plane_result = result[plane_id]
        assert plane_result['status'] == 'ok'
        assert 'plane' in plane_result
        plane = plane_result['plane']
        assert 'origin' in plane
        assert 'x_axis' in plane
        assert 'y_axis' in plane
        assert 'normal' in plane
        assert len(plane['origin']) == 3
        assert len(plane['x_axis']) == 3
        assert len(plane['y_axis']) == 3
        assert len(plane['normal']) == 3


def test_builtin_plane_front_coordinates():
    """Front plane should have correct 3D coordinates."""
    yaml_str = """
version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
"""
    result = solve(yaml_str)['result']
    plane = result['builtin_plane_front']['plane']

    # Front plane: normal [0,0,1], origin [0,0,0], x=[1,0,0], y=[0,1,0]
    assert plane['normal'] == [0, 0, 1]
    assert plane['origin'] == [0, 0, 0]
    assert plane['x_axis'] == [1, 0, 0]
    assert plane['y_axis'] == [0, 1, 0]


def test_builtin_plane_top_coordinates():
    """Top plane should have correct 3D coordinates."""
    yaml_str = """
version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
"""
    result = solve(yaml_str)['result']
    plane = result['builtin_plane_top']['plane']

    # Top plane: normal [0,1,0], origin [0,0,0], x=[1,0,0], y=[0,0,-1]
    assert plane['normal'] == [0, 1, 0]
    assert plane['origin'] == [0, 0, 0]
    assert plane['x_axis'] == [1, 0, 0]
    assert plane['y_axis'] == [0, 0, -1]


def test_builtin_plane_right_coordinates():
    """Right plane should have correct 3D coordinates."""
    yaml_str = """
version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
"""
    result = solve(yaml_str)['result']
    plane = result['builtin_plane_right']['plane']

    # Right plane: normal [1,0,0], origin [0,0,0], x=[0,0,-1], y=[0,1,0]
    assert plane['normal'] == [1, 0, 0]
    assert plane['origin'] == [0, 0, 0]
    assert plane['x_axis'] == [0, 0, -1]
    assert plane['y_axis'] == [0, 1, 0]


def test_builtin_planes_coexist_with_user_features():
    """Builtin planes should be in results alongside user-created features."""
    yaml_str = """
version: 1
kind: part
features:
  - id: Origin
    kind: origin
  - id: Top
    kind: plane
  - id: Front
    kind: plane
  - id: Right
    kind: plane
  - id: my_sketch
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [1, 2]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c
        kind: fixed
        target: "$ptxy"
        x: 1
        y: 2
"""
    result = solve(yaml_str)['result']

    # Both user feature and builtin planes should be present
    assert 'my_sketch' in result
    assert 'builtin_plane_front' in result
    assert 'builtin_plane_top' in result
    assert 'builtin_plane_right' in result

    # User feature should have expected structure
    assert 'geometry' in result['my_sketch']
