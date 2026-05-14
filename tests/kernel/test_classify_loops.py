"""Tests for the pure-Python classify_loops function in geometry.py.

classify_loops groups a flat list of loops into (outer, [holes]) pairs so that
disjoint closed areas each become their own face, and nested loops become holes.
These tests run without OCC/cadquery.
"""
import math

from oversolved.kernel.profile_loops import (
    classify_loops,
    _loop_centroid,
    _loop_signed_area,
    _point_in_loop,
    _arc_midpoint,
)


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


# ─── Arc midpoint sampling tests ───


def _arc_edge(cx, cy, r, a_start_deg, a_end_deg, ccw=True) -> dict:
    """Build an arc edge dict the way topology.py produces them."""
    a0 = math.radians(a_start_deg)
    a1 = math.radians(a_end_deg)
    return {
        "kind": "arc",
        "center": [cx, cy],
        "radius": r,
        "angle_start_deg": a_start_deg,
        "angle_end_deg": a_end_deg,
        "ccw": ccw,
        "start": [cx + r * math.cos(a0), cy + r * math.sin(a0)],
        "end": [cx + r * math.cos(a1), cy + r * math.sin(a1)],
    }


def test_arc_midpoint_helper_basic():
    mid = _arc_midpoint(_arc_edge(0, 0, 1, 0, 90))
    assert mid is not None
    # midpoint of 0->90 deg arc at origin radius 1 is at 45 deg
    assert abs(mid[0] - math.cos(math.radians(45))) < 1e-9
    assert abs(mid[1] - math.sin(math.radians(45))) < 1e-9


def test_arc_midpoint_returns_none_for_line():
    e = {"kind": "line", "start": [0, 0], "end": [1, 0]}
    assert _arc_midpoint(e) is None


def test_arc_midpoint_returns_none_for_no_center():
    e = {"kind": "arc", "radius": 1.0}
    assert _arc_midpoint(e) is None


def test_loop_signed_area_pure_lines_positive_ccw():
    # 2x2 CCW square: area should be +4
    loop = _rect_loop(0, 0, 2, 2)
    assert abs(_loop_signed_area(loop) - 4.0) < 1e-9


def test_loop_signed_area_with_large_arc():
    """A CCW loop with a 270-degree arc bulging outward should have larger area
    than the chord-only approximation would give."""
    # Bottom edge: line from (0,0) to (2,0)
    # Right side: 270-degree arc from (2,0) sweeping around
    # For a simpler test: a semicircular cap on top of a rectangle
    # Rectangle bottom half: (0,0)-(2,0)-(2,1)-(0,1)
    # Replace top edge (line from (2,1) to (0,1)) with a CCW semicircle bulging up
    # Arc: center=(1,1), radius=1, from (2,1) at 0 deg to (0,1) at 180 deg
    rect_bottom = [
        {"kind": "line", "start": [0, 0], "end": [2, 0]},
        {"kind": "line", "start": [2, 0], "end": [2, 1]},
    ]
    top_arc = _arc_edge(1, 1, 1, 0, 180, ccw=True)  # bulges upward
    left_line = {"kind": "line", "start": [0, 1], "end": [0, 0]}
    loop = rect_bottom + [top_arc] + [left_line]

    area = _loop_signed_area(loop)
    # Area of rectangle (2x1=2) plus semicircle (pi*1^2/2 ~ 1.571) = ~3.571
    # Chord-only approximation would give just the rectangle area (2.0)
    assert area > 2.5, f"Expected arc-aware area > 2.5, got {area}"
    assert area > 0, "CCW loop should have positive area"


def test_loop_signed_area_arc_without_start_key():
    """OCC-sourced arc dicts without 'start'/'end' keys should not crash."""
    e = {
        "kind": "arc",
        "center": [0, 0],
        "radius": 1.0,
        "angle_start_deg": 0.0,
        "angle_end_deg": 90.0,
        "ccw": True,
    }
    # Should not raise
    area = _loop_signed_area([e])
    # Only 1 point (the midpoint) -- too few for a real area, returns 0
    assert area == 0.0


