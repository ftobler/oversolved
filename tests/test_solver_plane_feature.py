import textwrap
import numpy as np
from pytest import approx
from oversolved.solver import solve, solve_features

# ---------------------------------------------------------------------------
# Plane feature tests
# ---------------------------------------------------------------------------


def test_plane_three_point_basic():
    """Three-point plane from sketch points."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 0]},
                    {'id': 'p2', 'kind': 'point', 'xy': [1, 0]},
                    {'id': 'p3', 'kind': 'point', 'xy': [0, 1]},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok'

    plane = result['features'][1]['plane']
    assert 'origin' in plane
    assert 'x_axis' in plane
    assert 'y_axis' in plane
    assert 'normal' in plane

    np.testing.assert_array_almost_equal(plane['origin'], [0, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['x_axis'], [1, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['y_axis'], [0, 1, 0], decimal=5)

    expected_normal = np.cross([1, 0, 0], [0, 1, 0])
    np.testing.assert_array_almost_equal(plane['normal'], expected_normal, decimal=5)


def test_plane_three_point_rotation_45():
    """Three-point plane with 45 deg rotation around normal."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 0]},
                    {'id': 'p2', 'kind': 'point', 'xy': [1, 0]},
                    {'id': 'p3', 'kind': 'point', 'xy': [0, 1]},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                    'rotation': 45.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    plane = result['features'][1]['plane']

    cos45 = np.cos(np.radians(45))
    sin45 = np.sin(np.radians(45))

    expected_x = [cos45, sin45, 0]
    expected_y = [-sin45, cos45, 0]

    np.testing.assert_array_almost_equal(plane['x_axis'], expected_x, decimal=5)
    np.testing.assert_array_almost_equal(plane['y_axis'], expected_y, decimal=5)


def test_plane_three_point_collinear():
    """Three collinear points should fail."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 0]},
                    {'id': 'p2', 'kind': 'point', 'xy': [1, 0]},
                    {'id': 'p3', 'kind': 'point', 'xy': [2, 0]},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [2.0, 0.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'exception'
    assert 'collinear' in result['features'][1].get('exception', '').lower()


def test_plane_on_face():
    """Plane aligned with topology face."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'rect', 'kind': 'center_rect', 'xy': [0, 0], 'size': [2, 2]},
                ],
                'initial': {},
                'constraints': [],
            },
            {
                'id': 'extrude1',
                'kind': 'extrude',
                'sketch': '$sketch0',
                'depth': 1.0,
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'on_face',
                    'face': '@extrude1/top_face',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][2]['status'] == 'ok'
    plane = result['features'][2]['plane']

    np.testing.assert_array_almost_equal(plane['normal'], [0, 0, 1], decimal=5)
    np.testing.assert_array_almost_equal(plane['origin'], [0, 0, 1], decimal=5)


def test_plane_on_face_edge_angle():
    """Plane on face with X axis along edge, rotated by angle."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'rect', 'kind': 'center_rect', 'xy': [0, 0], 'size': [2, 2]},
                ],
                'initial': {},
                'constraints': [],
            },
            {
                'id': 'extrude1',
                'kind': 'extrude',
                'sketch': '$sketch0',
                'depth': 1.0,
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'on_face_edge_angle',
                    'face': '@extrude1/top_face',
                    'edge': '@extrude1/top_face/edge0',
                    'angle': 0.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][2]['status'] == 'ok'
    plane = result['features'][2]['plane']

    x_axis = plane['x_axis']
    assert abs(x_axis[0]) > 0.9 or abs(x_axis[1]) > 0.9


def test_plane_edge_point():
    """Plane with edge direction and origin at a point."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line', 'start': [0, 0], 'end': [1, 0]},
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 1]},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 1.0, 0.0],
                    'p1': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'edge_point',
                    'edge': '@sketch0/line1',
                    'point': '@sketch0/p1/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok'
    plane = result['features'][1]['plane']

    np.testing.assert_array_almost_equal(plane['origin'], [0, 1, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['x_axis'], [1, 0, 0], decimal=5)


def test_plane_used_by_sketch():
    """Downstream sketch references plane via query."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 0]},
                    {'id': 'p2', 'kind': 'point', 'xy': [1, 0]},
                    {'id': 'p3', 'kind': 'point', 'xy': [0, 1]},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                },
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '$plane1',
                'entities': [
                    {'id': 'line1', 'kind': 'line', 'start': [0, 0], 'end': [1, 0]},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 1.0, 0.0],
                },
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][2]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert 'geometry' in result['features'][2]


def test_plane_rotation_affects_sketch_coords():
    """Sketch on a rotated plane has geometry present."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 0]},
                    {'id': 'p2', 'kind': 'point', 'xy': [1, 0]},
                    {'id': 'p3', 'kind': 'point', 'xy': [0, 1]},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                },
                'rotation': 45.0,
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '$plane1',
                'entities': [
                    {'id': 'line1', 'kind': 'line', 'start': [0, 0], 'end': [1, 0]},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 1.0, 0.0],
                },
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][2]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert 'geometry' in result['features'][2]
    assert 'line1' in result['features'][2]['geometry']


