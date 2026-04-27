"""Pure-Python surface and point classifiers used by the query system."""


def signed_distance_to_line(
    point: tuple[float, float],
    line_start: tuple[float, float],
    line_end: tuple[float, float],
) -> float:
    """Signed distance from point to directed line (start -> end).

    Positive = left side, negative = right side, zero = on the line.
    """
    px, py = point
    x1, y1 = line_start
    x2, y2 = line_end
    dx = x2 - x1
    dy = y2 - y1
    return dx * (py - y1) - dy * (px - x1)


def point_in_circle(
    point: tuple[float, float], center: tuple[float, float], radius: float
) -> bool:
    """Return True if point is strictly inside the circle."""
    px, py = point
    cx, cy = center
    return (px - cx) ** 2 + (py - cy) ** 2 < radius ** 2


def classify_surface_by_line_side(
    centroid: tuple[float, float],
    line_start: tuple[float, float],
    line_end: tuple[float, float],
) -> str:
    """Return '@pos' or '@neg' based on which side of the line the centroid lies."""
    return "@pos" if signed_distance_to_line(centroid, line_start, line_end) > 0 else "@neg"


def classify_surface_by_circle_side(
    centroid: tuple[float, float], center: tuple[float, float], radius: float
) -> str:
    """Return '@inner' or '@outer' based on whether centroid is inside the circle."""
    return "@inner" if point_in_circle(centroid, center, radius) else "@outer"


def classify_surface_cardinal(
    centroid: tuple[float, float], origin: tuple[float, float] = (0, 0)
) -> str:
    """Return '@north', '@south', '@east', or '@west' for the centroid's direction."""
    dx = centroid[0] - origin[0]
    dy = centroid[1] - origin[1]
    if abs(dy) > abs(dx):
        return "@north" if dy > 0 else "@south"
    return "@east" if dx > 0 else "@west"
