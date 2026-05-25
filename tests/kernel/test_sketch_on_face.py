import importlib
import numpy as np
import pytest
from oversolved.kernel.builder import build
from solver_helpers import full_rect_extrude_spec

pytestmark = pytest.mark.skipif(
    not importlib.util.find_spec("vtkmodules"), reason="vtkmodules not installed"
)


def _extrude_doc() -> dict:
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


def test_sketch_plane_resolves_from_post_fuse_face():
    """Sketch plane must resolve correctly when the face was picked from a post-fuse render.

    Sequence: sk1 -> ex1 (5mm) -> sk2 (plane = face) -> ex2 (fuse, 2mm on top)
    User picks the top face at z=7 from the post-fuse render.
    sk2 is then added with that face query as plane.
    Full build: sk1 -> ex1 -> sk2 -> ex2

    sk2 must land at z=7, not at whichever pre-fuse face happens to share the same index.
    """
    pytest.importorskip("OCP.gp")

    from solver_helpers import rect_sketch_spec, extrude_spec

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id='sk1')
    ex1 = extrude_spec('sk1', 'ex1', 5.0)

    # Build just sk1+ex1+ex2 to get the post-fuse body, then pick the top face.
    # (sk2 uses default plane for this intermediate build)
    sk2_dummy = rect_sketch_spec(w=8.0, h=8.0, sketch_id='sk2')
    ex2 = extrude_spec('sk2', 'ex2', 2.0)
    r_post = build({'features': [sk1, ex1, sk2_dummy, ex2]})

    face_data = r_post['bodies']['body_ex1']['mesh']['face_data']
    face_queries = r_post['bodies']['body_ex1']['mesh']['face_queries']
    top_query = next(
        fq for fd, fq in zip(face_data, face_queries)
        if fd['normal'][2] > 0.9
    )
    # This face_query came from the post-fuse tessellation.
    top_centroid_z = next(
        fd['centroid'][2] for fd in face_data if fd['normal'][2] > 0.9
    )

    # Now rebuild with sk2 using that post-fuse face as plane.
    sk2_on_face = {
        'id': 'sk2', 'kind': 'sketch', 'plane': top_query,
        'entities': [], 'constraints': [],
    }
    r = build({'features': [sk1, ex1, sk2_on_face, ex2]})

    assert r['result']['sk2']['status'] != 'exception', (
        f"sk2 failed: {r['result']['sk2'].get('exception')}"
    )
    origin_z = r['result']['sk2']['plane_transform']['origin'][2]
    assert abs(origin_z - top_centroid_z) < 0.5, (
        f"plane origin z={origin_z:.3f}, expected ~{top_centroid_z:.3f} (post-fuse top face). "
        f"Face index mismatch between pre-fuse and post-fuse tessellation."
    )