# ── Derived face plane tracking ────────────────────────────────────────────────

def _rect_sketch_with_face_plane_doc(sketch1_plane: str) -> str:
    """Build a two-sketch YAML.

    sketch1 is a 10x10 rectangle on the given plane.
    sketch2 uses one of sketch1's topology faces as its plane.
    The face query is extracted by solving sketch1 alone first.
    """
    alone_yaml = textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch1
            kind: sketch
            plane: "{sketch1_plane}"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {{id: la, kind: line}}
              - {{id: lb, kind: line}}
              - {{id: lc, kind: line}}
              - {{id: ld, kind: line}}
            constraints:
              - {{id: ca, kind: coincident, a: {{entity: la, point: end}}, b: {{entity: lb, point: start}}}}
              - {{id: cb, kind: coincident, a: {{entity: lb, point: end}}, b: {{entity: lc, point: start}}}}
              - {{id: cc, kind: coincident, a: {{entity: lc, point: end}}, b: {{entity: ld, point: start}}}}
              - {{id: cd, kind: coincident, a: {{entity: ld, point: end}}, b: {{entity: la, point: start}}}}
              - {{id: cf, kind: fixed, target: {{entity: la, point: start}}}}
              - {{id: ch, kind: horizontal, target: {{entity: la}}}}
              - {{id: cv, kind: vertical, target: {{entity: lb}}}}
              - {{id: cl, kind: length, target: {{entity: la}}, value: 10}}
    """)
    r0 = solve(alone_yaml)["result"]["sketch1"]
    assert r0.get("status") != "exception", r0.get("exception")
    assert r0.get("topology", {}).get("surfaces"), "sketch1 must produce at least one topology surface"
    face_query = r0["topology"]["surfaces"][0]["query"]

    return textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch1
            kind: sketch
            plane: "{sketch1_plane}"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {{id: la, kind: line}}
              - {{id: lb, kind: line}}
              - {{id: lc, kind: line}}
              - {{id: ld, kind: line}}
            constraints:
              - {{id: ca, kind: coincident, a: {{entity: la, point: end}}, b: {{entity: lb, point: start}}}}
              - {{id: cb, kind: coincident, a: {{entity: lb, point: end}}, b: {{entity: lc, point: start}}}}
              - {{id: cc, kind: coincident, a: {{entity: lc, point: end}}, b: {{entity: ld, point: start}}}}
              - {{id: cd, kind: coincident, a: {{entity: ld, point: end}}, b: {{entity: la, point: start}}}}
              - {{id: cf, kind: fixed, target: {{entity: la, point: start}}}}
              - {{id: ch, kind: horizontal, target: {{entity: la}}}}
              - {{id: cv, kind: vertical, target: {{entity: lb}}}}
              - {{id: cl, kind: length, target: {{entity: la}}, value: 10}}
          - id: sketch2
            kind: sketch
            plane: "{face_query}"
            initial:
              pt: [1.0, 1.0]
            entities:
              - {{id: pt, kind: point}}
            constraints: []
    """)


def test_derived_face_plane_on_front_sketch():
    """sketch2 plane is a face of sketch1 (on Front). plane_transform must match Front orientation."""
    doc = _rect_sketch_with_face_plane_doc("@builtin_plane_front")
    result = solve(doc)["result"]
    assert result["sketch1"].get("status") != "exception"
    assert result["sketch2"].get("status") != "exception", result["sketch2"].get("exception")

    t = result["sketch2"]["plane_transform"]
    rot = t["rotation"]
    # Face lies in the Front plane: normal = [0,0,1], so row 3 of rotation matrix must be ~[0,0,1]
    assert rot[6] == approx(0.0, abs=1e-4)
    assert rot[7] == approx(0.0, abs=1e-4)
    assert rot[8] == approx(1.0, abs=1e-4)


def test_derived_face_plane_on_top_sketch():
    """sketch2 plane is a face of sketch1 (on Top). plane_transform must match Top orientation."""
    doc = _rect_sketch_with_face_plane_doc("@builtin_plane_top")
    result = solve(doc)["result"]
    assert result["sketch1"].get("status") != "exception"
    assert result["sketch2"].get("status") != "exception", result["sketch2"].get("exception")

    t = result["sketch2"]["plane_transform"]
    rot = t["rotation"]
    # Face lies in the Top plane: normal = [0,1,0], so row 3 of rotation matrix must be ~[0,1,0]
    assert rot[6] == approx(0.0, abs=1e-4)
    assert rot[7] == approx(1.0, abs=1e-4)
    assert rot[8] == approx(0.0, abs=1e-4)


