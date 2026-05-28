"""Tests for solver_render helpers."""

import math

from oversolved.kernel.solver_render import _geom_point, _constraint_render


def _arc_entity():
    return {
        "start": [1.0, 0.0],
        "end": [0.0, 1.0],
        "center": [0.0, 0.0],
        "radius": 1.0,
    }


def test_geom_point_arc_start():
    """Arc entity with pt='start' should return start point."""
    geom = {"a": _arc_entity()}
    assert _geom_point(geom, {"entity": "a", "point": "start"}) == [1.0, 0.0]


def test_geom_point_arc_end():
    """Arc entity with pt='end' should return end point."""
    geom = {"a": _arc_entity()}
    assert _geom_point(geom, {"entity": "a", "point": "end"}) == [0.0, 1.0]


def test_geom_point_arc_center():
    """Arc entity with pt='center' should return center, not start."""
    geom = {"a": _arc_entity()}
    result = _geom_point(geom, {"entity": "a", "point": "center"})
    assert result == [0.0, 0.0]


def test_geom_point_arc_default():
    """Arc entity with no point key should default to start."""
    geom = {"a": _arc_entity()}
    assert _geom_point(geom, {"entity": "a"}) == [1.0, 0.0]


def test_geom_point_line_start():
    """Line entity with pt='start' should return start."""
    geom = {"l": {"start": [0.0, 0.0], "end": [2.0, 3.0]}}
    assert _geom_point(geom, {"entity": "l", "point": "start"}) == [0.0, 0.0]


def test_geom_point_line_end():
    """Line entity with pt='end' should return end."""
    geom = {"l": {"start": [0.0, 0.0], "end": [2.0, 3.0]}}
    assert _geom_point(geom, {"entity": "l", "point": "end"}) == [2.0, 3.0]


def test_geom_point_circle():
    """Circle entity should return center."""
    geom = {"c": {"center": [3.0, 4.0], "radius": 5.0}}
    assert _geom_point(geom, {"entity": "c"}) == [3.0, 4.0]


def test_geom_point_point_entity():
    """Point entity should return [x, y]."""
    geom = {"p": {"x": 7.0, "y": 8.0}}
    assert _geom_point(geom, {"entity": "p"}) == [7.0, 8.0]


def test_geom_point_external_xy():
    """external_xy ref should return the coordinate directly."""
    geom = {}
    assert _geom_point(geom, {"external_xy": [5.0, 6.0]}) == [5.0, 6.0]


# ─── _constraint_render tests ───

def _line_geom():
    return {
        "L1": {"start": [0.0, 0.0], "end": [10.0, 0.0]},
        "L2": {"start": [0.0, 5.0], "end": [10.0, 5.0]},
        "L3": {"start": [0.0, 0.0], "end": [0.0, 8.0]},
    }


def test_line_distance_normal_is_along_line_direction():
    """line_distance normal must be along the reference line, matching the
    frontend convention so the stored pos lands at the correct offset."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},
        "value": 5.0,
    }
    r = _constraint_render(c, geom)
    assert r["kind"] == "dim_linear"
    nx, ny = r["normal"]
    assert nx == 1.0  # unit vector along L1: (10/10, 0/10) = (1, 0)
    assert ny == 0.0


def test_line_distance_propagates_pos():
    """pos on the constraint must be forwarded to the render so the label
    appears where the user clicked, not at the default midpoint."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},
        "value": 5.0,
        "pos": [2.0, -1.5],
    }
    r = _constraint_render(c, geom)
    assert r["pos"] == [2.0, -1.5]


def test_line_distance_geometry_parallel_lines():
    """Two parallel horizontal lines 5 units apart."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},
        "value": 5.0,
    }
    r = _constraint_render(c, geom)
    p1 = r["p1"]  # foot of L2.start onto L1
    p2 = r["p2"]  # L2.start
    assert p1 == [0.0, 0.0]
    assert p2 == [0.0, 5.0]
    d = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    assert abs(d - 5.0) < 1e-10


def test_line_distance_perpendicular_offset():
    """Point whose perpendicular foot lands between L1 endpoints."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L3"},  # vertical line through (0,0)
        "value": 0.0,
    }
    r = _constraint_render(c, geom)
    p1 = r["p1"]  # foot of L3.start (0,0) onto L1: (0,0) already on L1
    assert p1 == [0.0, 0.0]
    p2 = r["p2"]  # L3.start = (0,0)
    assert p2 == [0.0, 0.0]


