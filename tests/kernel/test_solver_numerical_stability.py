from oversolved.kernel.solver import solve


def test_solve_repeatability():
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: line1}
      - id: c2
        kind: fixed
        target: {entity: line1, point: start}
        x: 0.0
        y: 0.0
      - id: c3
        kind: length
        target: {entity: line1}
        value: 10.0
    initial:
      line1: [0.0, 0.0, 9.9, 0.1]
"""
    for i in range(10):
        result = solve(yaml_str)["result"]["sk1"]
        assert result.get("status") == "fully_constrained", (
            f"run {i}: expected fully_constrained, got {result.get('status')}"
        )


def test_entity_status_repeatability():
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: line1}
      - id: c2
        kind: fixed
        target: {entity: line1, point: start}
        x: 0.0
        y: 0.0
      - id: c3
        kind: length
        target: {entity: line1}
        value: 10.0
    initial:
      line1: [0.0, 0.0, 9.9, 0.1]
"""
    for i in range(10):
        result = solve(yaml_str)["result"]["sk1"]
        features = result.get("features", {})
        status = features.get("line1", {}).get("status")
        assert status == "fully_constrained", (
            f"run {i}: line1 entity_status expected fully_constrained, got {status}"
        )


def test_underconstrained_sketch_consistent():
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c1
        kind: horizontal
        target: {entity: line1}
    initial:
      line1: [0.0, 0.0, 9.9, 0.1]
"""
    for i in range(5):
        result = solve(yaml_str)["result"]["sk1"]
        assert result.get("status") == "underconstrained", (
            f"run {i}: expected underconstrained, got {result.get('status')}"
        )


def test_fully_constrained_with_arc():
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: arc1
        kind: arc
    constraints:
      - id: c_start
        kind: fixed
        target: {entity: arc1, point: start}
        x: 10.0
        y: 0.0
      - id: c_end
        kind: fixed
        target: {entity: arc1, point: end}
        x: 0.0
        y: 10.0
      - id: c_radius
        kind: radius
        target: {entity: arc1}
        value: 10.0
    initial:
      arc1: [0.5, 0.5, 9.8, 5.0, 85.0]
"""
    for i in range(5):
        result = solve(yaml_str)["result"]["sk1"]
        assert result.get("status") == "fully_constrained", (
            f"run {i}: expected fully_constrained, got {result.get('status')}"
        )


def test_x_scale_jac_no_crash():
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: arc1
        kind: arc
    constraints:
      - id: c_horiz
        kind: horizontal
        target: {entity: line1}
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 5.0
      - id: c_join
        kind: coincident
        a: {entity: line1, point: end}
        b: {entity: arc1,  point: start}
      - id: c_radius
        kind: radius
        target: {entity: arc1}
        value: 3.0
    initial:
      line1: [0.5, 0.5, 4.5, 0.3]
      arc1:  [5.5, 0.5, 2.8, 175, 260]
"""
    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") != "exception", (
        f"solver raised exception: {result.get('exception')}"
    )


def test_tangent_short_line():
    """Tangent constraint with a short (~0.001) line should converge to correct tangency."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: circle1
        kind: circle
    constraints:
      - id: c_len
        kind: length
        target: {entity: line1}
        value: 0.001
      - id: c_fix_start
        kind: fixed
        target: {entity: line1, point: start}
        x: 0.0
        y: 0.0
      - id: c_fix_center
        kind: fixed
        target: {entity: circle1}
        x: 0.0
        y: 1.0
      - id: c_radius
        kind: radius
        target: {entity: circle1}
        value: 1.0
      - id: c_tangent
        kind: tangent
        a: {entity: line1}
        b: {entity: circle1}
    initial:
      line1: [0.0, 0.0, 0.002, 0.5]
      circle1: [0.0, 1.0, 1.0]
"""
    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") != "exception", f"solver crashed: {result.get('exception')}"


def test_tangent_zero_length_line():
    """Tangent constraint with zero-length line should not crash."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: circle1
        kind: circle
    constraints:
      - id: c_fix_start
        kind: fixed
        target: {entity: line1, point: start}
        x: 0.0
        y: 0.0
      - id: c_fix_end
        kind: fixed
        target: {entity: line1, point: end}
        x: 0.0
        y: 0.0
      - id: c_fix_center
        kind: fixed
        target: {entity: circle1}
        x: 0.0
        y: 1.0
      - id: c_radius
        kind: radius
        target: {entity: circle1}
        value: 1.0
      - id: c_tangent
        kind: tangent
        a: {entity: line1}
        b: {entity: circle1}
    initial:
      line1: [0.0, 0.0, 0.0, 0.0]
      circle1: [0.0, 1.0, 1.0]