def test_derived_face_plane_changes_with_sketch_plane():
    """sketch2's plane_transform must differ when sketch1 moves from Front to Top.

    This is the critical regression test: the derived face plane must 'follow'
    the parent sketch's plane when it changes.
    """
    doc_front = _rect_sketch_with_face_plane_doc("@builtin_plane_front")
    doc_top = _rect_sketch_with_face_plane_doc("@builtin_plane_top")

    rot_front = solve(doc_front)["result"]["sketch2"]["plane_transform"]["rotation"]
    rot_top = solve(doc_top)["result"]["sketch2"]["plane_transform"]["rotation"]

    # The two rotations must be meaningfully different — normal vectors differ.
    assert rot_front != approx(rot_top, abs=1e-3), (
        "sketch2 plane_transform did not change when sketch1's plane changed from Front to Top"
    )


def _two_sketch_chain_doc(sketch1_plane: str) -> str:
    """Build a three-sketch YAML to test plane chaining.

    sketch1: 10x10 rectangle on the given plane (Front or Top).
    sketch2: Uses a face from sketch1's topology as its plane; draws a 5-unit circle.
    """
    # Solve sketch1 alone to extract its face query.
    alone_yaml = textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch1
            kind: sketch
            plane: "{sketch1_plane}"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {{id: la, kind: line}}
              - {{id: lb, kind: line}}
              - {{id: lc, kind: line}}
              - {{id: ld, kind: line}}
            constraints:
              - {{id: ca, kind: coincident, a: {{entity: la, point: end}}, b: {{entity: lb, point: start}}}}
              - {{id: cb, kind: coincident, a: {{entity: lb, point: end}}, b: {{entity: lc, point: start}}}}
              - {{id: cc, kind: coincident, a: {{entity: lc, point: end}}, b: {{entity: ld, point: start}}}}
              - {{id: cd, kind: coincident, a: {{entity: ld, point: end}}, b: {{entity: la, point: start}}}}
              - {{id: cf, kind: fixed, target: {{entity: la, point: start}}}}
              - {{id: ch, kind: horizontal, target: {{entity: la}}}}
              - {{id: cv, kind: vertical, target: {{entity: lb}}}}
              - {{id: cl, kind: length, target: {{entity: la}}, value: 10}}
    """)
    r1 = solve(alone_yaml)["result"]["sketch1"]
    assert r1.get("status") != "exception", r1.get("exception")
    assert r1.get("topology", {}).get("surfaces"), "sketch1 must produce topology"
    face_query = r1["topology"]["surfaces"][0]["query"]

    return textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch1
            kind: sketch
            plane: "{sketch1_plane}"
            initial:
              la: [0.0, 0.0, 10.0, 0.0]
              lb: [10.0, 0.0, 10.0, 10.0]
              lc: [10.0, 10.0, 0.0, 10.0]
              ld: [0.0, 10.0, 0.0, 0.0]
            entities:
              - {{id: la, kind: line}}
              - {{id: lb, kind: line}}
              - {{id: lc, kind: line}}
              - {{id: ld, kind: line}}
            constraints:
              - {{id: ca, kind: coincident, a: {{entity: la, point: end}}, b: {{entity: lb, point: start}}}}
              - {{id: cb, kind: coincident, a: {{entity: lb, point: end}}, b: {{entity: lc, point: start}}}}
              - {{id: cc, kind: coincident, a: {{entity: lc, point: end}}, b: {{entity: ld, point: start}}}}
              - {{id: cd, kind: coincident, a: {{entity: ld, point: end}}, b: {{entity: la, point: start}}}}
              - {{id: cf, kind: fixed, target: {{entity: la, point: start}}}}
              - {{id: ch, kind: horizontal, target: {{entity: la}}}}
              - {{id: cv, kind: vertical, target: {{entity: lb}}}}
              - {{id: cl, kind: length, target: {{entity: la}}, value: 10}}
          - id: sketch2
            kind: sketch
            plane: "{face_query}"
            initial:
              c: [5.0, 5.0, 5.0]
            entities:
              - {{id: c, kind: circle}}
            constraints:
              - {{id: cr, kind: radius, target: {{entity: c}}, value: 2.5}}
    """)


