from oversolved.solver import solve


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
