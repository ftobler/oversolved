"""Tests focused on multiple sketches where the second sketch has constraints
that reference entities in the first sketch via query strings."""

import math
from oversolved.solver import solve


TOL = 1e-5


#  ──Helpers ──

def length(a, b):
    return math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)


#  ── Baseline: two independent sketches solve correctly ──

def test_two_independent_sketches_both_solve(sketch_log):
    """Two sketches with no cross-references both reach a solved status."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    label: "First sketch"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line1"
      - id: c_len
        kind: length
        target: "$line1"
        value: 5.0
      - id: c_fix
        kind: fixed
        target: "$line1start"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    label: "Second sketch"
    initial:
      line2: [0.0, 3.0, 4.0, 3.0]
    entities:
      - id: line2
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line2"
      - id: c_len
        kind: length
        target: "$line2"
        value: 4.0
      - id: c_fix
        kind: fixed
        target: "$line2start"
        x: 0.0
        y: 3.0
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_two_independent_sketches_both_solve", yaml_str, result["sketch_1"])

    assert result["sketch_1"]["status"] in ("fully_constrained", "underconstrained")
    assert result["sketch_2"]["status"] in ("fully_constrained", "underconstrained")

    geom1 = result["sketch_1"]["geometry"]
    geom2 = result["sketch_2"]["geometry"]
    assert abs(length(geom1["line1"][0:2], geom1["line1"][2:4]) - 5.0) < TOL
    assert abs(length(geom2["line2"][0:2], geom2["line2"][2:4]) - 4.0) < TOL


def test_two_independent_sketches_results_keyed_separately(sketch_log):
    """solve() result dict contains both sketch IDs as top-level keys."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_a
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c_fix
        kind: fixed
        target: "$ptxy"
        x: 1.0
        y: 2.0

  - id: sketch_b
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c_fix
        kind: fixed
        target: "$ptxy"
        x: 3.0
        y: 4.0
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_two_independent_sketches_results_keyed_separately", yaml_str, result["sketch_a"])

    assert "sketch_a" in result
    assert "sketch_b" in result
    assert result["sketch_a"]["geometry"]["pt"] == pytest_approx_list([1.0, 2.0], TOL)
    assert result["sketch_b"]["geometry"]["pt"] == pytest_approx_list([3.0, 4.0], TOL)


def pytest_approx_list(expected, tol):
    """Return a list checker that matches within tol."""
    class _Approx:
        def __eq__(self, other):
            return all(abs(a - b) < tol for a, b in zip(expected, other))

        def __repr__(self):
            return f"approx({expected}, tol={tol})"
    return _Approx()


#  ── Cross-sketch @absolute queries from sketch_2 into sketch_1 ──

def test_cross_sketch_point_coincident_with_line_end(sketch_log):
    """sketch_2 constrains a point to coincide with the end of a line from sketch_1
    via an @absolute query. The solved geometry of sketch_2's point must match
    the solved end point of sketch_1's line."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line1"
      - id: c_len
        kind: length
        target: "$line1"
        value: 5.0
      - id: c_fix
        kind: fixed
        target: "$line1start"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [4.9, 0.1]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c_on_end
        kind: coincident
        a: "$ptxy"
        b: "@sketch_1line1end"
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_cross_sketch_point_coincident_with_line_end", yaml_str, result["sketch_2"])

    assert result["sketch_1"]["status"] in ("fully_constrained", "underconstrained")
    assert result["sketch_2"]["status"] in ("fully_constrained", "underconstrained")

    geom1 = result["sketch_1"]["geometry"]
    geom2 = result["sketch_2"]["geometry"]

    # line1 end should be at (5, 0)
    end1 = geom1["line1"][2:4]
    assert abs(end1[0] - 5.0) < TOL
    assert abs(end1[1] - 0.0) < TOL

    # sketch_2's point must coincide with that end
    assert abs(geom2["pt"][0] - end1[0]) < TOL
    assert abs(geom2["pt"][1] - end1[1]) < TOL


def test_cross_sketch_fixed_with_absolute_query_value(sketch_log):
    """sketch_2 tries to use a fixed constraint with coordinates hard-coded to
    match what sketch_1 produces. Both sketches should still solve independently."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      circle1: [3.0, 3.0, 2.0]
    entities:
      - id: circle1
        kind: circle
    constraints:
      - id: c_r
        kind: radius
        target: "$circle1"
        value: 2.0
      - id: c_fix
        kind: fixed
        target: "$circle1center"
        x: 3.0
        y: 3.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [3.0, 3.0]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c_fix
        kind: fixed
        target: "$ptxy"
        x: 3.0
        y: 3.0
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_cross_sketch_fixed_with_absolute_query_value", yaml_str, result["sketch_1"])

    assert result["sketch_1"]["status"] in ("fully_constrained", "underconstrained")
    assert result["sketch_2"]["status"] in ("fully_constrained", "underconstrained")

    geom1 = result["sketch_1"]["geometry"]
    geom2 = result["sketch_2"]["geometry"]
    # Both sketches agree on (3,3)
    assert abs(geom1["circle1"][0] - 3.0) < TOL
    assert abs(geom1["circle1"][1] - 3.0) < TOL
    assert abs(geom2["pt"][0] - 3.0) < TOL
    assert abs(geom2["pt"][1] - 3.0) < TOL