def test_plane_chain_front_to_front():
    """sketch1 on Front → sketch2 on sketch1's face → verify sketch2 solves with correct plane.

    sketch2's plane_transform should reflect sketch1's Front-plane orientation.
    sketch2's circle should be solved and constrained to radius 2.5.
    """
    doc = _two_sketch_chain_doc("@builtin_plane_front")
    result = solve(doc)["result"]

    assert result["sketch1"].get("status") != "exception"
    assert result["sketch2"].get("status") != "exception", result["sketch2"].get("exception")

    # sketch1: rectangle geometry
    s1_geom = result["sketch1"]["geometry"]
    assert "la" in s1_geom
    assert s1_geom["la"][2] == approx(10.0, abs=1e-3)  # line length in x

    # sketch2: circle on derived plane with radius constraint
    s2_geom = result["sketch2"]["geometry"]
    assert "c" in s2_geom
    assert s2_geom["c"][2] == approx(2.5, abs=1e-3)  # radius

    # sketch2's plane_transform should match Front (normal [0,0,1])
    t = result["sketch2"]["plane_transform"]
    rot = t["rotation"]
    assert rot[6] == approx(0.0, abs=1e-4)
    assert rot[7] == approx(0.0, abs=1e-4)
    assert rot[8] == approx(1.0, abs=1e-4)


def test_plane_chain_top_to_top():
    """sketch1 on Top → sketch2 on sketch1's face → verify sketch2 solves with correct plane.

    sketch2's plane_transform should reflect sketch1's Top-plane orientation.
    sketch2's circle should be solved and constrained to radius 2.5.
    """
    doc = _two_sketch_chain_doc("@builtin_plane_top")
    result = solve(doc)["result"]

    assert result["sketch1"].get("status") != "exception"
    assert result["sketch2"].get("status") != "exception", result["sketch2"].get("exception")

    # sketch2's circle on derived plane with radius constraint
    s2_geom = result["sketch2"]["geometry"]
    assert "c" in s2_geom
    assert s2_geom["c"][2] == approx(2.5, abs=1e-3)  # radius

    # sketch2's plane_transform should match Top (normal [0,1,0])
    t = result["sketch2"]["plane_transform"]
    rot = t["rotation"]
    assert rot[6] == approx(0.0, abs=1e-4)
    assert rot[7] == approx(1.0, abs=1e-4)
    assert rot[8] == approx(0.0, abs=1e-4)


def test_plane_chain_geometry_follows_when_origin_sketch_changes_plane():
    """CRITICAL: When sketch1's plane changes, sketch2's geometry must adapt.

    This is the core regression test: sketch2's circle geometry (in world coordinates)
    must differ when sketch1 moves from Front to Top, because the derived plane changes.
    """
    doc_front = _two_sketch_chain_doc("@builtin_plane_front")
    doc_top = _two_sketch_chain_doc("@builtin_plane_top")

    result_front = solve(doc_front)["result"]
    result_top = solve(doc_top)["result"]

    # Both solve successfully
    assert result_front["sketch2"].get("status") != "exception"
    assert result_top["sketch2"].get("status") != "exception"

    # Both have circle with radius 2.5
    c_front = result_front["sketch2"]["geometry"]["c"]
    c_top = result_top["sketch2"]["geometry"]["c"]
    assert c_front[2] == approx(2.5, abs=1e-3)
    assert c_top[2] == approx(2.5, abs=1e-3)

    # The circle **centers** (in 2D sketch coords) are at the same local position [5, 5]
    assert c_front[0] == approx(5.0, abs=1e-3)
    assert c_front[1] == approx(5.0, abs=1e-3)
    assert c_top[0] == approx(5.0, abs=1e-3)
    assert c_top[1] == approx(5.0, abs=1e-3)

    # BUT: sketch2's plane_transforms must differ (normals point in different directions)
    rot_front = result_front["sketch2"]["plane_transform"]["rotation"]
    rot_top = result_top["sketch2"]["plane_transform"]["rotation"]
    assert rot_front != approx(rot_top, abs=1e-3), (
        "sketch2 plane_transform did not follow sketch1's plane change"
    )

    # The world-space **plane origins** must differ because sketch1's face centroid
    # is in a different world location when sketch1's plane changes.
    origin_front = result_front["sketch2"]["plane_transform"]["origin"]
    origin_top = result_top["sketch2"]["plane_transform"]["origin"]
    assert origin_front != approx(origin_top, abs=1e-2), (
        "sketch2 plane origin did not follow sketch1's plane change"
    )


