"""Unit tests for geometry hash functions."""

import math
import pytest

from oversolved.kernel.geom_hash import (
    face_geometry_hash,
    edge_geometry_hash,
    vertex_geometry_hash,
)


class TestFaceGeometryHash:
    def test_deterministic(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        assert h1 == h2
        assert h1.startswith("gface_")

    def test_different_centroid_different_hash(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([4, 2, 3], [0, 0, 1], 10.0)
        assert h1 != h2

    def test_different_normal_different_hash(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([1, 2, 3], [1, 0, 0], 10.0)
        assert h1 != h2

    def test_different_area_different_hash(self):
        h1 = face_geometry_hash([1, 2, 3], [0, 0, 1], 10.0)
        h2 = face_geometry_hash([1, 2, 3], [0, 0, 1], 20.0)
        assert h1 != h2


class TestEdgeGeometryHash:
    def test_line_deterministic(self):
        h1 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 1, 1]})
        h2 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 1, 1]})
        assert h1 == h2
        assert h1.startswith("gedge_")

    def test_line_distinct_from_arc(self):
        line_h = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]})
        arc_h = edge_geometry_hash({"kind": "arc", "center": [0.5, 0, 0], "radius": 0.5})
        assert line_h != arc_h

    def test_circle_hash(self):
        h = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        assert h.startswith("gedge_")

    def test_arc_hash(self):
        h = edge_geometry_hash({"kind": "arc", "center": [1, 2, 0], "radius": 3.0})
        assert h.startswith("gedge_")

    def test_different_radius_different_hash(self):
        h1 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        h2 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 10.0})
        assert h1 != h2

    def test_different_start_different_hash(self):
        h1 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]})
        h2 = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [2, 0, 0]})
        assert h1 != h2

    def test_spline_hash(self):
        h = edge_geometry_hash({"kind": "spline", "points": [[0, 0, 0], [1, 1, 1], [2, 2, 2]]})
        assert h.startswith("gedge_")

    def test_arc_different_spans_different_hash_deg_keys(self):
        """Arcs with same center/radius but different spans must not collide."""
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start_deg": 0.0, "angle_end_deg": 90.0,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start_deg": 0.0, "angle_end_deg": 180.0,
        })
        assert h1 != h2

    def test_arc_different_spans_different_hash_rad_keys(self):
        """Same check using radian key convention (OCC-extracted edges)."""
        import math
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start": 0.0, "angle_end": math.pi / 2,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 5.0,
            "angle_start": 0.0, "angle_end": math.pi,
        })
        assert h1 != h2

    def test_arc_identical_produces_same_hash(self):
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [1, 2, 0], "radius": 3.0,
            "angle_start_deg": 45.0, "angle_end_deg": 135.0,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [1, 2, 0], "radius": 3.0,
            "angle_start_deg": 45.0, "angle_end_deg": 135.0,
        })
        assert h1 == h2

    def test_arc_same_span_different_x_axis_different_hash(self):
        """Two semicircle arcs covering opposite halves of one circle share
        center/radius/axis and an identical [0, pi] angle span, differing only
        in x_axis direction. OCC produces exactly this when it splits a full
        circular edge into two halves; without orientation in the hash they
        collide and break selection-id uniqueness.
        """
        h1 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 9.0,
            "axis": [0, 1, 0], "x_axis": [1, 0, 0],
            "angle_start": 0.0, "angle_end": math.pi,
        })
        h2 = edge_geometry_hash({
            "kind": "arc", "center": [0, 0, 0], "radius": 9.0,
            "axis": [0, 1, 0], "x_axis": [-1, 0, 0],
            "angle_start": 0.0, "angle_end": math.pi,
        })
        assert h1 != h2

    def test_arc_same_orientation_same_hash(self):
        """Identical arcs including orientation must still hash equally."""
        edge = {
            "kind": "arc", "center": [0, 0, 0], "radius": 9.0,
            "axis": [0, 1, 0], "x_axis": [1, 0, 0],
            "angle_start": 0.0, "angle_end": math.pi,
        }
        assert edge_geometry_hash(dict(edge)) == edge_geometry_hash(dict(edge))

    def test_arc_missing_angle_keys_no_crash(self):
        """Edge dict without angle keys should not raise; defaults to 0.0."""
        h = edge_geometry_hash({"kind": "arc", "center": [0, 0, 0], "radius": 1.0})
        assert h.startswith("gedge_")

    def test_circle_unaffected_by_angle_logic(self):
        """Circles have no angle keys and should hash consistently."""
        h1 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        h2 = edge_geometry_hash({"kind": "circle", "center": [0, 0, 0], "radius": 5.0})
        assert h1 == h2

    def test_digest_length_16_chars(self):
        """Hex digest portion must be 16 characters (64 bits)."""
        h = edge_geometry_hash({"kind": "line", "start": [0, 0, 0], "end": [1, 0, 0]})
        hex_part = h.removeprefix("gedge_")
        assert len(hex_part) == 16

    def test_face_digest_length_16_chars(self):
        from oversolved.kernel.geom_hash import face_geometry_hash as fgh
        h = fgh([1, 2, 3], [0, 0, 1], 10.0)
        hex_part = h.removeprefix("gface_")
        assert len(hex_part) == 16

    def test_vertex_digest_length_16_chars(self):
        from oversolved.kernel.geom_hash import vertex_geometry_hash as vgh
        h = vgh([1.0, 2.0, 3.0])
        hex_part = h.removeprefix("gvertex_")
        assert len(hex_part) == 16


