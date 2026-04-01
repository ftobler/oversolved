"""
Test geometric classification of topology surfaces.

When a circle is cut by a line, it creates two surfaces on opposite sides.
The query system must be able to distinguish them geometrically, not just
with synthetic indices. This test suite verifies that surfaces are classified
by their actual geometric position.
"""

from oversolved.geometry import (
    signed_distance_to_line,
    point_in_circle,
    classify_surface_by_line_side,
    classify_surface_by_circle_side,
    classify_surface_cardinal,
)


class TestSignedDistanceToLine:
    """Test signed distance calculation from point to directed line."""

    def test_point_on_positive_side(self):
        """Point on left side of line (positive side)."""
        line_start = (0, 0)
        line_end = (1, 0)  # Horizontal line going right
        point = (0.5, 1)  # Above the line
        dist = signed_distance_to_line(point, line_start, line_end)
        assert dist > 0, "Point above horizontal line should be positive"

    def test_point_on_negative_side(self):
        """Point on right side of line (negative side)."""
        line_start = (0, 0)
        line_end = (1, 0)
        point = (0.5, -1)  # Below the line
        dist = signed_distance_to_line(point, line_start, line_end)
        assert dist < 0, "Point below horizontal line should be negative"

    def test_point_on_line(self):
        """Point exactly on the line."""
        line_start = (0, 0)
        line_end = (1, 1)
        point = (0.5, 0.5)  # On the diagonal
        dist = signed_distance_to_line(point, line_start, line_end)
        assert abs(dist) < 1e-9, "Point on line should have ~zero distance"

    def test_vertical_line_left_side(self):
        """Vertical line, point on left (positive) side."""
        line_start = (0, 0)
        line_end = (0, 1)  # Vertical line going up
        point = (-1, 0.5)  # Left of the line
        dist = signed_distance_to_line(point, line_start, line_end)
        assert dist > 0, "Point left of vertical line should be positive"

    def test_circle_cut_by_horizontal_line(self):
        """Circle centered at origin, cut by horizontal line y=0.

        The line y=0 divides the circle into upper and lower halves.
        Points above should be positive, below should be negative.
        """
        line_start = (-1, 0)
        line_end = (1, 0)

        # Upper hemisphere
        point_above = (0, 0.5)
        dist_above = signed_distance_to_line(point_above, line_start, line_end)
        assert dist_above > 0

        # Lower hemisphere
        point_below = (0, -0.5)
        dist_below = signed_distance_to_line(point_below, line_start, line_end)
        assert dist_below < 0


class TestPointInCircle:
    """Test point-in-circle containment test."""

    def test_center_is_inside(self):
        """Center of circle is inside."""
        center = (0, 0)
        radius = 1
        point = (0, 0)
        assert point_in_circle(point, center, radius)

    def test_interior_point(self):
        """Point strictly inside."""
        center = (0, 0)
        radius = 1
        point = (0.5, 0)
        assert point_in_circle(point, center, radius)

    def test_boundary_point(self):
        """Point on boundary is NOT inside (use < not <=)."""
        center = (0, 0)
        radius = 1
        point = (1, 0)
        assert not point_in_circle(point, center, radius)

    def test_exterior_point(self):
        """Point outside."""
        center = (0, 0)
        radius = 1
        point = (2, 0)
        assert not point_in_circle(point, center, radius)

    def test_offset_circle(self):
        """Circle not centered at origin."""
        center = (5, 5)
        radius = 2
        point_inside = (5.5, 5.5)
        point_outside = (8, 5)
        assert point_in_circle(point_inside, center, radius)
        assert not point_in_circle(point_outside, center, radius)


class TestClassifySurfaceByLineSide:
    """Test classification of surface by which side of line it's on."""

    def test_circle_cut_by_horizontal_line(self):
        """Circle cut by horizontal line produces @pos (above) and @neg (below)."""
        line_start = (-1, 0)
        line_end = (1, 0)

        # Upper semicircle centroid
        centroid_above = (0, 0.5)
        assert classify_surface_by_line_side(centroid_above, line_start, line_end) == '@pos'

        # Lower semicircle centroid
        centroid_below = (0, -0.5)
        assert classify_surface_by_line_side(centroid_below, line_start, line_end) == '@neg'

    def test_circle_cut_by_diagonal_line(self):
        """Diagonal line y=x through origin."""
        line_start = (-1, -1)
        line_end = (1, 1)

        # Above the line
        centroid_above = (0, 1)
        assert classify_surface_by_line_side(centroid_above, line_start, line_end) == '@pos'

        # Below the line
        centroid_below = (1, 0)
        assert classify_surface_by_line_side(centroid_below, line_start, line_end) == '@neg'

    def test_vertical_tangent_line(self):
        """Vertical line cutting circle horizontally."""
        line_start = (0, -1)
        line_end = (0, 1)

        centroid_left = (-0.5, 0)
        centroid_right = (0.5, 0)

        assert classify_surface_by_line_side(centroid_left, line_start, line_end) == '@pos'
        assert classify_surface_by_line_side(centroid_right, line_start, line_end) == '@neg'


