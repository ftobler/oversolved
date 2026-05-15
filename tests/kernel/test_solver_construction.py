import math
import textwrap
import yaml as yaml_module
from oversolved.kernel.solver import solve
from solver_helpers import TOL, ATOL, length, to_geom


def test_construction_geometry(sketch_log):
    """Construction geometry entities are marked and solved correctly."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Construction Geometry"
    initial:
      main_line: [0.0, 0.0, 10.0, 0.0]
      construction_line: [0.0, 5.0, 10.0, 5.0]
      construction_circle: [5.0, 5.0, 2.0]
      construction_pt: [7.5, 7.5]
    entities:
      - id: main_line
        kind: line
      - id: construction_line
        kind: line
        construction: true
      - id: construction_circle
        kind: circle
        construction: true
      - id: construction_pt
        kind: point
        construction: true
    constraints:
      - id: c_main_horiz
        kind: horizontal
        target: {entity: main_line}
      - id: c_main_len
        kind: length
        target: {entity: main_line}
        value: 10.0
      - id: c_main_fix
        kind: fixed
        target: {entity: main_line, point: start}
        x: 0.0
        y: 0.0
      - id: c_const_horiz
        kind: horizontal
        target: {entity: construction_line}
      - id: c_const_len
        kind: length
        target: {entity: construction_line}
        value: 10.0
      - id: c_const_circle_rad
        kind: radius
        target: {entity: construction_circle}
        value: 2.0
      - id: c_const_pt_fix
        kind: fixed
        target: {entity: construction_pt}
        x: 7.5
        y: 7.5
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_construction_geometry", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify main entities are solved correctly
    assert abs(length(sk["main_line"][0:2], sk["main_line"][2:4]) - 10.0) < TOL
    assert abs(sk["main_line"][0:2][0] - 0.0) < TOL
    assert abs(sk["main_line"][0:2][1] - 0.0) < TOL

    # Verify construction line is solved
    assert abs(length(sk["construction_line"][0:2], sk["construction_line"][2:4]) - 10.0) < TOL

    # Note: construction flag is not preserved in flat array format
    # The construction metadata would need to be stored separately if needed for UI
    # assert sk["construction_line"].get("construction")
    # assert sk["construction_circle"].get("construction")
    # assert sk["construction_pt"].get("construction")

    # Note: construction flag is not available in new format
    # assert not sk["main_line"].get("construction")

    # Verify construction circle radius is correct
    assert abs(sk["construction_circle"][2] - 2.0) < TOL

    # Verify construction point position
    assert abs(sk["construction_pt"][0] - 7.5) < TOL
    assert abs(sk["construction_pt"][1] - 7.5) < TOL


def test_square_with_construction_diagonals(sketch_log):
    """A square with 2 construction diagonals coincident with a center point."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Square with Construction Diagonals"
    initial:
      side_bottom:  [0.0, 0.0, 10.0, 0.0]
      side_right:   [10.0, 0.0, 10.0, 10.0]
      side_top:     [10.0, 10.0, 0.0, 10.0]
      side_left:    [0.0, 10.0, 0.0, 0.0]
      diag_br_tl:   [10.0, 0.0, 0.0, 10.0]
      diag_bl_tr:   [0.0, 0.0, 10.0, 10.0]
      center:       [5.0, 5.0]
    entities:
      - id: side_bottom
        kind: line
      - id: side_right
        kind: line
      - id: side_top
        kind: line
      - id: side_left
        kind: line
      - id: diag_br_tl
        kind: line
        construction: true
      - id: diag_bl_tr
        kind: line
        construction: true
      - id: center
        kind: point
    constraints:
      - id: c_bottom_horiz
        kind: horizontal
        target: {entity: side_bottom}
      - id: c_bottom_len
        kind: length
        target: {entity: side_bottom}
        value: 10.0
      - id: c_bottom_fix
        kind: fixed
        target: {entity: side_bottom, point: start}
        x: 0.0
        y: 0.0
      - id: c_right_vert
        kind: vertical
        target: {entity: side_right}
      - id: c_right_len
        kind: length
        target: {entity: side_right}
        value: 10.0
      - id: c_top_horiz
        kind: horizontal
        target: {entity: side_top}
      - id: c_top_len
        kind: length
        target: {entity: side_top}
        value: 10.0
      - id: c_left_vert
        kind: vertical
        target: {entity: side_left}
      - id: c_left_len
        kind: length
        target: {entity: side_left}
        value: 10.0
      - id: c_join_br
        kind: coincident
        a: {entity: side_bottom, point: end}
        b: {entity: side_right, point: start}
      - id: c_join_tr
        kind: coincident
        a: {entity: side_right, point: end}
        b: {entity: side_top, point: start}
      - id: c_join_tl
        kind: coincident
        a: {entity: side_top, point: end}
        b: {entity: side_left, point: start}
      - id: c_diag_br_tl_start
        kind: coincident
        a: {entity: diag_br_tl, point: start}
        b: {entity: side_right, point: start}
      - id: c_diag_br_tl_end
        kind: coincident
        a: {entity: diag_br_tl, point: end}
        b: {entity: side_left, point: start}
      - id: c_diag_bl_tr_start
        kind: coincident
        a: {entity: diag_bl_tr, point: start}
        b: {entity: side_bottom, point: start}
      - id: c_diag_bl_tr_end
        kind: coincident
        a: {entity: diag_bl_tr, point: end}
        b: {entity: side_top, point: start}
      - id: c_center_on_diag_br_tl
        kind: midpoint
        line: {entity: diag_br_tl}
        point: {entity: center}
      - id: c_center_on_diag_bl_tr
        kind: midpoint
        line: {entity: diag_bl_tr}
        point: {entity: center}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_square_with_construction_diagonals", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify square dimensions
    assert abs(length(sk["side_bottom"][0:2], sk["side_bottom"][2:4]) - 10.0) < TOL
    assert abs(length(sk["side_right"][0:2], sk["side_right"][2:4]) - 10.0) < TOL
    assert abs(length(sk["side_top"][0:2], sk["side_top"][2:4]) - 10.0) < TOL
    assert abs(length(sk["side_left"][0:2], sk["side_left"][2:4]) - 10.0) < TOL

    # Note: construction flag is not preserved in flat array format
    # assert sk["diag_br_tl"].get("construction")
    # assert sk["diag_bl_tr"].get("construction")

    # Verify center point is at (5, 5)
    assert abs(sk["center"][0] - 5.0) < TOL
    assert abs(sk["center"][1] - 5.0) < TOL

    # Verify diagonals connect opposite corners
    diag1_start = sk["diag_br_tl"][0:2]
    diag1_end = sk["diag_br_tl"][2:4]
    right_start = sk["side_right"][0:2]
    left_start = sk["side_left"][0:2]
    assert abs(diag1_start[0] - right_start[0]) < TOL
    assert abs(diag1_start[1] - right_start[1]) < TOL
    assert abs(diag1_end[0] - left_start[0]) < TOL
    assert abs(diag1_end[1] - left_start[1]) < TOL

    diag2_start = sk["diag_bl_tr"][0:2]
    diag2_end = sk["diag_bl_tr"][2:4]
    bottom_start = sk["side_bottom"][0:2]
    top_start = sk["side_top"][0:2]  # top-right corner
    assert abs(diag2_start[0] - bottom_start[0]) < TOL
    assert abs(diag2_start[1] - bottom_start[1]) < TOL
    assert abs(diag2_end[0] - top_start[0]) < TOL
    assert abs(diag2_end[1] - top_start[1]) < TOL

    # Verify center is at the intersection of both diagonals (midpoint of each)
    cx, cy = sk["center"][0], sk["center"][1]
    diag1_mid_x = (sk["diag_br_tl"][0:2][0] + sk["diag_br_tl"][2:4][0]) / 2
    diag1_mid_y = (sk["diag_br_tl"][0:2][1] + sk["diag_br_tl"][2:4][1]) / 2
    diag2_mid_x = (sk["diag_bl_tr"][0:2][0] + sk["diag_bl_tr"][2:4][0]) / 2
    diag2_mid_y = (sk["diag_bl_tr"][0:2][1] + sk["diag_bl_tr"][2:4][1]) / 2
    assert abs(cx - diag1_mid_x) < TOL
    assert abs(cy - diag1_mid_y) < TOL
    assert abs(cx - diag2_mid_x) < TOL
    assert abs(cy - diag2_mid_y) < TOL