def test_point_in_loop_arc_midpoint_matters():
    """A point that lies inside the arc bulge but outside the chord polygon
    should be correctly detected as inside when arc midpoints are sampled."""
    # Semicircle cap: center (1,1), radius 1, angles 0->180 (bulges up)
    # The apex of the arc is at (1, 2). A point at (1, 1.8) is inside the
    # semicircle but above the chord line (y=1).
    rect_bottom = [
        {"kind": "line", "start": [0, 0], "end": [2, 0]},
        {"kind": "line", "start": [2, 0], "end": [2, 1]},
    ]
    top_arc = _arc_edge(1, 1, 1, 0, 180, ccw=True)
    left_line = {"kind": "line", "start": [0, 1], "end": [0, 0]}
    loop = rect_bottom + [top_arc] + [left_line]

    # This point is inside the arc bulge (above y=1, within the semicircle)
    assert _point_in_loop([1.0, 1.8], loop)
    # This point is clearly outside
    assert not _point_in_loop([1.0, 3.0], loop)


def test_point_in_loop_no_epsilon_division():
    """A horizontal edge ray at y matching a polygon vertex should not crash
    (verifies the 1e-15 epsilon removal is safe)."""
    loop = _rect_loop(0, 0, 2, 2)
    # Ray at y=0 aligns with the bottom edge endpoints
    result = _point_in_loop([1.0, 0.0], loop)
    assert isinstance(result, bool)  # no crash


def test_classify_loops_with_arc_loop_outer():
    """Loop containing an arc (bulging outward) should still classify as outer."""
    # Three lines forming a U-shape, closed by a CCW arc on top
    # Arc center (2,4), radius 2, from (0,4) at 180 deg to (4,4) at 0 deg CCW
    arc_loop = [
        {"kind": "line", "start": [0, 0], "end": [4, 0]},
        {"kind": "line", "start": [4, 0], "end": [4, 4]},
        _arc_edge(2, 4, 2, 0, 180, ccw=True),  # top arc bulges upward
        {"kind": "line", "start": [0, 4], "end": [0, 0]},
    ]
    inner = _rect_loop(1, 1, 3, 3)
    groups = classify_loops([arc_loop, inner])
    assert len(groups) == 1
    got_outer, got_holes = groups[0]
    assert got_outer is arc_loop
    assert got_holes[0] is inner


def test_loop_centroid_arc_only_no_crash():
    """classify_loops should work when the loop has no 'start' keys (OCC arcs)."""
    arc_only = [
        {
            "kind": "arc",
            "center": [0, 0],
            "radius": 5.0,
            "angle_start_deg": 0.0,
            "angle_end_deg": 180.0,
            "ccw": True,
        }
    ]
    # Should not raise even with no start keys; loop is too small to matter
    groups = classify_loops([arc_only])
    assert len(groups) == 1


# ─── _loop_centroid unit tests ───


def test_loop_centroid_square():
    loop = _rect_loop(0, 0, 1, 1)
    cx, cy = _loop_centroid(loop)
    assert abs(cx - 0.5) < 1e-9
    assert abs(cy - 0.5) < 1e-9


def test_loop_centroid_empty_loop():
    result = _loop_centroid([])
    assert result == [0.0, 0.0]


def test_loop_centroid_two_point_loop():
    loop = [{"kind": "line", "start": [0, 0], "end": [1, 0]}]
    result = _loop_centroid(loop)
    assert result == [0.0, 0.0]


def test_loop_centroid_offset_rect():
    loop = _rect_loop(2, 3, 6, 7)
    cx, cy = _loop_centroid(loop)
    assert abs(cx - 4.0) < 1e-9
    assert abs(cy - 5.0) < 1e-9


# ─── Boundary ambiguity regression tests ───


def test_classify_loops_shared_boundary_point():
    """Two non-overlapping loops whose edge endpoints touch: both independent outers."""
    # Loop A: (0,0)-(1,0)-(1,1)-(0,1), Loop B: (1,0)-(2,0)-(2,1)-(1,1)
    # They share the edge x=1, so start points of B lie on A's boundary.
    a = _rect_loop(0, 0, 1, 1)
    b = _rect_loop(1, 0, 2, 1)
    groups = classify_loops([a, b])
    assert len(groups) == 2
    outers = {id(g[0]) for g in groups}
    assert id(a) in outers
    assert id(b) in outers
    for _, holes in groups:
        assert holes == []


