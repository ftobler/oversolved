"""Pure-Python utilities for classifying 2D profile loops before OCC extrusion."""


def _loop_signed_area(loop: list[dict]) -> float:
    """Signed 2D area via the shoelace formula. Positive = CCW (outer)."""
    pts = [e["start"] for e in loop if "start" in e]
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
    pts = [e["start"] for e in loop if "start" in e]
    n = len(pts)
    inside = False
    j = n - 1
    for i in range(n):
        xi, yi = pts[i][0], pts[i][1]
        xj, yj = pts[j][0], pts[j][1]
        if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi + 1e-15) + xi):
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

    outer_indices = [i for i in range(n) if contained_by[i] == -1]
    result = []
    for oi in outer_indices:
        holes = [loops[i] for i in range(n) if contained_by[i] == oi]
        result.append((loops[oi], holes))
    return result