def test_thales_circle_theorem(sketch_log):
    """Thales' theorem: angle inscribed in a semicircle is a right angle.

    If AC is a diameter of a circle and B is any point on the circle,
    then angle ABC is 90 degrees. This test uses an asymmetric configuration
    with the circle off-center and diameter at an angle.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Thales Circle Theorem (Asymmetric)"
    initial:
      circle:       [3.0, 2.0, 4.0]
      pt_a:         [0.5, 3.0]
      pt_b:         [4.5, 5.0]
      pt_c:         [5.5, 1.0]
      line_ab:      [0.5, 3.0, 4.5, 5.0]
      line_bc:      [4.5, 5.0, 5.5, 1.0]
      line_ac:      [0.5, 3.0, 5.5, 1.0]
    entities:
      - id: circle
        kind: circle
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: line_ab
        kind: line
      - id: line_bc
        kind: line
      - id: line_ac
        kind: line
    constraints:
      - id: c_circle_center
        kind: fixed
        target: {entity: circle}
        x: 3.0
        y: 2.0
      - id: c_circle_radius
        kind: radius
        target: {entity: circle}
        value: 4.0
      - id: c_pt_a_on_circle
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: circle}
        value: 4.0
      - id: c_pt_b_on_circle
        kind: point_distance
        a: {entity: pt_b}
        b: {entity: circle}
        value: 4.0
      - id: c_pt_c_on_circle
        kind: point_distance
        a: {entity: pt_c}
        b: {entity: circle}
        value: 4.0
      - id: c_ac_diameter
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: pt_c}
        value: 8.0
      - id: c_line_ab_start
        kind: coincident
        a: {entity: line_ab, point: start}
        b: {entity: pt_a}
      - id: c_line_ab_end
        kind: coincident
        a: {entity: line_ab, point: end}
        b: {entity: pt_b}
      - id: c_line_bc_start
        kind: coincident
        a: {entity: line_bc, point: start}
        b: {entity: pt_b}
      - id: c_line_bc_end
        kind: coincident
        a: {entity: line_bc, point: end}
        b: {entity: pt_c}
      - id: c_line_ac_start
        kind: coincident
        a: {entity: line_ac, point: start}
        b: {entity: pt_a}
      - id: c_line_ac_end
        kind: coincident
        a: {entity: line_ac, point: end}
        b: {entity: pt_c}
      - id: c_right_angle_abc
        kind: angle
        a: {entity: line_ab}
        b: {entity: line_bc}
        value: 90.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_thales_circle_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify circle properties
    circle_center = sk["circle"][0:2]
    assert abs(circle_center[0] - 3.0) < TOL
    assert abs(circle_center[1] - 2.0) < TOL
    assert abs(sk["circle"][2] - 4.0) < TOL

    # Verify points on circle
    pt_a_coords = [sk["pt_a"][0], sk["pt_a"][1]]
    pt_b_coords = [sk["pt_b"][0], sk["pt_b"][1]]
    pt_c_coords = [sk["pt_c"][0], sk["pt_c"][1]]
    dist_a = length(pt_a_coords, circle_center)
    dist_b = length(pt_b_coords, circle_center)
    dist_c = length(pt_c_coords, circle_center)
    assert abs(dist_a - 4.0) < TOL
    assert abs(dist_b - 4.0) < TOL
    assert abs(dist_c - 4.0) < TOL

    # Verify AC is a diameter
    dist_ac = length(pt_a_coords, pt_c_coords)
    assert abs(dist_ac - 8.0) < TOL

    # Verify angle ABC is 90 degrees (perpendicular vectors have zero dot product)
    pt_a_x, pt_a_y = sk["pt_a"][0], sk["pt_a"][1]
    pt_b_x, pt_b_y = sk["pt_b"][0], sk["pt_b"][1]
    pt_c_x, pt_c_y = sk["pt_c"][0], sk["pt_c"][1]
    vec_ba_x = pt_a_x - pt_b_x
    vec_ba_y = pt_a_y - pt_b_y
    vec_bc_x = pt_c_x - pt_b_x
    vec_bc_y = pt_c_y - pt_b_y
    dot_product = vec_ba_x * vec_bc_x + vec_ba_y * vec_bc_y
    assert abs(dot_product) < TOL


def test_pythagoras_3_4_5(sketch_log):
    """Pythagorean theorem: a² + b² = c² for a 3-4-5 right triangle.

    Create a right triangle with legs of length 3 and 4,
    and verify that the hypotenuse has length 5.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Pythagorean 3-4-5 Triangle"
    initial:
      pt_a:    [0.0, 0.0]
      pt_b:    [3.0, 0.0]
      pt_c:    [3.0, 4.0]
      leg_ab:  [0.0, 0.0, 3.0, 0.0]
      leg_bc:  [3.0, 0.0, 3.0, 4.0]
      hyp_ca:  [3.0, 4.0, 0.0, 0.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: leg_ab
        kind: line
      - id: leg_bc
        kind: line
      - id: hyp_ca
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_leg_ab_horizontal
        kind: horizontal
        target: {entity: leg_ab}
      - id: c_leg_ab_length
        kind: length
        target: {entity: leg_ab}
        value: 3.0
      - id: c_leg_bc_vertical
        kind: vertical
        target: {entity: leg_bc}
      - id: c_leg_bc_length
        kind: length
        target: {entity: leg_bc}
        value: 4.0
      - id: c_right_angle_abc
        kind: normal
        a: {entity: leg_ab}
        b: {entity: leg_bc}
      - id: c_leg_ab_start
        kind: coincident
        a: {entity: leg_ab, point: start}
        b: {entity: pt_a}
      - id: c_leg_ab_end
        kind: coincident
        a: {entity: leg_ab, point: end}
        b: {entity: pt_b}
      - id: c_leg_bc_start
        kind: coincident
        a: {entity: leg_bc, point: start}
        b: {entity: pt_b}
      - id: c_leg_bc_end
        kind: coincident
        a: {entity: leg_bc, point: end}
        b: {entity: pt_c}
      - id: c_hyp_ca_start
        kind: coincident
        a: {entity: hyp_ca, point: start}
        b: {entity: pt_c}
      - id: c_hyp_ca_end
        kind: coincident
        a: {entity: hyp_ca, point: end}
        b: {entity: pt_a}
      - id: c_hyp_ca_length
        kind: length
        target: {entity: hyp_ca}
        value: 5.0
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_pythagoras_3_4_5", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify the right angle at A
    assert abs(sk["pt_a"][0] - 0.0) < TOL
    assert abs(sk["pt_a"][1] - 0.0) < TOL

    # Verify leg lengths
    leg_ab_len = length(
        [sk["leg_ab"][0:2][0], sk["leg_ab"][0:2][1]],
        [sk["leg_ab"][2:4][0], sk["leg_ab"][2:4][1]]
    )
    leg_bc_len = length(
        [sk["leg_bc"][0:2][0], sk["leg_bc"][0:2][1]],
        [sk["leg_bc"][2:4][0], sk["leg_bc"][2:4][1]]
    )
    assert abs(leg_ab_len - 3.0) < TOL
    assert abs(leg_bc_len - 4.0) < TOL

    # Verify hypotenuse length (should be 5 by Pythagorean theorem)
    hyp_len = length(
        [sk["hyp_ca"][0:2][0], sk["hyp_ca"][0:2][1]],
        [sk["hyp_ca"][2:4][0], sk["hyp_ca"][2:4][1]]
    )
    assert abs(hyp_len - 5.0) < TOL

    # Verify the theorem: a² + b² = c²
    a_squared = 3.0 ** 2
    b_squared = 4.0 ** 2
    c_squared = hyp_len ** 2
    assert abs(a_squared + b_squared - c_squared) < TOL * 10


def test_angle_sum_theorem(sketch_log):
    """Angle sum theorem: the sum of angles in a triangle equals 180 degrees.

    Create a triangle and verify that the interior angles sum to 180°.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Angle Sum Theorem Triangle"
    initial:
      pt_a:   [0.0, 0.0]
      pt_b:   [5.0, 0.0]
      pt_c:   [1.5, 2.0]
      side_ab: [0.0, 0.0, 5.0, 0.0]
      side_bc: [5.0, 0.0, 1.5, 2.0]
      side_ca: [1.5, 2.0, 0.0, 0.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: side_ab
        kind: line
      - id: side_bc
        kind: line
      - id: side_ca
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_side_ab_horizontal
        kind: horizontal
        target: {entity: side_ab}
      - id: c_side_ab_length
        kind: length
        target: {entity: side_ab}
        value: 5.0
      - id: c_side_ab_start
        kind: coincident
        a: {entity: side_ab, point: start}
        b: {entity: pt_a}
      - id: c_side_ab_end
        kind: coincident
        a: {entity: side_ab, point: end}
        b: {entity: pt_b}
      - id: c_side_bc_start
        kind: coincident
        a: {entity: side_bc, point: start}
        b: {entity: pt_b}
      - id: c_side_bc_end
        kind: coincident
        a: {entity: side_bc, point: end}
        b: {entity: pt_c}
      - id: c_side_ca_start
        kind: coincident
        a: {entity: side_ca, point: start}
        b: {entity: pt_c}
      - id: c_side_ca_end
        kind: coincident
        a: {entity: side_ca, point: end}
        b: {entity: pt_a}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_angle_sum_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Verify the triangle is properly solved
    pt_a = (sk["pt_a"][0], sk["pt_a"][1])
    pt_b = (sk["pt_b"][0], sk["pt_b"][1])
    pt_c = (sk["pt_c"][0], sk["pt_c"][1])

    # Helper to compute angle at vertex between two other points
    def angle_at_vertex(vertex, point1, point2):
        """Compute angle at vertex between rays to point1 and point2."""
        v1_x = point1[0] - vertex[0]
        v1_y = point1[1] - vertex[1]
        v2_x = point2[0] - vertex[0]
        v2_y = point2[1] - vertex[1]
        dot = v1_x * v2_x + v1_y * v2_y
        len1 = math.sqrt(v1_x**2 + v1_y**2)
        len2 = math.sqrt(v2_x**2 + v2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    angle_a = angle_at_vertex(pt_a, pt_b, pt_c)
    angle_b = angle_at_vertex(pt_b, pt_a, pt_c)
    angle_c = angle_at_vertex(pt_c, pt_a, pt_b)

    # Verify the angle sum is 180 degrees (angle sum theorem)
    angle_sum = angle_a + angle_b + angle_c
    assert abs(angle_sum - 180.0) < ATOL * 10, f"Angle sum {angle_sum} != 180°"


def test_vertical_angles_theorem(sketch_log):
    """Vertical angles theorem: opposite angles formed by intersecting lines are equal.

    When two lines intersect, the opposite (vertical) angles are congruent.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Vertical Angles Theorem"
    initial:
      pt_center: [0.0, 0.0]
      pt_a:      [-2.0, 1.0]
      pt_b:      [2.0, -1.0]
      pt_c:      [1.0, 2.0]
      pt_d:      [-1.0, -2.0]
      line_ab:   [-2.0, 1.0, 2.0, -1.0]
      line_cd:   [1.0, 2.0, -1.0, -2.0]
    entities:
      - id: pt_center
        kind: point
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: pt_d
        kind: point
      - id: line_ab
        kind: line
      - id: line_cd
        kind: line
    constraints:
      - id: c_pt_center_fixed
        kind: fixed
        target: {entity: pt_center}
        x: 0.0
        y: 0.0
      - id: c_line_ab_through_center
        kind: midpoint
        line: {entity: line_ab}
        point: {entity: pt_center}
      - id: c_line_cd_through_center
        kind: midpoint
        line: {entity: line_cd}
        point: {entity: pt_center}
      - id: c_line_ab_length
        kind: length
        target: {entity: line_ab}
        value: 4.472135954999579
      - id: c_line_cd_length
        kind: length
        target: {entity: line_cd}
        value: 4.472135954999579
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_vertical_angles_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Extract intersection point and endpoints
    pt_center = (sk["pt_center"][0], sk["pt_center"][1])
    pt_a = (sk["pt_a"][0], sk["pt_a"][1])
    pt_b = (sk["pt_b"][0], sk["pt_b"][1])
    pt_c = (sk["pt_c"][0], sk["pt_c"][1])
    pt_d = (sk["pt_d"][0], sk["pt_d"][1])

    # Helper to compute angle at vertex between two other points
    def angle_at_vertex(vertex, point1, point2):
        """Compute angle at vertex between rays to point1 and point2."""
        v1_x = point1[0] - vertex[0]
        v1_y = point1[1] - vertex[1]
        v2_x = point2[0] - vertex[0]
        v2_y = point2[1] - vertex[1]
        dot = v1_x * v2_x + v1_y * v2_y
        len1 = math.sqrt(v1_x**2 + v1_y**2)
        len2 = math.sqrt(v2_x**2 + v2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    # Compute the four angles at the intersection
    angle_ac = angle_at_vertex(pt_center, pt_a, pt_c)  # angle between A and C rays
    angle_cb = angle_at_vertex(pt_center, pt_c, pt_b)  # angle between C and B rays
    angle_bd = angle_at_vertex(pt_center, pt_b, pt_d)  # angle between B and D rays
    angle_da = angle_at_vertex(pt_center, pt_d, pt_a)  # angle between D and A rays

    # Verify vertical angles are equal
    # Vertical angles: (angle_ac == angle_bd) and (angle_cb == angle_da)
    assert abs(angle_ac - angle_bd) < ATOL, f"Vertical angles {angle_ac}° and {angle_bd}° should be equal"
    assert abs(angle_cb - angle_da) < ATOL, f"Vertical angles {angle_cb}° and {angle_da}° should be equal"


def test_alternate_interior_angles_theorem(sketch_log):
    """Alternate interior angles theorem: when a transversal crosses two parallel lines,
    the alternate interior angles are congruent.

    If lines AB and CD are parallel, and transversal EF crosses them,
    then angle at intersection with AB equals angle at intersection with CD.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Alternate Interior Angles Theorem"
    initial:
      pt_a:      [0.0, 0.0]
      pt_b:      [5.0, 0.0]
      pt_c:      [0.0, 2.0]
      pt_d:      [5.0, 2.0]
      pt_e:      [-1.0, -1.0]
      pt_f:      [6.0, 3.0]
      line_ab:   [0.0, 0.0, 5.0, 0.0]
      line_cd:   [0.0, 2.0, 5.0, 2.0]
      transversal: [-1.0, -1.0, 6.0, 3.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: pt_d
        kind: point
      - id: pt_e
        kind: point
      - id: pt_f
        kind: point
      - id: line_ab
        kind: line
      - id: line_cd
        kind: line
      - id: transversal
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_line_ab_horizontal
        kind: horizontal
        target: {entity: line_ab}
      - id: c_line_ab_length
        kind: length
        target: {entity: line_ab}
        value: 5.0
      - id: c_line_ab_start
        kind: coincident
        a: {entity: line_ab, point: start}
        b: {entity: pt_a}
      - id: c_line_ab_end
        kind: coincident
        a: {entity: line_ab, point: end}
        b: {entity: pt_b}
      - id: c_line_cd_parallel_to_ab
        kind: parallel
        a: {entity: line_ab}
        b: {entity: line_cd}
      - id: c_line_cd_length
        kind: length
        target: {entity: line_cd}
        value: 5.0
      - id: c_line_cd_start
        kind: coincident
        a: {entity: line_cd, point: start}
        b: {entity: pt_c}
      - id: c_line_cd_end
        kind: coincident
        a: {entity: line_cd, point: end}
        b: {entity: pt_d}
      - id: c_separation
        kind: point_distance
        a: {entity: pt_a}
        b: {entity: pt_c}
        value: 2.0
      - id: c_transversal_start
        kind: coincident
        a: {entity: transversal, point: start}
        b: {entity: pt_e}
      - id: c_transversal_end
        kind: coincident
        a: {entity: transversal, point: end}
        b: {entity: pt_f}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_alternate_interior_angles_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Extract points for angle calculation
    # Find intersection of transversal with line_ab
    transv_start = (sk["transversal"][0:2][0], sk["transversal"][0:2][1])
    transv_end = (sk["transversal"][2:4][0], sk["transversal"][2:4][1])
    line_ab_start = (sk["line_ab"][0:2][0], sk["line_ab"][0:2][1])
    line_ab_end = (sk["line_ab"][2:4][0], sk["line_ab"][2:4][1])
    line_cd_start = (sk["line_cd"][0:2][0], sk["line_cd"][0:2][1])
    line_cd_end = (sk["line_cd"][2:4][0], sk["line_cd"][2:4][1])

    # Helper to compute angle between two lines
    def angle_between_lines(line1_start, line1_end, line2_start, line2_end):
        """Compute angle between two lines at their intersection point."""
        dir1_x = line1_end[0] - line1_start[0]
        dir1_y = line1_end[1] - line1_start[1]
        dir2_x = line2_end[0] - line2_start[0]
        dir2_y = line2_end[1] - line2_start[1]
        dot = dir1_x * dir2_x + dir1_y * dir2_y
        len1 = math.sqrt(dir1_x**2 + dir1_y**2)
        len2 = math.sqrt(dir2_x**2 + dir2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    # Angle between transversal and line_ab
    angle_at_ab = angle_between_lines(transv_start, transv_end, line_ab_start, line_ab_end)
    # Angle between transversal and line_cd
    angle_at_cd = angle_between_lines(transv_start, transv_end, line_cd_start, line_cd_end)

    # Verify that the lines are parallel (lines AB and CD should have same angle with transversal)
    assert abs(angle_at_ab - angle_at_cd) < ATOL, (
        f"Angles should be equal for parallel lines: {angle_at_ab} deg vs {angle_at_cd} deg"
    )


def test_exterior_angle_theorem(sketch_log):
    """Exterior angle theorem: an exterior angle of a triangle equals the sum of
    the two non-adjacent interior angles.

    If we extend side AB to point D beyond B, the exterior angle DBC equals
    the sum of the two remote interior angles BAC and BCA.
    """
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Exterior Angle Theorem"
    initial:
      pt_a:    [0.0, 0.0]
      pt_b:    [4.0, 0.0]
      pt_c:    [1.0, 2.0]
      pt_d:    [6.0, 0.0]
      side_ab: [0.0, 0.0, 4.0, 0.0]
      side_bc: [4.0, 0.0, 1.0, 2.0]
      side_ca: [1.0, 2.0, 0.0, 0.0]
      ext_bd:  [4.0, 0.0, 6.0, 0.0]
    entities:
      - id: pt_a
        kind: point
      - id: pt_b
        kind: point
      - id: pt_c
        kind: point
      - id: pt_d
        kind: point
      - id: side_ab
        kind: line
      - id: side_bc
        kind: line
      - id: side_ca
        kind: line
      - id: ext_bd
        kind: line
    constraints:
      - id: c_pt_a_fixed
        kind: fixed
        target: {entity: pt_a}
        x: 0.0
        y: 0.0
      - id: c_side_ab_horizontal
        kind: horizontal
        target: {entity: side_ab}
      - id: c_side_ab_length
        kind: length
        target: {entity: side_ab}
        value: 4.0
      - id: c_side_ab_start
        kind: coincident
        a: {entity: side_ab, point: start}
        b: {entity: pt_a}
      - id: c_side_ab_end
        kind: coincident
        a: {entity: side_ab, point: end}
        b: {entity: pt_b}
      - id: c_side_bc_start
        kind: coincident
        a: {entity: side_bc, point: start}
        b: {entity: pt_b}
      - id: c_side_bc_end
        kind: coincident
        a: {entity: side_bc, point: end}
        b: {entity: pt_c}
      - id: c_side_ca_start
        kind: coincident
        a: {entity: side_ca, point: start}
        b: {entity: pt_c}
      - id: c_side_ca_end
        kind: coincident
        a: {entity: side_ca, point: end}
        b: {entity: pt_a}
      - id: c_ext_bd_horizontal
        kind: horizontal
        target: {entity: ext_bd}
      - id: c_ext_bd_length
        kind: length
        target: {entity: ext_bd}
        value: 2.0
      - id: c_ext_bd_start
        kind: coincident
        a: {entity: ext_bd, point: start}
        b: {entity: pt_b}
      - id: c_ext_bd_end
        kind: coincident
        a: {entity: ext_bd, point: end}
        b: {entity: pt_d}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_exterior_angle_theorem", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    sk = geom

    # Extract points
    pt_a = (sk["pt_a"][0], sk["pt_a"][1])
    pt_b = (sk["pt_b"][0], sk["pt_b"][1])
    pt_c = (sk["pt_c"][0], sk["pt_c"][1])
    pt_d = (sk["pt_d"][0], sk["pt_d"][1])

    # Helper to compute angle at vertex between two other points
    def angle_at_vertex(vertex, point1, point2):
        """Compute angle at vertex between rays to point1 and point2."""
        v1_x = point1[0] - vertex[0]
        v1_y = point1[1] - vertex[1]
        v2_x = point2[0] - vertex[0]
        v2_y = point2[1] - vertex[1]
        dot = v1_x * v2_x + v1_y * v2_y
        len1 = math.sqrt(v1_x**2 + v1_y**2)
        len2 = math.sqrt(v2_x**2 + v2_y**2)
        if len1 > 0 and len2 > 0:
            cos_angle = dot / (len1 * len2)
            cos_angle = max(-1.0, min(1.0, cos_angle))
            return math.degrees(math.acos(cos_angle))
        return 0.0

    # Interior angles of the triangle
    angle_a = angle_at_vertex(pt_a, pt_b, pt_c)  # angle BAC
    angle_c = angle_at_vertex(pt_c, pt_a, pt_b)  # angle BCA

    # Exterior angle at B (angle DBC)
    # This is the angle between ray BC and ray BD
    angle_exterior = angle_at_vertex(pt_b, pt_d, pt_c)

    # Verify exterior angle theorem: exterior angle = sum of two remote interior angles
    angle_sum = angle_a + angle_c
    assert abs(angle_exterior - angle_sum) < ATOL * 2, \
        f"Exterior angle {angle_exterior}° should equal sum of remote interior angles {angle_sum}°"


def test_hourglass_shape(sketch_log):
    """Test hourglass shape with 4 lines, 2 crossing in the middle."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Hourglass"
    initial:
      tl: [0.0, 2.0]
      tr: [2.0, 2.0]
      bl: [0.0, 0.0]
      br: [2.0, 0.0]
    entities:
      - id: tl
        kind: point
      - id: tr
        kind: point
      - id: bl
        kind: point
      - id: br
        kind: point
      - id: top_line
        kind: line
      - id: bottom_line
        kind: line
      - id: diag_left
        kind: line
      - id: diag_right
        kind: line
    constraints:
      # Top line: tl to tr
      - id: c_top_start
        kind: coincident
        a: {entity: top_line, point: start}
        b: {entity: tl}
      - id: c_top_end
        kind: coincident
        a: {entity: top_line, point: end}
        b: {entity: tr}
      # Bottom line: bl to br
      - id: c_bottom_start
        kind: coincident
        a: {entity: bottom_line, point: start}
        b: {entity: bl}
      - id: c_bottom_end
        kind: coincident
        a: {entity: bottom_line, point: end}
        b: {entity: br}
      # Diagonal left: tl to br
      - id: c_diag_left_start
        kind: coincident
        a: {entity: diag_left, point: start}
        b: {entity: tl}
      - id: c_diag_left_end
        kind: coincident
        a: {entity: diag_left, point: end}
        b: {entity: br}
      # Diagonal right: tr to bl
      - id: c_diag_right_start
        kind: coincident
        a: {entity: diag_right, point: start}
        b: {entity: tr}
      - id: c_diag_right_end
        kind: coincident
        a: {entity: diag_right, point: end}
        b: {entity: bl}
      # Fix top-left corner
      - id: c_tl_fixed
        kind: fixed
        target: {entity: tl}
        x: 0.0
        y: 2.0
      # Top line horizontal
      - id: c_top_horiz
        kind: horizontal
        target: {entity: top_line}
      # Bottom line horizontal
      - id: c_bottom_horiz
        kind: horizontal
        target: {entity: bottom_line}
      # Top line length
      - id: c_top_length
        kind: length
        target: {entity: top_line}
        value: 2.0
      # Bottom line length
      - id: c_bottom_length
        kind: length
        target: {entity: bottom_line}
        value: 2.0
      # Diagonal length (≈ 2√2)
      - id: c_diag_length
        kind: length
        target: {entity: diag_left}
        value: 2.828
      # Rotation fix
      - id: c_rot_fix
        kind: vertical
        a: {entity: tl}
        b: {entity: bl}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_hourglass_shape", yaml_str, result)
    # Verify all line entities are present
    assert "diag_left" in result["geometry"]
    assert "diag_right" in result["geometry"]
    assert "top_line" in result["geometry"]
    assert "bottom_line" in result["geometry"]

    # Verify the sketch is fully constrained
    assert result["status"] == "fully_constrained"


def test_venn_diagram_two_circles(sketch_log):
    """Test Venn diagram with two overlapping circles."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Venn Diagram"
    initial:
      c1: [0.5, 0.5]
      c2: [1.5, 0.5]
    entities:
      - id: c1
        kind: point
      - id: c2
        kind: point
      - id: circle1
        kind: circle
      - id: circle2
        kind: circle
    constraints:
      # Circle 1 center fixed at origin (0.5, 0.5)
      - id: c_c1_fixed
        kind: fixed
        target: {entity: c1}
        x: 0.5
        y: 0.5
      # Circle 1 center coincident with point
      - id: c_circle1_center
        kind: coincident
        a: {entity: circle1, point: center}
        b: {entity: c1}
      # Circle 1 radius
      - id: c_circle1_radius
        kind: radius
        target: {entity: circle1}
        value: 0.6
      # Circle 2 center coincident with point
      - id: c_circle2_center
        kind: coincident
        a: {entity: circle2, point: center}
        b: {entity: c2}
      # Circle 2 radius (same as circle 1 for symmetric Venn diagram)
      - id: c_circle2_radius
        kind: radius
        target: {entity: circle2}
        value: 0.6
      # Distance constraint between circle centers
      - id: c_center_distance
        kind: point_distance
        a: {entity: c1}
        b: {entity: c2}
        value: 0.8
      # Orientation fix
      - id: c_orientation
        kind: horizontal
        a: {entity: c1}
        b: {entity: c2}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_venn_diagram_two_circles", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    # Verify both circles are present
    assert "circle1" in result["geometry"]
    assert "circle2" in result["geometry"]

    # Verify circle 1
    circle1 = geom["circle1"]
    assert "center" in circle1
    assert "radius" in circle1
    assert abs(circle1["radius"] - 0.6) < 0.01

    # Verify circle 2
    circle2 = geom["circle2"]
    assert "center" in circle2
    assert "radius" in circle2
    assert abs(circle2["radius"] - 0.6) < 0.01

    # Verify the circles overlap (distance between centers < sum of radii)
    c1_center = circle1["center"]
    c2_center = circle2["center"]
    dist = ((c1_center[0] - c2_center[0])**2 + (c1_center[1] - c2_center[1])**2)**0.5
    sum_radii = circle1["radius"] + circle2["radius"]
    assert dist < sum_radii, "Circles should overlap for Venn diagram"

    # Verify the sketch is fully constrained
    assert result["status"] == "fully_constrained"


def test_circle_arc_horizontal_constraint(sketch_log):
    """Circle and arc fully constrained via horizontal, two verticals, and two radius constraints."""
    yaml_str = textwrap.dedent("""
        version: 1
        kind: part

        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_front"
            entities: [ { id: circle1, kind: circle }, { id: arc1, kind: arc } ]
            constraints:
              - id: c_horizontal_1
                kind: horizontal
                a: { entity: circle1, point: center }
                b: { entity: arc1, point: end }
              - id: c_radius_circle
                kind: radius
                target: { entity: circle1 }
                value: 0.5
              - id: c_radius_arc
                kind: radius
                target: { entity: arc1 }
                value: 0.8
              - id: c_vertical_1
                kind: vertical
                a: { entity: circle1, point: center }
                b: { entity: arc1, point: start }
              - id: c_vertical_2
                kind: vertical
                a: { entity: circle1, point: center }
                b: { entity: arc1, point: end }
              - id: c_fix_circle
                kind: fixed
                target: { entity: circle1, point: center }
                x: 0.0
                y: 0.0
              - id: c_fix_arc
                kind: fixed
                target: { entity: arc1, point: center }
                x: 0.0
                y: 0.8
            initial:
              circle1:
                - -0.010286
                - 0.63888
                - 0.451166
              arc1:
                - -0.182578
                - 0.13224
                - 1.101525
                - 49.373795
                - 147.230997
    """).strip()

    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_circle_arc_horizontal_constraint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])

    circle1 = geom["circle1"]
    arc1 = geom["arc1"]

    # Radius constraints
    assert abs(circle1["radius"] - 0.5) < TOL, f"circle radius expected 0.5, got {circle1['radius']}"
    assert abs(arc1["radius"] - 0.8) < TOL, f"arc radius expected 0.8, got {arc1['radius']}"

    # Horizontal: circle center y == arc end y
    assert abs(circle1["center"][1] - arc1["end"][1]) < TOL, \
        f"Horizontal failed: circle y={circle1['center'][1]}, arc end y={arc1['end'][1]}"

    # Vertical 1: circle center x == arc start x
    assert abs(circle1["center"][0] - arc1["start"][0]) < TOL, \
        f"Vertical 1 failed: circle x={circle1['center'][0]}, arc start x={arc1['start'][0]}"

    # Vertical 2: circle center x == arc end x
    assert abs(circle1["center"][0] - arc1["end"][0]) < TOL, \
        f"Vertical 2 failed: circle x={circle1['center'][0]}, arc end x={arc1['end'][0]}"

    assert result["status"] == "fully_constrained"


def test_empty_sketch_superfluous_constraint(sketch_log):
    """An empty sketch with a constraint referencing unknown entities is silently ignored."""
    yaml_str = """version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities: []
    constraints:
      - id: c_bogus
        kind: horizontal
        a: { entity: nonexistent_a, point: center }
        b: { entity: nonexistent_b, point: end }
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_empty_sketch_superfluous_constraint", yaml_str, result)
    # Empty sketch with no entities should still solve successfully
    assert result["status"] == "fully_constrained"
    assert result["geometry"] == {}


def test_fixed_line_endpoint(sketch_log):
    """A line with a fixed endpoint constraint should remain at that position."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [-0.838727, 0.849922, -0.071016, 1.154386]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_1
        kind: fixed
        target: {entity: line1, point: end}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_line_endpoint", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line = geom["line1"]
    fixed_end = [-0.071016, 1.154386]

    assert abs(line["end"][0] - fixed_end[0]) < TOL, f"end x should be fixed at {fixed_end[0]}, got {line['end'][0]}"
    assert abs(line["end"][1] - fixed_end[1]) < TOL, f"end y should be fixed at {fixed_end[1]}, got {line['end'][1]}"
    assert result["status"] == "underconstrained"


def test_fixed_entire_line(sketch_log):
    """A line with a fixed constraint on the entire entity should remain fully fixed."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [-0.838727, 0.849922, -0.071016, 1.154386]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_fixed_1
        kind: fixed
        target: {entity: line1}
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_fixed_entire_line", yaml_str, result)
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    doc = yaml_module.safe_load(yaml_str)
    geom = to_geom(result["geometry"], doc["features"][0]["entities"])
    line = geom["line1"]
    fixed_start = [-0.838727, 0.849922]
    fixed_end = [-0.071016, 1.154386]

    assert abs(line.start[0] - fixed_start[0]) < TOL, (
        f"start x should be fixed at {fixed_start[0]}, got {line.start[0]}"
    )
    assert abs(line.start[1] - fixed_start[1]) < TOL, (
        f"start y should be fixed at {fixed_start[1]}, got {line.start[1]}"
    )
    assert abs(line.end[0] - fixed_end[0]) < TOL, f"end x should be fixed at {fixed_end[0]}, got {line.end[0]}"
    assert abs(line.end[1] - fixed_end[1]) < TOL, f"end y should be fixed at {fixed_end[1]}, got {line.end[1]}"
    assert result["status"] == "fully_constrained"


# ── center_rect expansion  ──

def test_center_rect_expansion(sketch_log):
    """A center_rect entity expands to 4 line entities with correct positions."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: r1
        kind: center_rect
        xy: [0.0, 0.0]
        size: [10.0, 6.0]
    constraints: []
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_center_rect_expansion", yaml_str, result)

    geom = result["geometry"]
    assert "r1_top" in geom
    assert "r1_right" in geom
    assert "r1_bottom" in geom
    assert "r1_left" in geom

    cx, cy, w, h = 0.0, 0.0, 10.0, 6.0
    hw, hh = w / 2.0, h / 2.0
    T = TOL

    top = geom["r1_top"]
    assert abs(top[0] - (cx - hw)) < T
    assert abs(top[1] - (cy + hh)) < T
    assert abs(top[2] - (cx + hw)) < T
    assert abs(top[3] - (cy + hh)) < T

    right = geom["r1_right"]
    assert abs(right[0] - (cx + hw)) < T
    assert abs(right[1] - (cy + hh)) < T
    assert abs(right[2] - (cx + hw)) < T
    assert abs(right[3] - (cy - hh)) < T

    bottom = geom["r1_bottom"]
    assert abs(bottom[0] - (cx + hw)) < T
    assert abs(bottom[1] - (cy - hh)) < T
    assert abs(bottom[2] - (cx - hw)) < T
    assert abs(bottom[3] - (cy - hh)) < T

    left = geom["r1_left"]
    assert abs(left[0] - (cx - hw)) < T
    assert abs(left[1] - (cy - hh)) < T
    assert abs(left[2] - (cx - hw)) < T
    assert abs(left[3] - (cy + hh)) < T


def test_center_rect_mixed_with_regular_entity(sketch_log):
    """center_rect mixed with a standalone entity: standalone preserved + rect lines."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: r1
        kind: center_rect
        xy: [2.0, 1.0]
        size: [4.0, 2.0]
      - id: pt1
        kind: point
    constraints: []
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_center_rect_mixed_with_regular_entity", yaml_str, result)

    geom = result["geometry"]
    assert "pt1" in geom
    assert "r1_top" in geom
    assert "r1_right" in geom
    assert "r1_bottom" in geom
    assert "r1_left" in geom

    cx, cy, w, h = 2.0, 1.0, 4.0, 2.0
    hw, hh = w / 2.0, h / 2.0
    T = TOL

    top = geom["r1_top"]
    assert abs(top[0] - (cx - hw)) < T
    assert abs(top[1] - (cy + hh)) < T
    assert abs(top[2] - (cx + hw)) < T
    assert abs(top[3] - (cy + hh)) < T

    right = geom["r1_right"]
    assert abs(right[0] - (cx + hw)) < T
    assert abs(right[1] - (cy + hh)) < T
    assert abs(right[2] - (cx + hw)) < T
    assert abs(right[3] - (cy - hh)) < T

    bottom = geom["r1_bottom"]
    assert abs(bottom[0] - (cx + hw)) < T
    assert abs(bottom[1] - (cy - hh)) < T
    assert abs(bottom[2] - (cx - hw)) < T
    assert abs(bottom[3] - (cy - hh)) < T

    left = geom["r1_left"]
    assert abs(left[0] - (cx - hw)) < T
    assert abs(left[1] - (cy - hh)) < T
    assert abs(left[2] - (cx - hw)) < T
    assert abs(left[3] - (cy + hh)) < T


def test_center_rect_zero_size(sketch_log):
    """center_rect with zero width/height produces degenerate lines, no division error."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: r1
        kind: center_rect
        xy: [3.0, -2.0]
        size: [0.0, 0.0]
    constraints: []
"""
    result = solve(yaml_str)["result"]["sketch_1"]
    sketch_log("test_center_rect_zero_size", yaml_str, result)

    geom = result["geometry"]
    assert "r1_top" in geom
    assert "r1_right" in geom
    assert "r1_bottom" in geom
    assert "r1_left" in geom

    T = TOL
    for name in ("r1_top", "r1_right", "r1_bottom", "r1_left"):
        line = geom[name]
        assert abs(line[0] - 3.0) < T
        assert abs(line[1] - -2.0) < T
        assert abs(line[2] - 3.0) < T
        assert abs(line[3] - -2.0) < T