#  ── sketch_1 isolation: sketch_2 failure must not affect sketch_1 ──

def test_sketch_1_unaffected_by_sketch_2_bad_query(sketch_log):
    """sketch_1 must solve correctly even when sketch_2 has an unresolvable
    query (referencing a non-existent entity ID from sketch_1)."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 0.0, 10.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line1"
      - id: c_len
        kind: length
        target: "$line1"
        value: 10.0
      - id: c_fix_start
        kind: fixed
        target: "$line1start"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [5.0, 1.0]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c_bad
        kind: coincident
        a: "$ptxy"
        b: "@sketch_1doesnotexist"
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_sketch_1_unaffected_by_sketch_2_bad_query", yaml_str, result["sketch_1"])

    s1 = result["sketch_1"]
    assert s1["status"] in ("fully_constrained", "underconstrained")
    geom1 = s1["geometry"]
    assert abs(length(geom1["line1"][0:2], geom1["line1"][2:4]) - 10.0) < TOL
    # sketch_2 has a bad query - constraint is dropped, sketch is underconstrained
    assert "sketch_2" in result


def test_sketch_order_determines_solve_sequence(sketch_log):
    """Features are solved in declaration order; sketch_1 result key appears
    before sketch_2 in the iteration order of the result dict."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c_fix
        kind: fixed
        target: "$ptxy"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [1.0, 0.0, 4.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line1"
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_sketch_order_determines_solve_sequence", yaml_str, result["sketch_1"])

    # Filter out builtin planes to check sketch order
    keys = [k for k in result.keys() if not k.startswith("builtin_")]
    assert keys.index("sketch_1") < keys.index("sketch_2")


# ── sketch_2 uses local $-queries (must not bleed across sketches) ──

def test_local_query_does_not_bleed_across_sketches(sketch_log):
    """Both sketches have an entity called 'line1'. sketch_2's $line1 must
    resolve to its own line1, not sketch_1's."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 0.0, 5.0, 0.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line1"
      - id: c_len
        kind: length
        target: "$line1"
        value: 5.0
      - id: c_fix
        kind: fixed
        target: "$line1start"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      line1: [0.0, 10.0, 9.0, 10.0]
    entities:
      - id: line1
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$line1"
      - id: c_len
        kind: length
        target: "$line1"
        value: 9.0
      - id: c_fix
        kind: fixed
        target: "$line1start"
        x: 0.0
        y: 10.0
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_local_query_does_not_bleed_across_sketches", yaml_str, result["sketch_1"])

    geom1 = result["sketch_1"]["geometry"]
    geom2 = result["sketch_2"]["geometry"]

    len1 = length(geom1["line1"][0:2], geom1["line1"][2:4])
    len2 = length(geom2["line2"][0:2] if "line2" in geom2 else geom2["line1"][0:2],
                  geom2["line2"][2:4] if "line2" in geom2 else geom2["line1"][2:4])

    assert abs(len1 - 5.0) < TOL, f"sketch_1 line1 length should be 5, got {len1}"
    assert abs(len2 - 9.0) < TOL, f"sketch_2 line1 length should be 9, got {len2}"


#  ── Multiple sketches — various entity types ──

def test_two_sketches_circle_and_line(sketch_log):
    """sketch_1 has a circle, sketch_2 has a line; both solve independently."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      c: [0.0, 0.0, 3.0]
    entities:
      - id: c
        kind: circle
    constraints:
      - id: c_r
        kind: radius
        target: "$c"
        value: 3.0
      - id: c_fix
        kind: fixed
        target: "$ccenter"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      seg: [1.0, 5.0, 7.0, 5.0]
    entities:
      - id: seg
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$seg"
      - id: c_len
        kind: length
        target: "$seg"
        value: 6.0
      - id: c_fix
        kind: fixed
        target: "$segstart"
        x: 1.0
        y: 5.0
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_two_sketches_circle_and_line", yaml_str, result["sketch_1"])

    assert result["sketch_1"]["status"] in ("fully_constrained", "underconstrained")
    assert result["sketch_2"]["status"] in ("fully_constrained", "underconstrained")

    geom1 = result["sketch_1"]["geometry"]
    geom2 = result["sketch_2"]["geometry"]
    assert abs(geom1["c"][2] - 3.0) < TOL, "circle radius must be 3"
    assert abs(length(geom2["seg"][0:2], geom2["seg"][2:4]) - 6.0) < TOL, "segment length must be 6"


def test_three_sketches_independent(sketch_log):
    """Three sketches, all independent, all should produce results."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sk1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [1.0, 1.0]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c
        kind: fixed
        target: "$ptxy"
        x: 1.0
        y: 1.0

  - id: sk2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [2.0, 2.0]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c
        kind: fixed
        target: "$ptxy"
        x: 2.0
        y: 2.0

  - id: sk3
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      pt: [3.0, 3.0]
    entities:
      - id: pt
        kind: point
    constraints:
      - id: c
        kind: fixed
        target: "$ptxy"
        x: 3.0
        y: 3.0
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_three_sketches_independent", yaml_str, result["sk1"])

    # Filter out builtin planes from result keys
    user_keys = {k for k in result.keys() if not k.startswith("builtin_")}
    assert user_keys == {"sk1", "sk2", "sk3"}
    for sk_id, expected in [("sk1", [1.0, 1.0]), ("sk2", [2.0, 2.0]), ("sk3", [3.0, 3.0])]:
        geom = result[sk_id]["geometry"]
        assert abs(geom["pt"][0] - expected[0]) < TOL
        assert abs(geom["pt"][1] - expected[1]) < TOL


#  ── sketch_2 constraint referencing sketch_1 via unresolvable absolute query ──

def test_cross_sketch_length_constraint_with_unresolvable_query(sketch_log):
    """sketch_2 has a constraint whose target references a non-existent entity ID
    from sketch_1. The bad query is dropped; sketch_1 must still be intact."""
    yaml_str = """
version: 1
kind: part

features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      base: [0.0, 0.0, 8.0, 0.0]
    entities:
      - id: base
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$base"
      - id: c_len
        kind: length
        target: "$base"
        value: 8.0
      - id: c_fix
        kind: fixed
        target: "$basestart"
        x: 0.0
        y: 0.0

  - id: sketch_2
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      arm: [0.0, 2.0, 4.0, 2.0]
    entities:
      - id: arm
        kind: line
    constraints:
      - id: c_horiz
        kind: horizontal
        target: "$arm"
      - id: c_bad
        kind: coincident
        a: "$armstart"
        b: "@sketch_1doesnotexist"
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_cross_sketch_length_constraint_with_unresolvable_query", yaml_str, result["sketch_1"])

    # sketch_1 must always solve
    assert result["sketch_1"]["status"] in ("fully_constrained", "underconstrained")
    geom1 = result["sketch_1"]["geometry"]
    assert abs(length(geom1["base"][0:2], geom1["base"][2:4]) - 8.0) < TOL

    # sketch_2 result key must exist regardless
    assert "sketch_2" in result


#  ── Real-world example: line end pinned to a point from a previous sketch ──

def test_line_end_pinned_to_prior_sketch_point(sketch_log):
    """Real-world example: sketch_1 has a fixed point; sketch_12 has a line
    whose end is constrained to coincide with that point via @absolute query.

    This is the canonical cross-sketch reference pattern.
    """
    yaml_str = """
version: 1
kind: part
features:
  - id: sketch_1
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      soQKp5gabTAWeXxr:
        - -0.786458
        - 0.982656
    entities:
      - id: soQKp5gabTAWeXxr
        kind: point
    constraints:
      - id: c_fixed_nmzES6Dw
        kind: fixed
        target: $soQKp5gabTAWeXxrxy
    label: thelabel
  - id: sketch_12
    kind: sketch
    plane: "@builtin_plane_front"
    initial:
      NsCWBgu0btgcyVQV:
        - 0.764024
        - 1.337318
        - -0.410573
        - 1.741628
    entities:
      - id: NsCWBgu0btgcyVQV
        kind: line
    constraints:
      - id: c_coincident_B1n1WgtE
        kind: coincident
        a: $NsCWBgu0btgcyVQVend
        b: "@sketch_1soQKp5gabTAWeXxrxy"
    label: thelabel
"""
    result = solve(yaml_str)["result"]
    sketch_log("test_line_end_pinned_to_prior_sketch_point", yaml_str, result["sketch_1"])

    assert result["sketch_1"]["status"] in ("fully_constrained", "underconstrained")
    assert result["sketch_12"]["status"] in ("fully_constrained", "underconstrained")

    pt = result["sketch_1"]["geometry"]["soQKp5gabTAWeXxr"]
    line_end = result["sketch_12"]["geometry"]["NsCWBgu0btgcyVQV"][2:4]

    assert abs(line_end[0] - pt[0]) < TOL, f"line end x {line_end[0]} != point x {pt[0]}"
    assert abs(line_end[1] - pt[1]) < TOL, f"line end y {line_end[1]} != point y {pt[1]}"