def test_classify_loops_hole_touching_outer_boundary():
    """Hole whose start point lies on the outer loop's boundary is still classified correctly."""
    # Outer: (0,0)-(4,0)-(4,4)-(0,4)
    # Hole: (2,0)-(3,0)-(3,2)-(2,2) — bottom edge of hole starts on outer's bottom edge
    outer = _rect_loop(0, 0, 4, 4)
    hole = _rect_loop(2, 0, 3, 2)
    groups = classify_loops([outer, hole])
    # hole centroid (2.5, 1.0) is strictly inside outer; must be a hole
    assert len(groups) == 1
    got_outer, got_holes = groups[0]
    assert got_outer is outer
    assert len(got_holes) == 1
    assert got_holes[0] is hole


def test_classify_loops_equal_area_containment_limitation():
    """Two loops with equal area: the area guard prevents containment detection.

    Known limitation: equal-area loops are always treated as independent outers
    even if one geometrically encloses the other. This is acceptable because
    equal-area nested loops are pathological in practice.
    """
    # 2x2 square at origin
    outer_sq = _rect_loop(0, 0, 2, 2)
    # 2x2 rhombus-like loop that fits inside outer_sq — but same area
    # Approximate with a shifted 2x2 square that overlaps but isn't nested
    # For simplicity: two identical squares (same area, same geometry)
    import copy
    outer_sq2 = copy.deepcopy(outer_sq)
    groups = classify_loops([outer_sq, outer_sq2])
    # With area guard, neither can contain the other (equal areas) -- both outers
    assert len(groups) == 2


def test_classify_loops_concave_outer_with_hole():
    """Concave outer (L-shape) with a hole inside is classified correctly."""
    # L-shape approximated with a slightly concave polygon
    l_shape = [
        {"kind": "line", "start": [0, 0], "end": [4, 0]},
        {"kind": "line", "start": [4, 0], "end": [4, 2]},
        {"kind": "line", "start": [4, 2], "end": [2, 2]},
        {"kind": "line", "start": [2, 2], "end": [2, 4]},
        {"kind": "line", "start": [2, 4], "end": [0, 4]},
        {"kind": "line", "start": [0, 4], "end": [0, 0]},
    ]
    hole = _rect_loop(0.5, 0.5, 1.5, 1.5)
    groups = classify_loops([l_shape, hole])
    assert len(groups) == 1
    got_outer, got_holes = groups[0]
    assert got_outer is l_shape
    assert len(got_holes) == 1
    assert got_holes[0] is hole


def test_classify_loop_small_arc_not_hole():
    """Loop containing a very small arc (< 5 degrees) is outer, not a hole.

    The arc midpoint can lie on the concave side of a tight-radius arc.
    Using the centroid as rep point must classify this loop as an outer boundary.
    """
    # Triangle-like loop: two straight sides + a tiny arc replacing the third side
    # The arc spans only 3 degrees at radius 10 -- its midpoint is almost collinear
    # with start/end and lies slightly inward, but the loop is a valid outer boundary.
    r = 10.0
    a_start = 0.0
    a_end = 3.0  # 3-degree span
    arc = _arc_edge(0.0, 0.0, r, a_start, a_end, ccw=True)
    arc_start = arc["start"]
    arc_end = arc["end"]
    # Close the loop back to arc start via two line segments through a point far above
    apex = [r * math.cos(math.radians(1.5)), r * math.sin(math.radians(1.5)) + 2.0]
    loop = [
        arc,
        {"kind": "line", "start": arc_end, "end": apex},
        {"kind": "line", "start": apex, "end": arc_start},
    ]
    groups = classify_loops([loop])
    assert len(groups) == 1
    outer, holes = groups[0]
    assert outer is loop
    assert holes == []


def test_classify_loop_arc_hole_inside_boundary():
    """Outer rect + inner small-arc loop: inner is classified as a hole."""
    outer = _rect_loop(-5, -5, 5, 5)

    # Small arc loop centred near (0, 0): a tiny circular-ish triangle
    r = 0.5
    a_start = 0.0
    a_end = 3.0  # 3-degree arc span
    arc = _arc_edge(0.0, 0.0, r, a_start, a_end, ccw=True)
    arc_start = arc["start"]
    arc_end = arc["end"]
    apex = [r * math.cos(math.radians(1.5)), r * math.sin(math.radians(1.5)) + 0.1]
    inner = [
        arc,
        {"kind": "line", "start": arc_end, "end": apex},
        {"kind": "line", "start": apex, "end": arc_start},
    ]

    groups = classify_loops([outer, inner])
    assert len(groups) == 1
    got_outer, got_holes = groups[0]
    assert got_outer is outer
    assert len(got_holes) == 1
    assert got_holes[0] is inner
