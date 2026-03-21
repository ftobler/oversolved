"""Tests for topology.py — intersection detection and surface extraction."""

import math
import pytest
from oversolve.topology import detect_topology


def num_surfaces(result):
    return len(result["surfaces"])


def num_intersections(result):
    return len(result["intersection_points"])


# ── Helpers to build geometry dicts ───────────────────────────────────────────

def line(x1, y1, x2, y2):
    return {"start": [x1, y1], "end": [x2, y2]}


def circle(cx, cy, r):
    return {"center": [cx, cy], "radius": r}


def arc(cx, cy, r, a_start_deg, a_end_deg):
    a0, a1 = math.radians(a_start_deg), math.radians(a_end_deg)
    return {
        "center": [cx, cy],
        "radius": r,
        "angle_start": a_start_deg,
        "angle_end": a_end_deg,
        "start": [cx + r * math.cos(a0), cy + r * math.sin(a0)],
        "end":   [cx + r * math.cos(a1), cy + r * math.sin(a1)],
    }


def rect(x0, y0, x1, y1):
    """4 lines forming a closed rectangle."""
    return {
        "bottom": line(x0, y0, x1, y0),
        "right":  line(x1, y0, x1, y1),
        "top":    line(x1, y1, x0, y1),
        "left":   line(x0, y1, x0, y0),
    }


# ── Single enclosed region ────────────────────────────────────────────────────