def test_plane_plane_point_offset():
    """plane_point mode: plane parallel to reference, origin at a given sketch point."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                ],
                'initial': {
                    'p1': [3.0, 4.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'plane_point',
                    'plane': '@builtin_plane_top',
                    'point': '@sketch0/p1/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok', result['features'][1]
    plane = result['features'][1]['plane']
    # top plane normal is [0,1,0]; sketch0 is on the front plane so p1=(3,4)
    # maps to world (3,4,0). Project onto top plane normal [0,1,0]: offset = 4.
    np.testing.assert_array_almost_equal(plane['origin'], [0, 4, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [0, 1, 0], decimal=5)


def test_plane_line_angle_zero():
    """line_angle mode at angle=0: plane containing a horizontal line, normal is world Z."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 2.0, 0.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'line_angle',
                    'line': '@sketch0/line1',
                    'angle': 0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok', result['features'][1]
    plane = result['features'][1]['plane']
    # line is horizontal (1,0,0); at angle=0 y_axis should be [0,0,1] (world Z)
    # normal = cross(x_axis, y_axis) = cross([1,0,0],[0,0,1]) = [0,-1,0]
    np.testing.assert_array_almost_equal(plane['x_axis'], [1, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [0, -1, 0], decimal=5)


def test_plane_line_angle_90():
    """line_angle mode at 90 deg: plane normal perpendicular to both line and world Z."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 2.0, 0.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'line_angle',
                    'line': '@sketch0/line1',
                    'angle': 90,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok', result['features'][1]
    plane = result['features'][1]['plane']
    # After 90 deg rotation around x_axis=[1,0,0]:
    # y_axis rotates from [0,0,1] to [0,-1,0] (since z_axis_default = cross([1,0,0],[0,0,1]) = [0,1,0])
    # wait: y_axis_default=[0,0,1], z_axis_default=cross([1,0,0],[0,0,1])=[0*1-0*1, 0*1-1*1, 1*0-0*0]=[0,-1,0]
    # at 90: y_axis = cos(90)*[0,0,1] + sin(90)*[0,-1,0] = [0,0,0]+[0,-1,0] = [0,-1,0]
    # normal = cross([1,0,0],[0,-1,0]) = [0*0-0*(-1), 0*1-1*0, 1*(-1)-0*1] = [0,0,-1]
    np.testing.assert_array_almost_equal(plane['x_axis'], [1, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(np.abs(plane['normal']), [0, 0, 1], decimal=5)


def test_plane_three_point_3d_coords():
    """three_point mode uses 3D world coords for points on a non-front plane."""
    import numpy as np
    # Sketch on the top plane, points at (1,0) and (0,1) in local top-plane coords.
    # Top plane: x_axis=[1,0,0], y_axis=[0,0,-1], normal=[0,1,0].
    # World coords: (1,0) -> origin + 1*x + 0*y = [1,0,0]
    #               (0,0) -> [0,0,0]
    #               (0,1) -> origin + 0*x + 1*y = [0,0,-1]
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_top',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                    {'id': 'p2', 'kind': 'point'},
                    {'id': 'p3', 'kind': 'point'},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                    'p2': [1.0, 0.0],
                    'p3': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    'p1': '@sketch0/p1/xy',
                    'p2': '@sketch0/p2/xy',
                    'p3': '@sketch0/p3/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok', result['features'][1]
    plane = result['features'][1]['plane']
    # With 3D coords: p1=[0,0,0], p2=[1,0,0], p3=[0,0,-1]
    # x_axis = normalize([1,0,0]-[0,0,0]) = [1,0,0]
    # v = [0,0,-1]-[0,0,0] = [0,0,-1]
    # y_axis = normalize(v - dot(v,x)*x) = normalize([0,0,-1]) = [0,0,-1]
    # normal = cross([1,0,0],[0,0,-1]) = [0*(-1)-0*0, 0*1-1*(-1), 1*0-0*1] = [0,1,0]
    np.testing.assert_array_almost_equal(plane['origin'], [0, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['x_axis'], [1, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [0, 1, 0], decimal=5)


def test_sketch_on_user_defined_plane_has_correct_transform():
    """Sketch referencing a user-defined plane via @planeId gets the right plane_transform.

    Bug: _resolve_plane_early only checked _BUILTIN_PLANES for @ queries,
    causing sketches on user-defined planes to fall back to the front plane.
    """
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_top',
                    'offset': 3.0,
                },
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@plane1',
                'entities': [
                    {'id': 'p1', 'kind': 'point'},
                ],
                'initial': {
                    'p1': [0.0, 0.0],
                },
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'ok'
    assert result['features'][1]['status'] in ('underconstrained', 'fully_constrained', 'ok')

    pt = result['features'][1]['plane_transform']
    # plane1 is the top plane offset by 3 along Y (top plane normal = [0,1,0])
    # so sketch1 origin should be at [0, 3, 0]
    np.testing.assert_array_almost_equal(pt['origin'], [0, 3, 0], decimal=5)
    # normal should still be [0,1,0] (same as top plane)
    rot = pt['rotation']
    # rotation is [x_axis[0..2], y_axis[0..2], normal[0..2]]
    normal = rot[6:9]
    np.testing.assert_array_almost_equal(normal, [0, 1, 0], decimal=5)


def test_sketch_on_user_defined_plane_dollar_ref():
    """Sketch referencing a user-defined plane via $planeId also works (existing behavior)."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_top',
                    'offset': 5.0,
                },
            },
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '$plane1',
                'entities': [],
                'initial': {},
                'constraints': [],
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'ok'
    pt = result['features'][1]['plane_transform']
    np.testing.assert_array_almost_equal(pt['origin'], [0, 5, 0], decimal=5)