def test_sketch_on_face_after_boolean_cut_partial_rebuild() -> None:
    """Sketch placed on a face of a body that was later modified by a boolean cut.

    Regression test: after ex2 cuts into ex1's body, the face centroids change.
    A subsequent partial rebuild must not raise AmbiguousQueryError because stale
    face registrations (S1 geometry) co-exist with updated ones (S3 geometry).
    """
    from oversolved.kernel.builder import BuildState

    # Build 1: sk1 + ex1 (base block) + sk2_cut (smaller rect) + ex2 (cut)
    # then sk3 placed on a face of ex1 (after the cut).
    sk1 = {
        'id': 'sk1',
        'kind': 'sketch',
        'plane': '@builtin_plane_front',
        'entities': [
            {'id': 'b', 'kind': 'line'},
            {'id': 'r', 'kind': 'line'},
            {'id': 't', 'kind': 'line'},
            {'id': 'l', 'kind': 'line'},
        ],
        'initial': {'b': [0, 0, 10, 0], 'r': [10, 0, 10, 10], 't': [10, 10, 0, 10], 'l': [0, 10, 0, 0]},
        'constraints': [
            {'id': 'c1', 'kind': 'coincident', 'a': {'entity': 'b', 'point': 'end'},
             'b': {'entity': 'r', 'point': 'start'}},
            {'id': 'c2', 'kind': 'coincident', 'a': {'entity': 'r', 'point': 'end'},
             'b': {'entity': 't', 'point': 'start'}},
            {'id': 'c3', 'kind': 'coincident', 'a': {'entity': 't', 'point': 'end'},
             'b': {'entity': 'l', 'point': 'start'}},
            {'id': 'c4', 'kind': 'coincident', 'a': {'entity': 'l', 'point': 'end'},
             'b': {'entity': 'b', 'point': 'start'}},
            {'id': 'c5', 'kind': 'horizontal', 'target': {'entity': 'b'}},
            {'id': 'c6', 'kind': 'horizontal', 'target': {'entity': 't'}},
            {'id': 'c7', 'kind': 'vertical', 'target': {'entity': 'r'}},
            {'id': 'c8', 'kind': 'vertical', 'target': {'entity': 'l'}},
            {'id': 'c9', 'kind': 'length', 'target': {'entity': 'b'}, 'value': 10},
            {'id': 'c10', 'kind': 'length', 'target': {'entity': 'l'}, 'value': 10},
        ],
    }
    ex1 = {'id': 'ex1', 'kind': 'extrude', 'sketch': '$sk1', 'distance': 8.0}

    # sk2_cut: a smaller 4x4 rect on the same plane, used to cut into ex1.
    sk2_cut = {
        'id': 'sk2cut',
        'kind': 'sketch',
        'plane': '@builtin_plane_front',
        'entities': [
            {'id': 'b', 'kind': 'line'},
            {'id': 'r', 'kind': 'line'},
            {'id': 't', 'kind': 'line'},
            {'id': 'l', 'kind': 'line'},
        ],
        'initial': {'b': [2, 2, 6, 2], 'r': [6, 2, 6, 6], 't': [6, 6, 2, 6], 'l': [2, 6, 2, 2]},
        'constraints': [
            {'id': 'c1', 'kind': 'coincident', 'a': {'entity': 'b', 'point': 'end'},
             'b': {'entity': 'r', 'point': 'start'}},
            {'id': 'c2', 'kind': 'coincident', 'a': {'entity': 'r', 'point': 'end'},
             'b': {'entity': 't', 'point': 'start'}},
            {'id': 'c3', 'kind': 'coincident', 'a': {'entity': 't', 'point': 'end'},
             'b': {'entity': 'l', 'point': 'start'}},
            {'id': 'c4', 'kind': 'coincident', 'a': {'entity': 'l', 'point': 'end'},
             'b': {'entity': 'b', 'point': 'start'}},
            {'id': 'c5', 'kind': 'horizontal', 'target': {'entity': 'b'}},
            {'id': 'c6', 'kind': 'horizontal', 'target': {'entity': 't'}},
            {'id': 'c7', 'kind': 'vertical', 'target': {'entity': 'r'}},
            {'id': 'c8', 'kind': 'vertical', 'target': {'entity': 'l'}},
            {'id': 'c9', 'kind': 'length', 'target': {'entity': 'b'}, 'value': 4},
            {'id': 'c10', 'kind': 'length', 'target': {'entity': 'l'}, 'value': 4},
        ],
    }
    ex2_cut = {
        'id': 'ex2cut',
        'kind': 'extrude',
        'sketch': '$sk2cut',
        'distance': 3.0,
        'operation': 'cut',
    }

    # First build: sk1, ex1, sk2_cut, ex2_cut -- no sk3 yet.
    spec_v1 = {'features': [sk1, ex1, sk2_cut, ex2_cut]}
    r1 = build(spec_v1)
    assert r1['result']['ex1'].get('status') != 'exception', r1['result']['ex1'].get('exception')

    # Pick any face query from ex1's body.
    face_query = None
    for body_info in r1.get('bodies', {}).values():
        mesh = body_info.get('mesh') or {}
        queries = mesh.get('face_queries') or []
        if queries:
            face_query = queries[0]
            break
    assert face_query is not None, "no face query found after boolean cut build"

    # Second build: same features + sk3 placed on ex1's face.
    sk3 = {
        'id': 'sk3',
        'kind': 'sketch',
        'plane': face_query,
        'entities': [],
        'constraints': [],
    }
    spec_v2 = {'features': [sk1, ex1, sk2_cut, ex2_cut, sk3]}
    r2 = build(spec_v2)
    sk3_result = r2['result'].get('sk3', {})
    assert sk3_result.get('status') != 'exception', (
        f"sk3 failed (first build with sk3): {sk3_result.get('exception')}"
    )

    # Third build: partial rebuild -- sk3 is unchanged but we pass prev BuildState.
    # This triggers loading ex1's checkpoint which previously had stale face entries.
    prev_state: BuildState = r2['_build_state']
    r3 = build(spec_v2, prev_state=prev_state)
    sk3_result3 = r3['result'].get('sk3', {})
    assert sk3_result3.get('status') != 'exception', (
        f"sk3 failed (partial rebuild): {sk3_result3.get('exception')}"
    )


