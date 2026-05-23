"""Pure-Python utilities for classifying 2D profile loops before OCC extrusion."""

import math
from oversolved.kernel.solver_constants import TOL_NEAR_ZERO_AREA
from oversolved.kernel.query import _parse_ancestry

_REID_OVERLAP_MIN = 0.5  # minimum fraction of old members that must appear in new area


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


# Arc samples per edge when approximating a region's area centroid. One sample
# (the midpoint) is enough for point-in-loop / signed-area, but the centroid of a
# curved region needs a finer boundary polygon to converge on OCC's face.Center().
_CENTROID_ARC_SAMPLES = 64


def _arc_sample_points(e: dict, n: int) -> list[list[float]]:
    """Return n interior points spread along an arc edge (n>=1).

    n=1 yields the arc midpoint, matching _arc_midpoint. Empty if not an arc.
    """
    if e.get("kind") != "arc":
        return []
    center = e.get("center")
    if center is None:
        return []
    cx, cy = center[0], center[1]
    r = e.get("radius", 0.0)
    a0 = math.radians(e.get("angle_start_deg", 0.0))
    a1 = math.radians(e.get("angle_end_deg", 0.0))
    if not e.get("ccw", True):
        a0, a1 = a1, a0
    if a1 < a0:
        a1 += 2 * math.pi
    return [
        [cx + r * math.cos(a), cy + r * math.sin(a)]
        for a in (a0 + (a1 - a0) * (k + 1) / (n + 1) for k in range(n))
    ]


def _loop_pts(loop: list[dict], arc_samples: int = 1) -> list[list[float]]:
    """Build a polygon point list from a loop, inserting arc sample points.

    arc_samples controls how finely arcs are sampled (default 1 = midpoint only).
    """
    pts: list[list[float]] = []
    for e in loop:
        if "start" in e:
            pts.append(e["start"])
        pts.extend(_arc_sample_points(e, arc_samples))
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


def _loop_centroid(loop: list[dict]) -> list[float]:
    """Area-weighted centroid of a 2D loop polygon.

    Returns a point strictly interior to convex loops, avoiding the boundary
    ambiguity that arises when using edge endpoints as representative points.
    Falls back to the first polygon point for near-zero-area loops, or to
    [0.0, 0.0] for loops with fewer than 3 sampled points.
    """
    pts = _loop_pts(loop, arc_samples=_CENTROID_ARC_SAMPLES)
    n = len(pts)
    if n < 3:
        return [0.0, 0.0]
    cx = cy = 0.0
    area = 0.0
    for i in range(n):
        j = (i + 1) % n
        cross = pts[i][0] * pts[j][1] - pts[j][0] * pts[i][1]
        area += cross
        cx += (pts[i][0] + pts[j][0]) * cross
        cy += (pts[i][1] + pts[j][1]) * cross
    area /= 2.0
    if abs(area) < TOL_NEAR_ZERO_AREA:
        return [pts[0][0], pts[0][1]]
    cx /= 6.0 * area
    cy /= 6.0 * area
    return [cx, cy]


def _surface_entity_ids(surface: dict) -> frozenset[str]:
    """Extract the structural (non-index) entity IDs from a surface query.

    Returns the frozenset of `@feature/entity` tokens only, excluding positional
    tokens like `surface:N` and the bare feature ref `@feature`.
    """
    query = surface.get("query", "")
    if not query.startswith("?"):
        return frozenset()
    try:
        ids, _ = _parse_ancestry(query)
    except Exception:
        return frozenset()
    return frozenset(
        i for i in ids
        if i.startswith("@") and "/" in i
    )


def _surface_ancestor_key(surface: dict) -> frozenset[str]:
    """Return the full ancestor frozenset used as the repository key."""
    query = surface.get("query", "")
    if not query.startswith("?"):
        return frozenset()
    try:
        ids, _ = _parse_ancestry(query)
    except Exception:
        return frozenset()
    return frozenset(ids)


