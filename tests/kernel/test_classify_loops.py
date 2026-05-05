"""Tests for the pure-Python classify_loops function in geometry.py.

classify_loops groups a flat list of loops into (outer, [holes]) pairs so that
disjoint closed areas each become their own face, and nested loops become holes.
These tests run without OCC/cadquery.
"""
from oversolved.kernel.profile_loops import classify_loops


def _rect_loop(x0: float, y0: float, x1: float, y1: float) -> list[dict]:
    """Build a CCW rectangle loop as a list of edge dicts."""
    return [
        {"kind": "line", "start": [x0, y0], "end": [x1, y0]},
        {"kind": "line", "start": [x1, y0], "end": [x1, y1]},
        {"kind": "line", "start": [x1, y1], "end": [x0, y1]},
        {"kind": "line", "start": [x0, y1], "end": [x0, y0]},
    ]


def test_single_loop_returns_one_group():
    loop = _rect_loop(0, 0, 2, 2)
    groups = classify_loops([loop])
    assert len(groups) == 1
    outer, holes = groups[0]
    assert outer is loop
    assert holes == []


def test_empty_returns_empty():
    assert classify_loops([]) == []


def test_two_disjoint_rects_are_two_groups():
    a = _rect_loop(0, 0, 1, 1)
    b = _rect_loop(3, 3, 4, 4)
    groups = classify_loops([a, b])
    assert len(groups) == 2
    outers = {id(g[0]) for g in groups}
    assert id(a) in outers
    assert id(b) in outers
    for _, holes in groups:
        assert holes == []


def test_nested_loop_becomes_hole():
    outer = _rect_loop(0, 0, 4, 4)
    hole = _rect_loop(1, 1, 3, 3)
    groups = classify_loops([outer, hole])
    assert len(groups) == 1
    got_outer, got_holes = groups[0]
    assert got_outer is outer
    assert len(got_holes) == 1
    assert got_holes[0] is hole


def test_outer_and_hole_and_disjoint():
    big = _rect_loop(0, 0, 10, 10)
    inner = _rect_loop(1, 1, 4, 4)
    separate = _rect_loop(20, 20, 25, 25)
    groups = classify_loops([big, inner, separate])
    assert len(groups) == 2
    big_group = next(g for g in groups if g[0] is big)
    sep_group = next(g for g in groups if g[0] is separate)
    assert len(big_group[1]) == 1
    assert big_group[1][0] is inner
    assert sep_group[1] == []


def test_identical_loops_become_two_groups():
    loop = _rect_loop(0, 0, 2, 2)
    import copy
    loop2 = copy.deepcopy(loop)
    groups = classify_loops([loop, loop2])
    assert len(groups) == 2
    for _, holes in groups:
        assert holes == []


def test_order_independent():
    outer = _rect_loop(0, 0, 4, 4)
    hole = _rect_loop(1, 1, 3, 3)
    # hole listed before outer
    groups = classify_loops([hole, outer])
    assert len(groups) == 1
    got_outer, got_holes = groups[0]
    assert got_outer is outer
    assert got_holes[0] is hole