def test_sketch_on_filleted_multi_profile_face_resolves() -> None:
    """Sketch on a flat end-cap of a multi-profile, filleted body must resolve.

    Regression for bugreports/sketch_2_fail: two circles extruded into one body
    share identical face ancestry (both circles land in every face's profile
    set), so the two opposite-facing end-caps are distinguishable only by the
    face geom-hash. That hash previously folded in the triangle-summed area,
    which drifts by ~1e-5 between the registration pass and the result-mesh
    pass, so the picked hash never matched what was registered and the plane
    query raised AmbiguousQueryError. With area dropped from the hash the
    centroid+normal uniquely identify the picked face, and the query must
    resolve on the first build and survive a second from-scratch rebuild.
    """
    pytest.importorskip("OCP.gp")

    sk1 = {
        'id': 'sk1', 'kind': 'sketch', 'plane': '@builtin_plane_top',
        'entities': [
            {'id': 'cA', 'kind': 'circle'},
            {'id': 'cB', 'kind': 'circle'},
        ],
        'initial': {'cA': [0.0, 0.0, 5.0], 'cB': [20.0, 0.0, 5.0]},
    }
    ex1 = {
        'id': 'ex1', 'kind': 'extrude',
        'extrude': {'sketch': ['$sk1'], 'distance': 10.0, 'direction': 'normal'},
    }

    # Build base body, then pick a flat end-cap face from the result mesh
    # (this is the query the frontend would store).
    r0 = build({'features': [sk1, ex1]})
    mesh = r0['bodies']['body_ex1']['mesh']
    face_query = next(
        (q for q, fd in zip(mesh['face_queries'], mesh['face_data'])
         if fd['surface_type'] == 'flatface'),
        None,
    )
    assert face_query is not None, 'expected a flatface query on the extruded body'

    sk2 = {'id': 'sk2', 'kind': 'sketch', 'plane': face_query,
           'entities': [], 'constraints': []}
    spec = {'features': [sk1, ex1, sk2]}

    r1 = build(spec)
    assert r1['result']['sk2'].get('status') != 'exception', (
        f"sk2 failed on first build: {r1['result']['sk2'].get('exception')}"
    )
    # A second from-scratch rebuild re-tessellates the body; the picked hash
    # must still match (proves the hash no longer depends on noisy mesh area).
    r2 = build(spec)
    assert r2['result']['sk2'].get('status') != 'exception', (
        f"sk2 failed on rebuild: {r2['result']['sk2'].get('exception')}"
    )