def match_area_reid(
    old_surfaces: list[dict],
    new_surfaces: list[dict],
) -> dict[frozenset, list[frozenset]]:
    """Match old surface ancestor keys to new surface ancestor keys by heuristic.

    For each old surface, finds the new surface(s) that share the most
    constituent entity IDs. Ties are broken by centroid distance. A match
    requires at least _REID_OVERLAP_MIN fraction of the old entity set to
    appear in the new entity set.

    Returns a dict mapping old_key (frozenset of ancestor IDs) to a list of
    new_keys (frozensets) that the old area maps to. The list has more than
    one entry in the split case (one old area maps to multiple new areas).
    """
    if not old_surfaces or not new_surfaces:
        return {}

    # Pre-compute entity ID sets, centroids, and repo keys for all surfaces.
    old_entity_sets = [_surface_entity_ids(s) for s in old_surfaces]
    new_entity_sets = [_surface_entity_ids(s) for s in new_surfaces]
    old_keys = [_surface_ancestor_key(s) for s in old_surfaces]
    new_keys = [_surface_ancestor_key(s) for s in new_surfaces]
    new_centroids = [_loop_centroid(s.get("boundary", [])) for s in new_surfaces]

    mapping: dict[frozenset, list[frozenset]] = {}

    for oi, (old_set, old_key) in enumerate(zip(old_entity_sets, old_keys)):
        if not old_set or not old_key:
            continue

        old_centroid = _loop_centroid(old_surfaces[oi].get("boundary", []))
        n_old = len(old_set)

        best_overlap = 0.0
        best_dist = float("inf")
        best_ni: list[int] = []

        for ni, new_set in enumerate(new_entity_sets):
            if not new_set:
                continue
            overlap = len(old_set & new_set) / n_old
            if overlap < _REID_OVERLAP_MIN:
                continue

            nc = new_centroids[ni]
            dist = math.hypot(nc[0] - old_centroid[0], nc[1] - old_centroid[1])

            if overlap > best_overlap or (
                abs(overlap - best_overlap) < 1e-9 and dist < best_dist
            ):
                best_overlap = overlap
                best_dist = dist
                best_ni = [ni]
            elif abs(overlap - best_overlap) < 1e-9 and abs(dist - best_dist) < 1e-9:
                best_ni.append(ni)

        # Also include any split-off pieces that share the same best overlap
        # and are spatially adjacent (within 2x best_dist).
        split_candidates = []
        for ni, new_set in enumerate(new_entity_sets):
            if ni in best_ni or not new_set:
                continue
            overlap = len(old_set & new_set) / n_old
            if overlap < _REID_OVERLAP_MIN:
                continue
            nc = new_centroids[ni]
            dist = math.hypot(nc[0] - old_centroid[0], nc[1] - old_centroid[1])
            if abs(overlap - best_overlap) < 1e-9:
                split_candidates.append(ni)
                best_ni.append(ni)

        if best_ni:
            mapping[old_key] = [new_keys[ni] for ni in best_ni]

    return mapping


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

    n = len(loops)
    areas = [abs(_loop_signed_area(loop)) for loop in loops]

    # For each loop, find the smallest loop that strictly contains it.
    # A containing loop must have strictly larger area than the loop it contains.
    contained_by: list[int] = [-1] * n
    for i in range(n):
        pt = _loop_centroid(loops[i])
        best = -1
        best_area = float("inf")
        for j in range(n):
            if i == j:
                continue
            if areas[j] > areas[i] and areas[j] < best_area and _point_in_loop(pt, loops[j]):
                best = j
                best_area = areas[j]
        contained_by[i] = best

    outer_indices = [i for i in range(n) if contained_by[i] == -1]
    result = []
    for oi in outer_indices:
        holes = [loops[i] for i in range(n) if contained_by[i] == oi]
        result.append((loops[oi], holes))
    return result