def test_length_propagates_pos():
    geom = {"L1": {"start": [0.0, 0.0], "end": [10.0, 0.0]}}
    c = {
        "id": "d1",
        "kind": "length",
        "target": {"entity": "L1"},
        "value": 10.0,
        "pos": [0.0, 5.0],
    }
    r = _constraint_render(c, geom)
    assert r["pos"] == [0.0, 5.0]


def test_radius_propagates_pos():
    geom = {"C1": {"center": [0.0, 0.0], "radius": 5.0}}
    c = {
        "id": "d1",
        "kind": "radius",
        "target": {"entity": "C1"},
        "value": 5.0,
        "pos": [1.0, 2.0],
    }
    r = _constraint_render(c, geom)
    assert r["pos"] == [1.0, 2.0]


def test_diameter_propagates_pos():
    geom = {"C1": {"center": [0.0, 0.0], "radius": 5.0}}
    c = {
        "id": "d1",
        "kind": "diameter",
        "target": {"entity": "C1"},
        "value": 10.0,
        "pos": [0.0, -3.0],
    }
    r = _constraint_render(c, geom)
    assert r["pos"] == [0.0, -3.0]


def test_angle_propagates_pos():
    geom = {
        "L1": {"start": [0.0, 0.0], "end": [10.0, 0.0]},
        "L2": {"start": [0.0, 0.0], "end": [0.0, 5.0]},
    }
    c = {
        "id": "d1",
        "kind": "angle",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},
        "value": 90.0,
        "pos": [1.0, 1.0],
    }
    r = _constraint_render(c, geom)
    assert r["pos"] == [1.0, 1.0]


def test_point_distance_propagates_pos():
    geom = {
        "P1": {"x": 0.0, "y": 0.0},
        "P2": {"x": 3.0, "y": 4.0},
    }
    c = {
        "id": "d1",
        "kind": "point_distance",
        "a": {"entity": "P1"},
        "b": {"entity": "P2"},
        "value": 5.0,
        "pos": [1.5, 2.0],
    }
    r = _constraint_render(c, geom)
    assert r["pos"] == [1.5, 2.0]


def test_line_distance_no_pos():
    """pos is optional and must be absent from render when not on constraint."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},
        "value": 5.0,
    }
    r = _constraint_render(c, geom)
    assert "pos" not in r


def test_line_distance_ext1_line_is_ref_entity_segment():
    """ext1_line must hold the reference line's start-end bounding box
    so the renderer can evaluate whether the extension line is needed."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},
        "value": 5.0,
    }
    r = _constraint_render(c, geom)
    assert r["ext1_line"] == [0.0, 0.0, 10.0, 0.0]


def test_line_distance_ext2_line_for_line_target():
    """When the target entity is a line, ext2_line holds its segment bounds."""
    geom = _line_geom()
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "L2"},  # L2 is a line
        "value": 5.0,
    }
    r = _constraint_render(c, geom)
    assert r["ext2_line"] == [0.0, 5.0, 10.0, 5.0]


def test_line_distance_ext2_line_absent_for_point_target():
    """When the target entity is a point, ext2_line must be absent."""
    geom = {
        "L1": {"start": [0.0, 0.0], "end": [10.0, 0.0]},
        "P1": {"x": 5.0, "y": 3.0},
    }
    c = {
        "id": "d1",
        "kind": "line_distance",
        "a": {"entity": "L1"},
        "b": {"entity": "P1"},  # P1 is a point
        "value": 3.0,
    }
    r = _constraint_render(c, geom)
    assert "ext2_line" not in r
