"""Regression tests for code_review #3: flatface centroid must be the area
centroid, not the average of boundary endpoints.

Endpoint averaging is only correct for symmetric profiles (circles, rectangles)
and silently wrong for asymmetric or curved boundaries. Both registration sites
(`_register_top_face` in solver_features_shared and the sketch-face flatface in
solver_registry) now share `_loop_centroid`, so the unit coverage of that helper
plus the `_register_top_face` wiring test below covers both.
"""
import importlib
import math
import pytest

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
)


# L-shape (6x6 square minus a 4x4 corner), CCW. Area centroid is (2.2, 2.2);
# the average of the vertices is (2.667, 2.667), so the two disagree clearly.
_LSHAPE = [
    {"kind": "line", "start": [0, 0], "end": [6, 0]},
    {"kind": "line", "start": [6, 0], "end": [6, 2]},
    {"kind": "line", "start": [6, 2], "end": [2, 2]},
    {"kind": "line", "start": [2, 2], "end": [2, 6]},
    {"kind": "line", "start": [2, 6], "end": [0, 6]},
    {"kind": "line", "start": [0, 6], "end": [0, 0]},
]
_LSHAPE_AREA_CENTROID = (2.2, 2.2)
_LSHAPE_VERTEX_AVG = (16 / 6, 16 / 6)  # what endpoint averaging produced


def test_loop_centroid_lshape_is_area_centroid():
    from oversolved.kernel.profile_loops import _loop_centroid

    cx, cy = _loop_centroid(_LSHAPE)
    assert cx == pytest.approx(_LSHAPE_AREA_CENTROID[0], abs=1e-6)
    assert cy == pytest.approx(_LSHAPE_AREA_CENTROID[1], abs=1e-6)
    # And it must NOT be the old endpoint/vertex average.
    assert abs(cx - _LSHAPE_VERTEX_AVG[0]) > 0.1


def test_loop_centroid_halfdisk_offset_toward_arc():
    """A half-disk's centroid is offset toward the arc by 4r/(3*pi), not at the
    diameter midpoint. This only resolves if arcs are sampled finely."""
    from oversolved.kernel.profile_loops import _loop_centroid

    r = 2.0
    loop = [
        {"kind": "line", "start": [-r, 0], "end": [r, 0]},
        {"kind": "arc", "start": [r, 0], "end": [-r, 0], "center": [0, 0],
         "radius": r, "angle_start_deg": 0, "angle_end_deg": 180, "ccw": True},
    ]
    cx, cy = _loop_centroid(loop)
    expected_cy = 4 * r / (3 * math.pi)  # ~0.8488
    assert cx == pytest.approx(0.0, abs=1e-6)
    assert cy == pytest.approx(expected_cy, abs=0.02)
    # The diameter midpoint (circle center) is y=0; the fix must move off it.
    assert cy > 0.5


def test_loop_pts_default_unchanged_for_arc():
    """Default arc sampling (1) must still yield the single midpoint, preserving
    behaviour for _loop_signed_area / _point_in_loop."""
    from oversolved.kernel.profile_loops import _loop_pts

    arc = {"kind": "arc", "start": [1, 0], "center": [0, 0], "radius": 1.0,
           "angle_start_deg": 0, "angle_end_deg": 90, "ccw": True}
    pts = _loop_pts([arc])  # default arc_samples=1
    # start + one interior (midpoint at 45 deg).
    assert len(pts) == 2
    assert pts[0] == [1, 0]
    assert pts[1][0] == pytest.approx(math.cos(math.radians(45)))
    assert pts[1][1] == pytest.approx(math.sin(math.radians(45)))


def test_register_top_face_uses_area_centroid():
    """_register_top_face must register the top face's area centroid, projected
    to world space, not the average of boundary endpoints."""
    from oversolved.kernel.query import Repository
    from oversolved.kernel.types3d import Frame3D
    from oversolved.kernel.solver_features_shared import _register_top_face

    repo = Repository()
    pt = Frame3D(origin=[0, 0, 0], x_axis=[1, 0, 0], y_axis=[0, 1, 0], normal=[0, 0, 1])
    distance = 5.0
    _register_top_face(repo, "ex1", pt, [{"boundary": _LSHAPE}], distance)

    top = repo.query("@ex1/top_face")
    assert top is not None and top["type"] == "flatface"
    cx, cy, cz = top["centroid"]
    assert cx == pytest.approx(_LSHAPE_AREA_CENTROID[0], abs=1e-6)
    assert cy == pytest.approx(_LSHAPE_AREA_CENTROID[1], abs=1e-6)
    assert cz == pytest.approx(distance, abs=1e-6)
    # Regression guard: the old endpoint-average would have put it at (2.667, 2.667).
    assert abs(cx - _LSHAPE_VERTEX_AVG[0]) > 0.1
