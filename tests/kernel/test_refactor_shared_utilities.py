"""Tests for shared utility functions extracted in feature 105."""

import importlib
import math
import pytest

ocp_installed = importlib.util.find_spec("OCP") is not None
requires_ocp = pytest.mark.skipif(not ocp_installed, reason="OCP not installed")


def test_triangle_area_right_triangle():
    from oversolved.kernel.cadquery_ops import _triangle_area
    p0 = [0.0, 0.0, 0.0]
    p1 = [3.0, 0.0, 0.0]
    p2 = [0.0, 4.0, 0.0]
    assert abs(_triangle_area(p0, p1, p2) - 6.0) < 1e-10


def test_triangle_area_degenerate():
    from oversolved.kernel.cadquery_ops import _triangle_area
    p0 = [1.0, 1.0, 1.0]
    p1 = [2.0, 2.0, 2.0]
    p2 = [3.0, 3.0, 3.0]
    assert _triangle_area(p0, p1, p2) == 0.0


def test_normal_to_frame_z_aligned():
    from oversolved.kernel.cadquery_ops import _normal_to_frame
    x, y = _normal_to_frame([0.0, 0.0, 1.0])
    # x and y must be orthogonal to each other and to normal.
    dot_xy = sum(xi * yi for xi, yi in zip(x, y))
    dot_xn = sum(xi * ni for xi, ni in zip(x, [0.0, 0.0, 1.0]))
    dot_yn = sum(yi * ni for yi, ni in zip(y, [0.0, 0.0, 1.0]))
    assert abs(dot_xy) < 1e-10
    assert abs(dot_xn) < 1e-10
    assert abs(dot_yn) < 1e-10
    # Must be unit vectors.
    assert abs(sum(xi * xi for xi in x) - 1.0) < 1e-10
    assert abs(sum(yi * yi for yi in y) - 1.0) < 1e-10


def test_normal_to_frame_x_aligned():
    from oversolved.kernel.cadquery_ops import _normal_to_frame
    x, y = _normal_to_frame([1.0, 0.0, 0.0])
    dot_xn = sum(xi * ni for xi, ni in zip(x, [1.0, 0.0, 0.0]))
    dot_yn = sum(yi * ni for yi, ni in zip(y, [1.0, 0.0, 0.0]))
    assert abs(dot_xn) < 1e-10
    assert abs(dot_yn) < 1e-10
    assert abs(sum(xi * xi for xi in x) - 1.0) < 1e-10


def test_normal_to_frame_arbitrary():
    from oversolved.kernel.cadquery_ops import _normal_to_frame
    n = [1 / math.sqrt(3)] * 3
    x, y = _normal_to_frame(n)
    dot_xn = sum(x[i] * n[i] for i in range(3))
    dot_yn = sum(y[i] * n[i] for i in range(3))
    assert abs(dot_xn) < 1e-10
    assert abs(dot_yn) < 1e-10


def test_normal_to_frame_consistent_with_face_plane_axes():
    """_normal_to_frame produces same result as the old _face_plane_axes logic."""
    import math as m
    from oversolved.kernel.cadquery_ops import _normal_to_frame

    def _face_plane_axes_ref(normal):
        nx, ny, nz = normal
        if abs(nz) < 0.9:
            ax, ay, az = 0.0, 0.0, 1.0
        else:
            ax, ay, az = 1.0, 0.0, 0.0
        cx = ny * az - nz * ay
        cy = nz * ax - nx * az
        cz = nx * ay - ny * ax
        mag = m.sqrt(cx * cx + cy * cy + cz * cz)
        if mag > 1e-12:
            cx, cy, cz = cx / mag, cy / mag, cz / mag
        else:
            cx, cy, cz = 1.0, 0.0, 0.0
        yx = ny * cz - nz * cy
        yy = nz * cx - nx * cz
        yz = nx * cy - ny * cx
        return [cx, cy, cz], [yx, yy, yz]

    for n in ([0.0, 0.0, 1.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0],
              [1 / m.sqrt(2), 0.0, 1 / m.sqrt(2)]):
        x_ref, y_ref = _face_plane_axes_ref(n)
        x, y = _normal_to_frame(n)
        for i in range(3):
            assert abs(x[i] - x_ref[i]) < 1e-10
            assert abs(y[i] - y_ref[i]) < 1e-10


def test_face_sort_key_from_tuple_flat_before_curved():
    from oversolved.kernel.cadquery_ops import _face_sort_key_from_tuple
    flat = (None, None, None, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], "flatface")
    curved = (None, None, None, [0.0, 0.0, 0.0], [0.0, 0.0, 1.0], "cylinderface")
    assert _face_sort_key_from_tuple(flat) < _face_sort_key_from_tuple(curved)


def test_face_sort_key_from_tuple_determinism():
    from oversolved.kernel.cadquery_ops import _face_sort_key_from_tuple
    a = (None, None, None, [1.0, 2.0, 3.0], [0.0, 0.0, 1.0], "flatface")
    b = (None, None, None, [4.0, 5.0, 6.0], [0.0, 0.0, 1.0], "flatface")
    assert _face_sort_key_from_tuple(a) != _face_sort_key_from_tuple(b)


def test_init_global_repo_from_query():
    """_init_global_repo is importable from query module."""
    from oversolved.kernel.query import _init_global_repo
    repo = _init_global_repo()
    result = repo.query("@builtin_plane_front", body_store={})
    assert result is not None
    assert "normal" in result


def test_init_global_repo_still_importable_from_solver():
    """_init_global_repo re-export from solver.py still works for backward compat."""
    from oversolved.kernel.solver import _init_global_repo
    repo = _init_global_repo()
    result = repo.query("@builtin_plane_top", body_store={})
    assert result is not None


def test_resolve_body_error_message_no_longer_says_boolean():
    """_resolve_body error no longer says 'boolean: body not found'."""
    from oversolved.kernel.solver_features import _resolve_body
    with pytest.raises(ValueError) as exc_info:
        _resolve_body("nonexistent", {})
    assert "boolean" not in str(exc_info.value)
    assert "nonexistent" in str(exc_info.value)


@requires_ocp
def test_face_sort_key_matches_face_sort_key_from_tuple():
    """_face_sort_key and _face_sort_key_from_tuple produce same ordering on a real box."""
    from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox
    from cadquery.occ_impl.shapes import Shape
    from oversolved.kernel.cadquery_ops import (
        _face_sort_key, _face_sort_key_from_tuple,
        _compute_face_centroid, _compute_face_normal, _get_face_surface_type,
    )
    from OCP.BRepMesh import BRepMesh_IncrementalMesh

    occ_box = BRepPrimAPI_MakeBox(5.0, 5.0, 5.0).Shape()
    box = Shape.cast(occ_box)
    BRepMesh_IncrementalMesh(occ_box, 0.1, False, 0.1)

    faces = list(box.faces())
    by_raw = sorted(faces, key=_face_sort_key)

    raw_items = []
    for f in faces:
        verts, idxs = f.tessellate(0.1)
        c = _compute_face_centroid(f)
        n = _compute_face_normal(f)
        s = _get_face_surface_type(f)
        raw_items.append((f, list(verts), list(idxs), c, n, s))
    by_tuple = sorted(raw_items, key=_face_sort_key_from_tuple)

    # Same ordering: the centroids should match in sequence.
    for f_raw, item_tuple in zip(by_raw, by_tuple):
        c_raw = _compute_face_centroid(f_raw)
        c_tuple = item_tuple[3]
        for i in range(3):
            assert abs(c_raw[i] - c_tuple[i]) < 1e-6