class TestClassifySurfaceByCircleSide:
    """Test classification by inside/outside circle."""

    def test_standalone_circle(self):
        """Circle with no intersections produces @inner and @outer."""
        center = (0, 0)
        radius = 1

        # Interior (e.g., very small region inside)
        centroid_inner = (0, 0)
        assert classify_surface_by_circle_side(centroid_inner, center, radius) == '@inner'

        # Exterior (e.g., unbounded region outside)
        centroid_outer = (5, 5)
        assert classify_surface_by_circle_side(centroid_outer, center, radius) == '@outer'

    def test_offset_circle(self):
        """Circle not at origin."""
        center = (10, 10)
        radius = 2

        centroid_inner = (10, 10)
        centroid_outer = (20, 20)

        assert classify_surface_by_circle_side(centroid_inner, center, radius) == '@inner'
        assert classify_surface_by_circle_side(centroid_outer, center, radius) == '@outer'


class TestClassifySurfaceCardinal:
    """Test cardinal direction classification."""

    def test_four_quadrants(self):
        """Surfaces in each quadrant."""
        origin = (0, 0)

        north = (0, 5)
        south = (0, -5)
        east = (5, 0)
        west = (-5, 0)

        assert classify_surface_cardinal(north, origin) == '@north'
        assert classify_surface_cardinal(south, origin) == '@south'
        assert classify_surface_cardinal(east, origin) == '@east'
        assert classify_surface_cardinal(west, origin) == '@west'

    def test_diagonal_prefers_dominant_axis(self):
        """When both axes are significant, prefer the dominant one."""
        origin = (0, 0)

        # More north than east → north
        north_east = (1, 5)
        assert classify_surface_cardinal(north_east, origin) == '@north'

        # More east than north → east
        east_north = (5, 1)
        assert classify_surface_cardinal(east_north, origin) == '@east'

    def test_offset_origin(self):
        """Classification relative to arbitrary origin."""
        origin = (5, 5)

        # North of origin
        point = (5, 10)
        assert classify_surface_cardinal(point, origin) == '@north'

        # South of origin
        point = (5, 0)
        assert classify_surface_cardinal(point, origin) == '@south'


class TestGeometricClassificationIntegration:
    """Integration tests simulating real geometry scenarios."""

    def test_circle_cut_by_two_perpendicular_lines(self):
        """Circle divided into 4 quadrants by perpendicular lines."""
        # Horizontal line y=0
        h_line_start = (-1, 0)
        h_line_end = (1, 0)

        # Vertical line x=0
        v_line_start = (0, -1)
        v_line_end = (0, 1)

        # Quadrant classifiers (relative to horizontal line first)
        nw = (-0.5, 0.5)  # Northwest quadrant
        ne = (0.5, 0.5)
        sw = (-0.5, -0.5)
        se = (0.5, -0.5)

        # All four quadrants are outside the origin and above/below the horizontal line
        # Verify vertical line properties
        assert v_line_start[0] == v_line_end[0], "Vertical line has same x-coordinate"
        assert classify_surface_by_line_side(nw, h_line_start, h_line_end) == '@pos'
        assert classify_surface_by_line_side(ne, h_line_start, h_line_end) == '@pos'
        assert classify_surface_by_line_side(sw, h_line_start, h_line_end) == '@neg'
        assert classify_surface_by_line_side(se, h_line_start, h_line_end) == '@neg'

    def test_tangent_line_touches_circle(self):
        """Line tangent to circle creates one surface inside, one outside."""
        center = (0, 0)
        radius = 1

        # Horizontal tangent line at y=1
        line_start = (-2, 1)
        line_end = (2, 1)

        # Interior point
        interior = (0, 0)
        assert classify_surface_by_circle_side(interior, center, radius) == '@inner'

        # Exterior point above tangent
        exterior = (0, 2)
        assert classify_surface_by_circle_side(exterior, center, radius) == '@outer'

        # Exterior point below tangent (but outside circle)
        exterior_below = (0, -2)
        assert classify_surface_by_circle_side(exterior_below, center, radius) == '@outer'

        # Line divides exterior region
        above_tangent = (0, 1.5)
        below_tangent = (0, 0.5)  # Still outside circle but below tangent

        assert classify_surface_by_line_side(above_tangent, line_start, line_end) == '@pos'
        assert classify_surface_by_line_side(below_tangent, line_start, line_end) == '@neg'

    def test_stability_properties(self):
        """Classifiers should be stable under small perturbations."""
        center = (0, 0)
        radius = 1

        # Interior point and nearby points
        interior = (0.4, 0.4)
        perturbed_interior = (0.40001, 0.40001)

        assert classify_surface_by_circle_side(interior, center, radius) == '@inner'
        assert classify_surface_by_circle_side(perturbed_interior, center, radius) == '@inner'

        # Exterior points
        exterior = (2, 2)
        perturbed_exterior = (2.00001, 2.00001)

        assert classify_surface_by_circle_side(exterior, center, radius) == '@outer'
        assert classify_surface_by_circle_side(perturbed_exterior, center, radius) == '@outer'
