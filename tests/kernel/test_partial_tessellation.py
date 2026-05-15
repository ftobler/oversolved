"""Tests for partial tessellation cleanup (fix-127) and body_id consistency (fix-128)."""

import importlib
import unittest.mock as mock
import pytest

from oversolved.kernel.builder import _tessellate_body_geometry, _tessellate_bodies
from oversolved.kernel.query import _init_global_repo
from oversolved.kernel.types3d import Body

pytestmark = [
    pytest.mark.skipif(
        not importlib.util.find_spec("cadquery"), reason="cadquery not installed"
    ),
    pytest.mark.skipif(
        not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
    ),
]

_DUMMY_SHAPE = object()

_FAKE_MESH: dict = {"vertices": [], "face_data": [], "vertex_queries": [], "edge_queries": []}
_FAKE_EDGES: dict = {"edges": [], "edge_queries": []}
_FAKE_VERTS: dict = {"vertices": [], "vertex_queries": []}


def _make_body(bid: str = "body_ex1") -> Body:
    b = Body(id=bid, created_by="ex1", sketch_id="sk1")
    b.shape = _DUMMY_SHAPE  # type: ignore[assignment]
    return b


# ─── fix-127: partial tessellation cleanup ───

def test_tessellate_partial_mesh_clears_on_edge_failure():
    body = _make_body()
    with mock.patch("oversolved.kernel.geometry_tessellation.solid_to_mesh", return_value=_FAKE_MESH), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_edges", side_effect=RuntimeError("edges boom")), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_vertices", return_value=_FAKE_VERTS):
        entry = _tessellate_body_geometry(body)
    assert "mesh" not in entry, "partial mesh must be cleared on subsequent failure"
    assert "mesh_error" in entry


def test_tessellate_partial_mesh_clears_on_vertex_failure():
    body = _make_body()
    with (
        mock.patch("oversolved.kernel.geometry_tessellation.solid_to_mesh", return_value=_FAKE_MESH),
        mock.patch("oversolved.kernel.geometry_tessellation.solid_to_edges", return_value=_FAKE_EDGES),
        mock.patch("oversolved.kernel.geometry_tessellation.solid_to_vertices",
                   side_effect=RuntimeError("verts boom")),
    ):
        entry = _tessellate_body_geometry(body)
    assert "mesh" not in entry
    assert "mesh_error" in entry


def test_tessellate_full_success_has_no_mesh_error():
    body = _make_body()
    with mock.patch("oversolved.kernel.geometry_tessellation.solid_to_mesh", return_value=_FAKE_MESH), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_edges", return_value=_FAKE_EDGES), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_vertices", return_value=_FAKE_VERTS):
        entry = _tessellate_body_geometry(body)
    assert "mesh" in entry
    assert "mesh_error" not in entry


def test_tessellate_bodies_skips_partial_entry():
    """_tessellate_bodies must not call _register_brep_face_ancestry when mesh_error is set."""
    body = _make_body()
    body_store = {"body_ex1": body}
    repo = _init_global_repo()
    with mock.patch("oversolved.kernel.geometry_tessellation.solid_to_mesh", return_value=_FAKE_MESH), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_edges", side_effect=RuntimeError("boom")), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_vertices", return_value=_FAKE_VERTS), \
         mock.patch("oversolved.kernel.builder._register_brep_face_ancestry") as mock_reg:
        _tessellate_bodies(body_store, global_repo=repo)
    mock_reg.assert_not_called()


# ─── fix-128: body_id consistency in _register_body_faces ───

def test_register_body_faces_passes_body_id():
    """solid_to_mesh inside _register_body_faces must receive body_id=body.id."""
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=5, h=5, d=5)
    calls: list[dict] = []

    real_solid_to_mesh = None
    try:
        from oversolved.kernel import geometry_tessellation as _geo
        real_solid_to_mesh = _geo.solid_to_mesh
    except Exception:
        pytest.skip("geometry_tessellation module not available")

    def capturing_solid_to_mesh(shape, **kwargs):
        calls.append(dict(kwargs))
        return real_solid_to_mesh(shape, **kwargs)

    with mock.patch("oversolved.kernel.geometry_tessellation.solid_to_mesh", side_effect=capturing_solid_to_mesh):
        build(spec)

    assert calls, "solid_to_mesh was never called"
    for call_kwargs in calls:
        assert "body_id" in call_kwargs, f"solid_to_mesh called without body_id: {call_kwargs}"


def test_register_body_faces_passes_body_id_to_edges_and_vertices():
    """solid_to_edges and solid_to_vertices inside _register_body_faces must receive body_id."""
    from oversolved.kernel.builder import build
    from solver_helpers import full_rect_extrude_spec

    spec = full_rect_extrude_spec(w=5, h=5, d=5)
    edge_calls: list[dict] = []
    vert_calls: list[dict] = []

    try:
        from oversolved.kernel import geometry_tessellation as _geo
        real_edges = _geo.solid_to_edges
        real_verts = _geo.solid_to_vertices
    except Exception:
        pytest.skip("geometry_tessellation module not available")

    def cap_edges(shape, **kwargs):
        edge_calls.append(dict(kwargs))
        return real_edges(shape, **kwargs)

    def cap_verts(shape, **kwargs):
        vert_calls.append(dict(kwargs))
        return real_verts(shape, **kwargs)

    with mock.patch("oversolved.kernel.geometry_tessellation.solid_to_edges", side_effect=cap_edges), \
         mock.patch("oversolved.kernel.geometry_tessellation.solid_to_vertices", side_effect=cap_verts):
        build(spec)

    assert edge_calls, "solid_to_edges was never called"
    assert vert_calls, "solid_to_vertices was never called"
    for call_kwargs in edge_calls:
        assert "body_id" in call_kwargs, f"solid_to_edges called without body_id: {call_kwargs}"
    for call_kwargs in vert_calls:
        assert "body_id" in call_kwargs, f"solid_to_vertices called without body_id: {call_kwargs}"