class TestVertexGeometryHash:
    def test_deterministic(self):
        h1 = vertex_geometry_hash([1.0, 2.0, 3.0])
        h2 = vertex_geometry_hash([1.0, 2.0, 3.0])
        assert h1 == h2
        assert h1.startswith("gvertex_")

    def test_different_position_different_hash(self):
        h1 = vertex_geometry_hash([1.0, 2.0, 3.0])
        h2 = vertex_geometry_hash([4.0, 2.0, 3.0])
        assert h1 != h2


class TestArcAngleNormalization:
    def test_geom_hash_arc_degree_radian_equivalence(self):
        """Arc with angle_start_deg and equivalent angle_start (radians) hash equally."""
        deg_edge = {
            "kind": "arc",
            "center": [1.0, 2.0, 0.0],
            "radius": 5.0,
            "angle_start_deg": 45.0,
            "angle_end_deg": 135.0,
        }
        rad_edge = {
            "kind": "arc",
            "center": [1.0, 2.0, 0.0],
            "radius": 5.0,
            "angle_start": math.radians(45.0),
            "angle_end": math.radians(135.0),
        }
        assert edge_geometry_hash(deg_edge) == edge_geometry_hash(rad_edge)

    def test_geom_hash_arc_prefers_deg_key_over_rad_key(self):
        """When both keys are present, degree key takes precedence."""
        both_edge = {
            "kind": "arc",
            "center": [0.0, 0.0, 0.0],
            "radius": 1.0,
            "angle_start_deg": 90.0,
            "angle_start": math.radians(45.0),  # conflicting radians key
            "angle_end_deg": 180.0,
            "angle_end": math.radians(90.0),
        }
        deg_only_edge = {
            "kind": "arc",
            "center": [0.0, 0.0, 0.0],
            "radius": 1.0,
            "angle_start_deg": 90.0,
            "angle_end_deg": 180.0,
        }
        assert edge_geometry_hash(both_edge) == edge_geometry_hash(deg_only_edge)

    def test_geom_hash_arc_missing_center_raises(self):
        """arc edge without 'center' raises ValueError instead of silently hashing."""
        edge = {"kind": "arc", "radius": 5.0, "angle_start_deg": 0.0, "angle_end_deg": 90.0}
        with pytest.raises(ValueError, match="arc edge missing geometry fields"):
            edge_geometry_hash(edge)

    def test_geom_hash_arc_missing_radius_raises(self):
        """arc edge without 'radius' raises ValueError instead of silently hashing."""
        edge = {"kind": "arc", "center": [0.0, 0.0, 0.0], "angle_start_deg": 0.0, "angle_end_deg": 90.0}
        with pytest.raises(ValueError, match="arc edge missing geometry fields"):
            edge_geometry_hash(edge)