def test_triangle_one_surface():
    """Three lines forming a closed triangle → 1 surface."""
    geom = {
        "a": line(0, 0, 2, 0),
        "b": line(2, 0, 1, 2),
        "c": line(1, 2, 0, 0),
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1
    assert num_intersections(result) == 0  # no new intersections, just shared endpoints


def test_rectangle_one_surface():
    """Four lines forming a closed rectangle → 1 surface."""
    result = detect_topology(rect(0, 0, 2, 2))
    assert num_surfaces(result) == 1
    assert num_intersections(result) == 0


def test_standalone_circle_one_surface():
    """A circle with no intersections → 1 surface."""
    result = detect_topology({"c": circle(1, 1, 1)})
    assert num_surfaces(result) == 1
    assert num_intersections(result) == 0


# ── Rectangle split into two regions ─────────────────────────────────────────

def test_rectangle_with_diagonal_two_surfaces():
    """Rectangle + diagonal → 2 triangular surfaces."""
    geom = {**rect(0, 0, 2, 2), "diag": line(0, 0, 2, 2)}
    result = detect_topology(geom)
    assert num_surfaces(result) == 2
    assert num_intersections(result) == 0  # diagonal shares corners, no new pts


def test_rectangle_with_midline_two_surfaces():
    """Rectangle + horizontal line through the middle (intersects edges, not corners) → 2 surfaces."""
    geom = {
        **rect(0, 0, 4, 4),
        "mid": line(-1, 2, 5, 2),   # crosses left edge at (0,2), right edge at (4,2)
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2
    assert num_intersections(result) == 2  # two new crossing points


def test_rectangle_with_vertical_midline_two_surfaces():
    """Rectangle + vertical line through the middle → 2 surfaces."""
    geom = {
        **rect(0, 0, 4, 4),
        "mid": line(2, -1, 2, 5),   # crosses bottom at (2,0), top at (2,4)
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2
    assert num_intersections(result) == 2


# ── Rectangle with diagonal (not touching corners) ───────────────────────────

def test_rectangle_with_noncorner_diagonal_two_surfaces():
    """Rectangle + line whose endpoints sit on two edges (not corners) → 2 surfaces.

    The line endpoints already exist as endpoint vertices, so no new
    intersection_points are recorded — but the edges are still split correctly.
    """
    geom = {
        **rect(0, 0, 4, 4),
        "slash": line(0, 2, 2, 4),   # left-mid to top-mid
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2


# ── Circle cut in two ─────────────────────────────────────────────────────────

def test_circle_cut_by_chord_two_surfaces():
    """Circle bisected by a chord through the center → 2 surfaces.

    The chord endpoints are exactly on the circle, so they're endpoint vertices,
    not counted as new intersection points.
    """
    geom = {
        "c": circle(0, 0, 1),
        "chord": line(-1, 0, 1, 0),  # diameter, hits circle at (-1,0) and (1,0)
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2


def test_circle_cut_by_off_center_chord_two_surfaces():
    """Circle cut by a chord that does not pass through the center → 2 surfaces."""
    geom = {
        "c": circle(0, 0, 1),
        "chord": line(-1, 0.5, 1, 0.5),  # horizontal chord above center
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2
    assert num_intersections(result) == 2


# ── Two overlapping circles ───────────────────────────────────────────────────

def test_two_overlapping_circles_three_surfaces():
    """Two overlapping circles → 3 surfaces: left lune, overlap, right lune."""
    geom = {
        "c1": circle(-0.5, 0, 1),
        "c2": circle(0.5, 0, 1),
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 3
    assert num_intersections(result) == 2


# ── Arc scenarios ─────────────────────────────────────────────────────────────

def test_semicircle_arc_and_diameter_one_surface():
    """Upper semicircle arc + diameter line → 1 surface (half-disk)."""
    geom = {
        "semi": arc(0, 0, 1, 0, 180),
        "diam": line(-1, 0, 1, 0),
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1
    assert num_intersections(result) == 0  # arc endpoints land on line endpoints


def test_arc_chord_divides_two_surfaces():
    """3/4 arc + chord closing off the short segment → 2 surfaces."""
    geom = {
        "a": arc(0, 0, 1, 0, 270),      # 3/4 arc from 0° to 270°
        "ch": line(0, -1, 1, 0),         # chord from (0,-1) to (1,0)
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2


# ── No surfaces (open geometry) ───────────────────────────────────────────────

def test_single_line_no_surfaces():
    """A single open line cannot enclose any area."""
    result = detect_topology({"l": line(0, 0, 1, 1)})
    assert num_surfaces(result) == 0


def test_two_non_intersecting_lines_no_surfaces():
    result = detect_topology({
        "a": line(0, 0, 1, 0),
        "b": line(0, 1, 1, 1),
    })
    assert num_surfaces(result) == 0


# ── Construction lines are ignored ───────────────────────────────────────────

def test_construction_lines_ignored():
    """Construction lines are excluded from topology — rectangle stays 1 surface."""
    geom = {
        **rect(0, 0, 2, 2),
        "diag": {**line(0, 0, 2, 2), "construction": True},
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1  # diagonal not counted


# ── More complex shapes ───────────────────────────────────────────────────────

def test_two_separate_rectangles_two_surfaces():
    """Two separate closed rectangles → 2 surfaces each."""
    geom = {
        # First rectangle (0,0)-(2,2)
        "b1": line(0, 0, 2, 0),
        "r1": line(2, 0, 2, 2),
        "t1": line(2, 2, 0, 2),
        "l1": line(0, 2, 0, 0),
        # Second rectangle (4,0)-(6,2)
        "b2": line(4, 0, 6, 0),
        "r2": line(6, 0, 6, 2),
        "t2": line(6, 2, 4, 2),
        "l2": line(4, 2, 4, 0),
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 2
    assert num_intersections(result) == 0


def test_rectangle_with_two_parallel_splits_three_surfaces():
    """Rectangle split by two parallel lines → 3 surfaces."""
    geom = {
        **rect(0, 0, 6, 4),
        "s1": line(2, -1, 2, 5),  # first split at x=2
        "s2": line(4, -1, 4, 5),  # second split at x=4
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 3
    assert num_intersections(result) == 4  # each line hits top + bottom


def test_rectangle_with_cross_four_surfaces():
    """Rectangle split by a horizontal + vertical line crossing inside → 4 surfaces."""
    geom = {
        **rect(0, 0, 4, 4),
        "h": line(-1, 2, 5, 2),  # horizontal mid
        "v": line(2, -1, 2, 5),  # vertical mid
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 4
    assert num_intersections(result) == 5  # 4 edge hits + 1 center crossing


# ── Wrapping arcs (angle_end < angle_start, crossing 0°) ─────────────────────
#
# A CCW arc from 270° to 90° passes through 0°.  Its end-angle (1.57 rad) is
# numerically LESS than its start-angle (4.71 rad), so a naïve sort of the
# split-parameter list would put the end vertex first, reversing the arc
# direction in the half-edge graph and causing the wrong (or no) surface.

def test_wrapping_arc_half_disk():
    """Right-half-disk: CCW arc from 270° to 90° (through 0°) + vertical chord.

    The arc wraps through 0°, so angle_end (1.57 rad) < angle_start (4.71 rad).
    This must still yield exactly 1 surface.
    """
    r = 1.0
    geom = {
        "a": arc(0, 0, r, 270, 90),   # right semicircle, wraps through 0°
        "l": line(0, -r, 0, r),        # vertical chord closing the left side
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1


def test_wrapping_arc_three_quarter():
    """3/4 arc from 270° to 180° (wrapping through 0°) + chord → 1 surface."""
    r = 1.0
    geom = {
        "a": arc(0, 0, r, 270, 180),  # 270° arc, wraps through 0°
        "l": line(0, -r, -r, 0),      # chord from (0,-1) to (-1,0)
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1


def test_equal_belt_one_surface():
    """Stadium (pill) shape: two 180° arcs + two straight sides → 1 enclosed surface.

    The right arc goes from 270° to 90° (wrapping through 0°).  Without proper
    parameter normalisation the right arc is reversed in the DCEL and no surface
    is found for the right half.
    """
    r, d = 1.0, 4.0   # arc radius, centre-to-centre distance
    geom = {
        "arc_l": arc(-d / 2, 0, r, 90, 270),    # left  semicircle (non-wrapping)
        "arc_r": arc( d / 2, 0, r, 270, 90),    # right semicircle (wrapping)
        "top":   line(-d / 2, r,  d / 2, r),
        "bot":   line( d / 2, -r, -d / 2, -r),
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1


def test_unequal_belt_one_surface():
    """Unequal belt: two arcs of different radii + two tangent lines → 1 surface.

    Both the wrapping-arc and the twin-mapping fixes must be active for this
    to produce a single enclosed region.
    """
    r1, r2, d = 1.0, 2.0, 6.0
    # External tangent points (approximate, good enough for topology)
    geom = {
        "arc_l": arc(-d / 2, 0, r1, 90, 270),
        "arc_r": arc( d / 2, 0, r2, 270, 90),
        "top":   line(-d / 2, r1, d / 2, r2),
        "bot":   line( d / 2, -r2, -d / 2, -r1),
    }
    result = detect_topology(geom)
    assert num_surfaces(result) == 1
