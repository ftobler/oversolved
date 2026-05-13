"""Pure-Python utilities for classifying 2D profile loops before OCC extrusion."""

import math


def _arc_midpoint(e: dict) -> list[float] | None:
    """Return the midpoint of an arc edge, or None if not an arc or no center."""
    if e.get("kind") != "arc":
        return None
    center = e.get("center")
    if center is None:
        return None
    cx, cy = center[0], center[1]
    r = e.get("radius", 0.0)
    a0 = math.radians(e.get("angle_start_deg", 0.0))
    a1 = math.radians(e.get("angle_end_deg", 0.0))
    if not e.get("ccw", True):
        a0, a1 = a1, a0
    if a1 < a0:
        a1 += 2 * math.pi
    am = (a0 + a1) / 2
    return [cx + r * math.cos(am), cy + r * math.sin(am)]


def _loop_pts(loop: list[dict]) -> list[list[float]]:
    """Build a polygon point list from a loop, inserting arc midpoints."""
    pts: list[list[float]] = []
    for e in loop:
        if "start" in e:
            pts.append(e["start"])
        mid = _arc_midpoint(e)
        if mid is not None:
            pts.append(mid)
        elif "start" not in e:
            # OCC-sourced edge without start/end: skip (no geometry to place)
            pass
    return pts


def _loop_signed_area(loop: list[dict]) -> float:
    """Signed 2D area via the shoelace formula. Positive = CCW (outer)."""
    pts = _loop_pts(loop)
    n = len(pts)
    if n < 3:
        return 0.0
    return sum(
        pts[i][0] * pts[(i + 1) % n][1] - pts[(i + 1) % n][0] * pts[i][1]
        for i in range(n)
    ) / 2.0


def _point_in_loop(pt: list[float], loop: list[dict]) -> bool:
    """Ray-casting point-in-polygon test against a 2D loop."""
    x, y = pt[0], pt[1]
    pts = _loop_pts(loop)
    n = len(pts)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i][0], pts[i][1]
        xj, yj = pts[j][0], pts[j][1]
        if (yi > y) != (yj > y):
            if x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                inside = not inside
        j = i
    return inside


def classify_loops(
    loops: list[list[dict]],
) -> list[tuple[list[dict], list[list[dict]]]]:
    """Group loops into (outer, holes) pairs for face construction.

    Loops contained inside another loop become holes of the smallest enclosing
    outer loop. Loops not contained in any other loop are independent outer
    boundaries (disjoint closed areas that should each become their own face).

    Returns a list of (outer_loop, [hole_loops, ...]) tuples.
    """
    if not loops:
        return []
    if len(loops) == 1:
        return [(loops[0], [])]

    def rep_pt(loop: list[dict]) -> list[float]:
        for e in loop:
            if "start" in e:
                return list(e["start"])
        # Fall back to arc midpoint for OCC-sourced arcs without start/end
        for e in loop:
            mid = _arc_midpoint(e)
            if mid is not None:
                return mid
        return [0.0, 0.0]

    n = len(loops)
    areas = [abs(_loop_signed_area(loop)) for loop in loops]

    # For each loop, find the smallest loop that strictly contains it.
    contained_by: list[int] = [-1] * n
    for i in range(n):
        pt = rep_pt(loops[i])
        best = -1
        best_area = float("inf")
        for j in range(n):
            if i == j:
                continue
            if areas[j] < best_area and _point_in_loop(pt, loops[j]):
                best = j
                best_area = areas[j]
        contained_by[i] = best

    # Break mutual-containment cycles (e.g. identical or exactly overlapping loops).
    # If A is contained by B and B is contained by A, neither is truly nested;
    # treat both as independent outers.
    for i in range(n):
        j = contained_by[i]
        if j != -1 and contained_by[j] == i:
            contained_by[i] = -1
            contained_by[j] = -1

    outer_indices = [i for i in range(n) if contained_by[i] == -1]
    result = []
    for oi in outer_indices:
        holes = [loops[i] for i in range(n) if contained_by[i] == oi]
        result.append((loops[oi], holes))
    return result
