"""Tests for geometry_pack vertex arity validation."""

import pytest
from oversolved.kernel.geometry_pack import pack_geometry_update


def _make_body(vertices, faces=None):
    return {
        "mesh": {
            "vertices": vertices,
            "faces": faces or [[0, 1, 2]],
            "triangle_to_face": [0],
        }
    }


def test_pack_valid_vertices():
    """Valid 3-element vertices pack to correct buffer length."""
    verts = [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
    body = _make_body(verts)
    data = pack_geometry_update("m1", {"b1": body})
    # 3 verts * 3 floats * 4 bytes = 36 bytes for vertex section
    assert isinstance(data, bytes)
    assert len(data) > 36


def test_pack_malformed_vertex_2_elements_raises():
    """Vertex with 2 elements raises ValueError."""
    body = _make_body([[0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    with pytest.raises(ValueError, match="vertex 0 has 2 components, expected 3"):
        pack_geometry_update("m1", {"b1": body})


def test_pack_malformed_vertex_4_elements_raises():
    """Vertex with 4 elements raises ValueError."""
    body = _make_body([[0.0, 0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]])
    with pytest.raises(ValueError, match="vertex 0 has 4 components, expected 3"):
        pack_geometry_update("m1", {"b1": body})


def test_pack_malformed_vertex_index_reported():
    """The index of the first malformed vertex is reported."""
    body = _make_body([[0.0, 0.0, 0.0], [1.0, 0.0], [0.0, 1.0, 0.0]])
    with pytest.raises(ValueError, match="vertex 1 has 2 components"):
        pack_geometry_update("m1", {"b1": body})
