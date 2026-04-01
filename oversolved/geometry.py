"""geometry.py — Geometric classification helpers for topology surfaces."""


def signed_distance_to_line(point: tuple[float, float], line_start: tuple[float, float],
                            line_end: tuple[float, float]) -> float:
    """Compute signed distance from point to line.

    Positive = point is on the left side of the directed line (start → end).
    Negative = point is on the right side.
    Zero = point is on the line.
    """
    px, py = point
    x1, y1 = line_start
    x2, y2 = line_end

    # Vector from line start to line end
    dx = x2 - x1
    dy = y2 - y1

    # Vector from line start to point
    dpx = px - x1
    dpy = py - y1

    # Cross product: (line_vec) × (point_vec)
    # Positive = left side, Negative = right side
    return dx * dpy - dy * dpx


def point_in_circle(point: tuple[float, float], center: tuple[float, float],
                    radius: float) -> bool:
    """Check if point is inside circle (distance < radius)."""
    px, py = point
    cx, cy = center
    dist_sq = (px - cx) ** 2 + (py - cy) ** 2
    return dist_sq < radius ** 2


def classify_surface_by_line_side(centroid: tuple[float, float],
                                  line_start: tuple[float, float],
                                  line_end: tuple[float, float]) -> str:
    """Classify surface as '@pos' or '@neg' based on line side.

    @pos: centroid is on the left/positive side of the line
    @neg: centroid is on the right/negative side of the line
    """
    signed_dist = signed_distance_to_line(centroid, line_start, line_end)
    return '@pos' if signed_dist > 0 else '@neg'


def classify_surface_by_circle_side(centroid: tuple[float, float],
                                    center: tuple[float, float],
                                    radius: float) -> str:
    """Classify surface as '@inner' or '@outer' relative to circle.

    @inner: centroid is inside the circle
    @outer: centroid is outside the circle
    """
    return '@inner' if point_in_circle(centroid, center, radius) else '@outer'


def classify_surface_cardinal(centroid: tuple[float, float],
                              origin: tuple[float, float] = (0, 0)) -> str:
    """Classify surface by cardinal direction from origin.

    Returns '@north', '@south', '@east', or '@west' based on which quadrant
    the centroid falls into relative to the origin.
    """
    px, py = centroid
    ox, oy = origin
    dx = px - ox
    dy = py - oy

    # Use absolute values to determine dominant axis
    if abs(dy) > abs(dx):
        return '@north' if dy > 0 else '@south'
    else:
        return '@east' if dx > 0 else '@west'
