import numpy as np
from oversolved.builder import build
from solver_helpers import full_rect_extrude_spec


def _extrude_doc():
    """Doc with a single rect extrude: sketch sk1, extrude ex1."""
    return full_rect_extrude_spec(w=10.0, h=10.0, d=5.0)


def _face_query_from_build(r: dict) -> str | None:
    """Return the first face query from the first body in a build result."""
    for body in r.get("bodies", {}).values():
        mesh = body.get("mesh") or {}
        queries = mesh.get("face_queries") or []
        if queries:
            return queries[0]
    return None


def test_extrude_has_face_queries():
    """Extrude produces face_queries in the mesh."""
    spec = _extrude_doc()
    r = build(spec)
    assert _face_query_from_build(r) is not None, "expected face_queries in mesh"


def test_sketch_on_face_via_ancestry_query():
    """Sketch with plane set to a 3D face ancestry query resolves without error.

    The sketch should have a valid plane whose normal matches the face normal.
    """
    spec = _extrude_doc()
    r = build(spec)

    face_query = _face_query_from_build(r)
    assert face_query is not None

    # Add a second sketch whose plane is a face on the extruded body.
    sketch2 = {
        'id': 'sk2',
        'kind': 'sketch',
        'plane': face_query,
        'entities': [],
        'constraints': [],
    }
    spec2 = dict(_extrude_doc())
    spec2['features'] = list(spec2['features']) + [sketch2]

    r2 = build(spec2)
    sk2_result = r2['result'].get('sk2')
    assert sk2_result is not None, "sk2 not in result"
    assert sk2_result.get('status') not in ('exception',), (
        f"sk2 failed: {sk2_result.get('exception')}"
    )

    # Sketches expose plane_transform (rotation + origin), not a raw plane dict.
    pt = sk2_result.get('plane_transform')
    assert pt is not None, "sk2 has no plane_transform in result"
    assert 'rotation' in pt, "plane_transform missing 'rotation'"
    assert 'origin' in pt, "plane_transform missing 'origin'"

    # rotation is a flat 9-element row-major 3x3 matrix; verify it is orthonormal
    rot = np.array(pt['rotation']).reshape(3, 3)
    identity_approx = rot @ rot.T
    np.testing.assert_array_almost_equal(identity_approx, np.eye(3), decimal=5)


def test_sketch_on_face_round_trip_second_extrude():
    """Sketch on face → extrude builds without exception (round-trip)."""
    spec = _extrude_doc()
    r = build(spec)
    face_query = _face_query_from_build(r)
    assert face_query is not None

    sketch2 = {
        'id': 'sk2',
        'kind': 'sketch',
        'plane': face_query,
        'entities': [
            {'id': 'l1', 'kind': 'line'},
        ],
        'initial': {'l1': [0.0, 0.0, 2.0, 0.0]},
        'constraints': [],
    }
    extrude2 = {
        'id': 'ex2',
        'kind': 'extrude',
        'extrude': {'sketch': '$sk2', 'distance': 2.0},
    }
    spec2 = dict(_extrude_doc())
    spec2['features'] = list(spec2['features']) + [sketch2, extrude2]

    r2 = build(spec2)
    # sk2 must not be an exception
    sk2_result = r2['result'].get('sk2', {})
    assert sk2_result.get('status') != 'exception', (
        f"sk2 failed: {sk2_result.get('exception')}"
    )
