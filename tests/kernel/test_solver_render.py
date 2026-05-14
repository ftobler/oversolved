"""Tests for solver_render helpers."""

from oversolved.kernel.solver_render import _geom_point


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