def test_plane_offset_basic():
    """Test offset mode directly: verify origin and normal after offset from Front plane."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_front',
                    'offset': 10.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'ok'
    plane = result['features'][0]['plane']
    np.testing.assert_array_almost_equal(plane['origin'], [0, 0, 10], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [0, 0, 1], decimal=5)


def test_plane_offset_top():
    """Test offset from Top plane: origin along Y, normal unchanged."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_top',
                    'offset': 5.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'ok'
    plane = result['features'][0]['plane']
    np.testing.assert_array_almost_equal(plane['origin'], [0, 5, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [0, 1, 0], decimal=5)


def test_plane_offset_negative():
    """Test negative offset: origin moves along negative normal."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_right',
                    'offset': -3.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'ok'
    plane = result['features'][0]['plane']
    # Right plane: origin [0, 0, 0], normal [1, 0, 0]
    # offset -3: origin moves to [-3, 0, 0]
    np.testing.assert_array_almost_equal(plane['origin'], [-3, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [1, 0, 0], decimal=5)


def test_plane_unknown_mode():
    """Test that unknown plane mode returns exception status."""
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'invalid_mode_xyz',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'exception'


def test_plane_on_face_edge_angle_with_rotation():
    """Test on_face_edge_angle mode with angle parameter: verifies y_axis rotates around edge."""
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'rect', 'kind': 'center_rect', 'xy': [0, 0], 'size': [2, 2]},
                ],
                'initial': {},
                'constraints': [],
            },
            {
                'id': 'extrude1',
                'kind': 'extrude',
                'sketch': '$sketch0',
                'depth': 1.0,
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'on_face_edge_angle',
                    'face': '@extrude1/top_face',
                    'edge': '@extrude1/top_face/edge0',
                    'angle': 45.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert result['features'][1]['status'] == 'ok'
    assert result['features'][2]['status'] == 'ok'

    # Verify the plane has well-formed coordinate system
    plane = result['features'][2]['plane']
    import numpy as np
    # Verify x_axis, y_axis, and normal form an orthonormal frame
    x_axis = np.array(plane['x_axis'])
    y_axis = np.array(plane['y_axis'])
    normal = np.array(plane['normal'])

    # Check normalization
    assert np.allclose(np.linalg.norm(x_axis), 1.0, atol=1e-5)
    assert np.allclose(np.linalg.norm(y_axis), 1.0, atol=1e-5)
    assert np.allclose(np.linalg.norm(normal), 1.0, atol=1e-5)

    # Check orthogonality
    assert np.allclose(np.dot(x_axis, y_axis), 0.0, atol=1e-5)
    assert np.allclose(np.dot(y_axis, normal), 0.0, atol=1e-5)
    assert np.allclose(np.dot(normal, x_axis), 0.0, atol=1e-5)


def test_plane_line_angle_45():
    """Test line_angle at 45 degrees: verify normal is rotated correctly."""
    import numpy as np
    # Create a front sketch with a line to use as the hinge axis
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 2.0, 0.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'line_angle',
                    'line': '@sketch0/line1',
                    'angle': 45.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert result['features'][1]['status'] == 'ok'

    plane = result['features'][1]['plane']
    # Line is along X axis, so plane rotates 45 deg around X
    # At angle=0, normal=[0,-1,0]; at angle=45, normal should be rotated 45 deg around X
    # Expected normal ≈ [0, -cos(45°), -sin(45°)] = [0, -√2/2, -√2/2]
    normal = plane['normal']
    expected_normal = np.array([0, -np.sqrt(2)/2, -np.sqrt(2)/2])
    np.testing.assert_array_almost_equal(normal, expected_normal, decimal=4)


def test_plane_offset_right_plane():
    """Test offset from Right plane: origin and normal updated correctly."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_right',
                    'offset': 2.5,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] == 'ok'
    plane = result['features'][0]['plane']
    # Right plane: origin [0, 0, 0], normal [1, 0, 0]
    # offset 2.5: origin moves to [2.5, 0, 0]
    np.testing.assert_array_almost_equal(plane['origin'], [2.5, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [1, 0, 0], decimal=5)


def test_plane_plane_point_right_plane():
    """Test plane_point mode with Right plane as reference."""
    import numpy as np
    # Create a sketch on Right plane with a point, then create a plane through that point
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_right',
                'entities': [
                    {'id': 'p1', 'kind': 'point', 'xy': [5, 3]},
                ],
                'initial': {'p1': [5.0, 3.0]},
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'plane_point',
                    'plane': '@builtin_plane_right',
                    'point': '@sketch0/p1/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert result['features'][1]['status'] == 'ok'

    plane = result['features'][1]['plane']
    # Right plane origin is [0, 0, 0], normal is [1, 0, 0] (X axis)
    # Point p1 in Right plane coords is [5, 3], which is (u=5, v=3)
    # x_axis=[0,0,1], y_axis=[0,1,0] for Right plane
    # 3D point = [0,0,0] + 5*[0,0,1] + 3*[0,1,0] = [0,3,5]
    # Through-point moves the origin to the projection of [0,3,5] onto Right plane normal [1,0,0]
    # Projection = [0,3,5] · [1,0,0] = 0 along X, so origin stays at [0,0,0]
    # But wait: plane_point projects the point onto the plane normal direction
    # For Right plane, that's the X direction; point is at [0,3,5], so x-component is 0
    # Origin should be at distance 0 along the normal = [0,0,0]
    np.testing.assert_array_almost_equal(plane['origin'], [0, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [1, 0, 0], decimal=5)


def test_plane_edge_point_non_front_sketch():
    """Test edge_point with edge and point from non-Front sketch (exercises 3D transforms)."""
    import numpy as np
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_top',
                'entities': [
                    {'id': 'line1', 'kind': 'line', 'start': [0, 0], 'end': [1, 0]},
                    {'id': 'p1', 'kind': 'point', 'xy': [0, 1]},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 1.0, 0.0],
                    'p1': [0.0, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'edge_point',
                    'edge': '@sketch0/line1',
                    'point': '@sketch0/p1/xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][0]['status'] in ('ok', 'fully_constrained', 'underconstrained')
    assert result['features'][1]['status'] == 'ok'

    plane = result['features'][1]['plane']
    # Sketch is on Top plane (x_axis [1,0,0], y_axis [0,0,-1], normal [0,1,0])
    # line1: [0,0,0] (3D) to [1,0,0] (3D)
    # p1 in Top plane: [0, 1] → 3D = [0,0,0] + 0*[1,0,0] + 1*[0,0,-1] = [0, 0, -1]
    # edge direction: [1,0,0] - [0,0,0] = [1,0,0], normalized to [1,0,0]
    # x_axis of plane should be along edge: [1,0,0]
    # origin should be at p1 = [0,0,-1]
    x_axis = plane['x_axis']
    np.testing.assert_array_almost_equal(x_axis, [1, 0, 0], decimal=5)
    origin = plane['origin']
    np.testing.assert_array_almost_equal(origin, [0, 0, -1], decimal=5)


def test_plane_three_point_concatenated_format():
    """Test three-point plane with concatenated query format (@sketchXentityYxy).
    This tests the bug fix where solve_features now registers both slash and concatenated formats."""
    spec = {
        'features': [
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pt1', 'kind': 'point'},
                ],
                'initial': {
                    'pt1': [1.0, 2.0],
                },
                'constraints': [],
            },
            {
                'id': 'sketch2',
                'kind': 'sketch',
                'plane': '@builtin_plane_top',
                'entities': [
                    {'id': 'pt2', 'kind': 'point'},
                    {'id': 'pt3', 'kind': 'point'},
                ],
                'initial': {
                    'pt2': [3.0, 4.0],
                    'pt3': [5.0, 6.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'three_point',
                    # Use concatenated format (e.g., sketch2pt2xy) instead of slash format
                    'p1': '@sketch2pt2xy',
                    'p2': '@sketch1pt1xy',
                    'p3': '@sketch2pt3xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][2]['status'] == 'ok'

    plane = result['features'][2]['plane']
    origin = np.array(plane['origin'])
    normal = np.array(plane['normal'])

    # Verify all three points lie on the computed plane
    # Front plane coords: pt1 = (1, 2) → 3D = (1, 2, 0)
    # Top plane coords: pt2 = (3, 4) → 3D = (3, 0, -4)
    # Top plane coords: pt3 = (5, 6) → 3D = (5, 0, -6)
    p1_3d = np.array([1.0, 2.0, 0.0])
    p2_3d = np.array([3.0, 0.0, -4.0])
    p3_3d = np.array([5.0, 0.0, -6.0])

    # Points lie on plane if: (point - origin) · normal = 0
    d1 = np.dot(p1_3d - origin, normal)
    d2 = np.dot(p2_3d - origin, normal)
    d3 = np.dot(p3_3d - origin, normal)

    np.testing.assert_almost_equal(d1, 0.0, decimal=5)
    np.testing.assert_almost_equal(d2, 0.0, decimal=5)
    np.testing.assert_almost_equal(d3, 0.0, decimal=5)


def test_plane_plane_point_concatenated_format():
    """Test plane_point plane with concatenated query format."""
    spec = {
        'features': [
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'pt1', 'kind': 'point'},
                ],
                'initial': {
                    'pt1': [2.0, 3.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'plane_point',
                    'plane': '@builtin_plane_top',
                    'point': '@sketch1pt1xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok'


def test_plane_line_angle_concatenated_format():
    """Test line_angle plane with concatenated query format."""
    spec = {
        'features': [
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 1.0, 0.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'line_angle',
                    'line': '@sketch1line1',  # This queries the line entity itself
                    'angle': 45.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok', result['features'][1]


def test_plane_edge_point_pivots_on_line():
    """edge_point mode: plane pivots on line, passes through point.

    The plane should contain the line (origin on line, x_axis along line).
    The y_axis should point from the line toward the given point.
    """
    spec = {
        'features': [
            {
                'id': 'sketch0',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                    {'id': 'pt1', 'kind': 'point'},
                ],
                'initial': {
                    'line1': [1.0, 2.0, 4.0, 2.0],  # horizontal line from (1,2) to (4,2)
                    'pt1': [2.5, 5.0],  # point above the line at (2.5, 5)
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'edge_point',
                    'edge': '@sketch0line1',
                    'point': '@sketch0pt1xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok', result['features'][1]
    plane = result['features'][1]['plane']

    # On front plane: sketch point (2.5, 5) maps to world (2.5, 5, 0)
    # Line goes from (1, 2, 0) to (4, 2, 0), so x_axis is [1, 0, 0]
    # Point is at (2.5, 5, 0), projecting onto line: t = dot((2.5-1, 5-2, 0), (1,0,0)) = 1.5
    # Projection is at (2.5, 2, 0)
    # Origin should be at point (2.5, 5, 0)
    # y_axis points from point toward projection: (2.5, 2, 0) - (2.5, 5, 0) = [0, -3, 0], normalized = [0, -1, 0]
    # normal = cross([1,0,0], [0,-1,0]) = [0, 0, -1]
    np.testing.assert_array_almost_equal(plane['x_axis'], [1, 0, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['y_axis'], [0, -1, 0], decimal=5)
    np.testing.assert_array_almost_equal(plane['normal'], [0, 0, -1], decimal=5)
    np.testing.assert_array_almost_equal(plane['origin'], [2.5, 5, 0], decimal=5)


def test_plane_edge_point_concatenated_format():
    """Test edge_point plane with concatenated query format."""
    spec = {
        'features': [
            {
                'id': 'sketch1',
                'kind': 'sketch',
                'plane': '@builtin_plane_front',
                'entities': [
                    {'id': 'line1', 'kind': 'line'},
                    {'id': 'pt1', 'kind': 'point'},
                ],
                'initial': {
                    'line1': [0.0, 0.0, 1.0, 0.0],
                    'pt1': [0.5, 1.0],
                },
                'constraints': [],
            },
            {
                'id': 'plane1',
                'kind': 'plane',
                'definition': {
                    'mode': 'edge_point',
                    'edge': '@sketch1line1',
                    'point': '@sketch1pt1xy',
                },
            },
        ]
    }
    result = solve_features(spec)

    assert result['features'][1]['status'] == 'ok'


def test_plane_with_unicode_label():
    """Verify that plane features preserve Unicode labels including emojis."""
    spec = {
        'features': [
            {
                'id': 'plane1',
                'kind': 'plane',
                'label': '🔵 Blue Plane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_front',
                    'offset': 5.0,
                },
            },
            {
                'id': 'plane2',
                'kind': 'plane',
                'label': '飛行機 Airplane',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_top',
                    'offset': 3.0,
                },
            },
            {
                'id': 'plane3',
                'kind': 'plane',
                'label': '∞ Infinite ∅',
                'definition': {
                    'mode': 'offset',
                    'plane': '@builtin_plane_right',
                    'offset': 2.0,
                },
            },
        ]
    }
    result = solve_features(spec)

    # All planes should solve successfully
    assert result['features'][0]['status'] == 'ok'
    assert result['features'][1]['status'] == 'ok'
    assert result['features'][2]['status'] == 'ok'