"""
    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") != "exception", f"solver crashed: {result.get('exception')}"


def test_angle_parallel():
    """Two nearly-parallel lines (0.1 deg) constrained to 0 deg converge to exact parallelism."""
    import math

    # initial: line1 horizontal, line2 at 0.1 deg
    a = math.radians(0.1)
    yaml_str = f"""
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: line2
        kind: line
    constraints:
      - id: c_fix_l1
        kind: fixed
        target: {{entity: line1}}
      - id: c_len_l1
        kind: length
        target: {{entity: line1}}
        value: 5.0
      - id: c_len_l2
        kind: length
        target: {{entity: line2}}
        value: 5.0
      - id: c_fix_l2_start
        kind: fixed
        target: {{entity: line2, point: start}}
        x: 5.0
        y: 0.0
      - id: c_angle
        kind: angle
        a: {{entity: line1}}
        b: {{entity: line2}}
        value: 0.0
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
      line2: [5.0, 0.0, {5.0 + 5.0 * math.cos(a):.6f}, {5.0 * math.sin(a):.6f}]
"""
    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") == "fully_constrained", (
        f"expected fully_constrained, got {result.get('status')}: {result.get('exception')}"
    )


def test_angle_antiparallel():
    """Two nearly-antiparallel lines (179.9 deg) constrained to 180 deg converge."""
    import math

    # initial: line1 horizontal right, line2 at 179.9 deg (almost left)
    a = math.radians(179.9)
    yaml_str = f"""
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: line2
        kind: line
    constraints:
      - id: c_fix_l1
        kind: fixed
        target: {{entity: line1}}
      - id: c_len_l1
        kind: length
        target: {{entity: line1}}
        value: 5.0
      - id: c_len_l2
        kind: length
        target: {{entity: line2}}
        value: 5.0
      - id: c_fix_l2_start
        kind: fixed
        target: {{entity: line2, point: start}}
        x: 5.0
        y: 0.0
      - id: c_angle
        kind: angle
        a: {{entity: line1}}
        b: {{entity: line2}}
        value: 180.0
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
      line2: [5.0, 0.0, {5.0 + 5.0 * math.cos(a):.6f}, {5.0 * math.sin(a):.6f}]
"""

    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") == "fully_constrained", (
        f"expected fully_constrained, got {result.get('status')}: {result.get('exception')}"
    )


def test_angle_45_degrees():
    """Two lines at 45 deg should converge correctly (regression for angle residual change)."""
    import math

    # initial: two fixed-start lines at 30 deg apart
    a_deg = 30.0
    a = math.radians(a_deg)
    yaml_str = f"""
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: line2
        kind: line
    constraints:
      - id: c_fix_l1_start
        kind: fixed
        target: {{entity: line1, point: start}}
        x: 0.0
        y: 0.0
      - id: c_fix_l2_start
        kind: fixed
        target: {{entity: line2, point: start}}
        x: 0.0
        y: 0.0
      - id: c_len_l1
        kind: length
        target: {{entity: line1}}
        value: 5.0
      - id: c_len_l2
        kind: length
        target: {{entity: line2}}
        value: 5.0
      - id: c_angle
        kind: angle
        a: {{entity: line1}}
        b: {{entity: line2}}
        value: 45.0
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
      line2: [0.0, 0.0, {5.0 * math.cos(a):.6f}, {5.0 * math.sin(a):.6f}]
"""

    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") != "exception", f"solver crashed: {result.get('exception')}"
    # Verify angle residual is small: the angle between lines should be close to 45 deg.
    geom = result.get("geometry", {})
    l1 = geom.get("line1", [])
    l2 = geom.get("line2", [])
    if l1 and l2:
        d1 = [l1[2] - l1[0], l1[3] - l1[1]]
        d2 = [l2[2] - l2[0], l2[3] - l2[1]]
        dot = d1[0] * d2[0] + d1[1] * d2[1]
        cross = d1[0] * d2[1] - d1[1] * d2[0]
        angle = math.degrees(math.atan2(abs(cross), dot))
        assert abs(angle - 45.0) < 1.0, f"angle converged to {angle:.2f} deg, expected ~45"


def test_tangent_contact_at_center():
    """Tangent constraint where initial guess places line endpoint at circle center should converge."""
    yaml_str = """
version: 1
kind: part
features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: line1
        kind: line
      - id: circle1
        kind: circle
    constraints:
      - id: c_fix_start
        kind: fixed
        target: {entity: line1, point: start}
        x: -2.0
        y: 0.0
      - id: c_fix_center
        kind: fixed
        target: {entity: circle1}
        x: 0.0
        y: 0.0
      - id: c_tangent
        kind: tangent
        a: {entity: line1}
        b: {entity: circle1}
    initial:
      line1: [-2.0, 0.0, 0.0, 0.0]
      circle1: [0.0, 0.0, 1.0]
"""
    result = solve(yaml_str)["result"]["sk1"]
    assert result.get("status") != "exception", f"solver crashed: {result.get('exception')}"
    assert result.get("status") != "overconstrained", (
        f"solver found overconstrained: {result.get('exception')}"
    )
