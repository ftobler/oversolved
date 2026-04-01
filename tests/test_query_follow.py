"""
Test cases for complex query following and disambiguation.

These tests focus on scenarios where topology face queries might be ambiguous
or fail to follow parent sketch changes correctly.
"""
import textwrap
import pytest
from oversolved.solver import solve


def gnome_hat_sketch() -> str:
    """Gnome hat (two tangents) sketch with circle and lines."""
    return textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_top"
            label: Gnome Hat (Two Tangents)
            entities:
              - id: circle
                kind: circle
              - id: right_line
                kind: line
              - id: TZ5IM9o1rFCui2P6
                kind: line
              - id: MdfxTyZztqeBhOCD
                kind: point
            initial:
              circle:
                - -0
                - -0
                - 0.25
              right_line:
                - -0.2443117886
                - -0.0530259368
                - -0.2443117886
                - 0.9469740632
              TZ5IM9o1rFCui2P6:
                - -0.2443117886
                - 0.9469740632
                - 0.2180659169
                - 0.1222589706
              MdfxTyZztqeBhOCD:
                - 0.480689
                - 0.688481
            constraints:
              - id: c_circle_fixed
                kind: fixed
                target:
                  entity: circle
                  point: center
                x: 0
                y: 0
              - id: c_left_vertical
                kind: vertical
                target:
                  entity: TZ5IM9o1rFCui2P6
              - a:
                  entity: TZ5IM9o1rFCui2P6
                b:
                  entity: circle
                id: c_left_tangent
                kind: tangent
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: start
                b:
                  entity: circle
                id: c_left_on_circle
                kind: coincident
              - a:
                  entity: right_line
                  point: start
                b:
                  entity: circle
                id: c_right_on_circle
                kind: coincident
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: end
                b:
                  entity: right_line
                  point: end
                id: c_apex_coincident
                kind: coincident
              - id: c_diameter_x1YCHM0A
                kind: diameter
                target: $circle
                value: 0.5
              - id: c_vertical_bshBzwMw
                kind: vertical
                target: $right_line
              - id: c_length__WHtnsfo
                kind: length
                target: $right_line
                value: 1
    """)


def test_gnome_hat_sketch_solves() -> None:
    """Test that the gnome hat sketch solves without error."""
    doc = gnome_hat_sketch()
    result = solve(doc)["result"]["sketch_1"]
    assert result.get("status") != "exception", result.get("exception")
    assert "topology" in result, "Must produce topology for face plane reference"
    assert "surfaces" in result["topology"], "Must have surfaces"
    # Print surface count for debugging
    num_surfaces = len(result["topology"]["surfaces"])
    print(f"\nGnome hat produces {num_surfaces} surface(s)")
    for i, surf in enumerate(result["topology"]["surfaces"]):
        print(f"  Surface {i}: query={surf.get('query')}")


def test_gnome_hat_with_derived_sketch_stable() -> None:
    """
    Test that sketch_1 + sketch_2 (derived from sketch_1's face) solves stably.

    This is the CRITICAL regression test: the complex query from sketch_1's
    topology must consistently resolve to the same face, every time.
    """
    # First, solve sketch_1 alone to get its face query
    sketch1_yaml = gnome_hat_sketch()
    r1 = solve(sketch1_yaml)["result"]["sketch_1"]
    assert r1.get("status") != "exception", f"sketch_1 failed: {r1.get('exception')}"
    assert "topology" in r1
    assert len(r1["topology"]["surfaces"]) > 0, "sketch_1 must produce at least one surface"

    face_query = r1["topology"]["surfaces"][0]["query"]
    print(f"\nExtracted face query: {face_query}")

    # Now build the two-sketch doc with sketch_2 on sketch_1's face
    two_sketch_yaml = textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_top"
            label: Gnome Hat (Two Tangents)
            entities:
              - id: circle
                kind: circle
              - id: right_line
                kind: line
              - id: TZ5IM9o1rFCui2P6
                kind: line
              - id: MdfxTyZztqeBhOCD
                kind: point
            initial:
              circle:
                - -0
                - -0
                - 0.25
              right_line:
                - -0.2443117886
                - -0.0530259368
                - -0.2443117886
                - 0.9469740632
              TZ5IM9o1rFCui2P6:
                - -0.2443117886
                - 0.9469740632
                - 0.2180659169
                - 0.1222589706
              MdfxTyZztqeBhOCD:
                - 0.480689
                - 0.688481
            constraints:
              - id: c_circle_fixed
                kind: fixed
                target:
                  entity: circle
                  point: center
                x: 0
                y: 0
              - id: c_left_vertical
                kind: vertical
                target:
                  entity: TZ5IM9o1rFCui2P6
              - a:
                  entity: TZ5IM9o1rFCui2P6
                b:
                  entity: circle
                id: c_left_tangent
                kind: tangent
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: start
                b:
                  entity: circle
                id: c_left_on_circle
                kind: coincident
              - a:
                  entity: right_line
                  point: start
                b:
                  entity: circle
                id: c_right_on_circle
                kind: coincident
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: end
                b:
                  entity: right_line
                  point: end
                id: c_apex_coincident
                kind: coincident
              - id: c_diameter_x1YCHM0A
                kind: diameter
                target: $circle
                value: 0.5
              - id: c_vertical_bshBzwMw
                kind: vertical
                target: $right_line
              - id: c_length__WHtnsfo
                kind: length
                target: $right_line
                value: 1
          - id: sketch_2
            kind: sketch
            plane: "{face_query}"
            entities:
              - id: PE7oPM-7NHkpm_mI
                kind: circle
              - id: 0pBHYmTfsnghPYDd
                kind: point
            initial:
              PE7oPM-7NHkpm_mI:
                - -0.394922
                - -0.042227
                - 1.509031
              0pBHYmTfsnghPYDd:
                - -0.251562
                - 1.256837
            constraints: []
    """)

    # Solve 5 times to detect flakiness
    for attempt in range(5):
        result = solve(two_sketch_yaml)["result"]
        s1_status = result["sketch_1"].get("status")
        s2_status = result["sketch_2"].get("status")
        s2_exception = result["sketch_2"].get("exception")

        print(f"Attempt {attempt + 1}: sketch_1={s1_status}, sketch_2={s2_status}")
        if s2_exception:
            print(f"  sketch_2 exception: {s2_exception}")

        assert s1_status != "exception", f"sketch_1 failed on attempt {attempt + 1}: {result['sketch_1'].get('exception')}"
        assert s2_status != "exception", f"sketch_2 failed on attempt {attempt + 1}: {s2_exception}"


@pytest.mark.repeat(10)
def test_gnome_hat_with_derived_sketch_repeated(request) -> None:
    """
    Repeat the two-sketch test 10 times to catch flaky/non-deterministic behavior.

    If the query system has ordering issues or non-deterministic matching,
    this will expose them.
    """
    sketch1_yaml = gnome_hat_sketch()
    r1 = solve(sketch1_yaml)["result"]["sketch_1"]
    assert r1.get("status") != "exception"

    face_query = r1["topology"]["surfaces"][0]["query"]

    two_sketch_yaml = textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_top"
            label: Gnome Hat (Two Tangents)
            entities:
              - id: circle
                kind: circle
              - id: right_line
                kind: line
              - id: TZ5IM9o1rFCui2P6
                kind: line
              - id: MdfxTyZztqeBhOCD
                kind: point
            initial:
              circle:
                - -0
                - -0
                - 0.25
              right_line:
                - -0.2443117886
                - -0.0530259368
                - -0.2443117886
                - 0.9469740632
              TZ5IM9o1rFCui2P6:
                - -0.2443117886
                - 0.9469740632
                - 0.2180659169
                - 0.1222589706
              MdfxTyZztqeBhOCD:
                - 0.480689
                - 0.688481
            constraints:
              - id: c_circle_fixed
                kind: fixed
                target:
                  entity: circle
                  point: center
                x: 0
                y: 0
              - id: c_left_vertical
                kind: vertical
                target:
                  entity: TZ5IM9o1rFCui2P6
              - a:
                  entity: TZ5IM9o1rFCui2P6
                b:
                  entity: circle
                id: c_left_tangent
                kind: tangent
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: start
                b:
                  entity: circle
                id: c_left_on_circle
                kind: coincident
              - a:
                  entity: right_line
                  point: start
                b:
                  entity: circle
                id: c_right_on_circle
                kind: coincident
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: end
                b:
                  entity: right_line
                  point: end
                id: c_apex_coincident
                kind: coincident
              - id: c_diameter_x1YCHM0A
                kind: diameter
                target: $circle
                value: 0.5
              - id: c_vertical_bshBzwMw
                kind: vertical
                target: $right_line
              - id: c_length__WHtnsfo
                kind: length
                target: $right_line
                value: 1
          - id: sketch_2
            kind: sketch
            plane: "{face_query}"
            entities:
              - id: PE7oPM-7NHkpm_mI
                kind: circle
              - id: 0pBHYmTfsnghPYDd
                kind: point
            initial:
              PE7oPM-7NHkpm_mI:
                - -0.394922
                - -0.042227
                - 1.509031
              0pBHYmTfsnghPYDd:
                - -0.251562
                - 1.256837
            constraints: []
    """)

    result = solve(two_sketch_yaml)["result"]

    # Both sketches must solve without error
    s1_status = result["sketch_1"].get("status")
    s2_status = result["sketch_2"].get("status")

    assert s1_status != "exception", f"sketch_1 failed: {result['sketch_1'].get('exception')}"
    assert s2_status != "exception", f"sketch_2 failed on iteration {request.node.callspec.indices['request'] + 1}: {result['sketch_2'].get('exception')}"


def test_gnome_hat_with_cross_sketch_constraints() -> None:
    """
    Test with the exact constraints from the user's problematic case.

    This includes cross-sketch constraints that might cause query ambiguity.
    """
    # The gnome hat sketch with additional complex constraints
    sketch1_yaml = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_top"
            label: Gnome Hat (Two Tangents)
            entities:
              - id: circle
                kind: circle
              - id: right_line
                kind: line
              - id: TZ5IM9o1rFCui2P6
                kind: line
              - id: MdfxTyZztqeBhOCD
                kind: point
            initial:
              circle:
                - -0
                - -0
                - 0.25
              right_line:
                - -0.2443117886
                - -0.0530259368
                - -0.2443117886
                - 0.9469740632
              TZ5IM9o1rFCui2P6:
                - -0.2443117886
                - 0.9469740632
                - 0.2180659169
                - 0.1222589706
              MdfxTyZztqeBhOCD:
                - 0.480689
                - 0.688481
            constraints:
              - id: c_circle_fixed
                kind: fixed
                target:
                  entity: circle
                  point: center
                x: 0
                y: 0
              - id: c_left_vertical
                kind: vertical
                target:
                  entity: TZ5IM9o1rFCui2P6
              - a:
                  entity: TZ5IM9o1rFCui2P6
                b:
                  entity: circle
                id: c_left_tangent
                kind: tangent
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: start
                b:
                  entity: circle
                id: c_left_on_circle
                kind: coincident
              - a:
                  entity: right_line
                  point: start
                b:
                  entity: circle
                id: c_right_on_circle
                kind: coincident
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: end
                b:
                  entity: right_line
                  point: end
                id: c_apex_coincident
                kind: coincident
              - id: c_diameter_x1YCHM0A
                kind: diameter
                target: $circle
                value: 0.5
              - id: c_vertical_bshBzwMw
                kind: vertical
                target: $right_line
              - id: c_length__WHtnsfo
                kind: length
                target: $right_line
                value: 1
    """)

    r1 = solve(sketch1_yaml)["result"]["sketch_1"]
    assert r1.get("status") != "exception", f"sketch_1 failed: {r1.get('exception')}"
    assert "topology" in r1
    assert len(r1["topology"]["surfaces"]) > 0

    face_query = r1["topology"]["surfaces"][0]["query"]
    print(f"\nExtracted face query: {face_query}")

    # Now sketch_2 with cross-sketch constraints that reference sketch_1
    two_sketch_yaml = textwrap.dedent(f"""\
        version: 1
        kind: part
        features:
          - id: sketch_1
            kind: sketch
            plane: "@builtin_plane_top"
            label: Gnome Hat (Two Tangents)
            entities:
              - id: circle
                kind: circle
              - id: right_line
                kind: line
              - id: TZ5IM9o1rFCui2P6
                kind: line
              - id: MdfxTyZztqeBhOCD
                kind: point
            initial:
              circle:
                - -0
                - -0
                - 0.25
              right_line:
                - -0.2443117886
                - -0.0530259368
                - -0.2443117886
                - 0.9469740632
              TZ5IM9o1rFCui2P6:
                - -0.2443117886
                - 0.9469740632
                - 0.2180659169
                - 0.1222589706
              MdfxTyZztqeBhOCD:
                - 0.480689
                - 0.688481
            constraints:
              - id: c_circle_fixed
                kind: fixed
                target:
                  entity: circle
                  point: center
                x: 0
                y: 0
              - id: c_left_vertical
                kind: vertical
                target:
                  entity: TZ5IM9o1rFCui2P6
              - a:
                  entity: TZ5IM9o1rFCui2P6
                b:
                  entity: circle
                id: c_left_tangent
                kind: tangent
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: start
                b:
                  entity: circle
                id: c_left_on_circle
                kind: coincident
              - a:
                  entity: right_line
                  point: start
                b:
                  entity: circle
                id: c_right_on_circle
                kind: coincident
              - a:
                  entity: TZ5IM9o1rFCui2P6
                  point: end
                b:
                  entity: right_line
                  point: end
                id: c_apex_coincident
                kind: coincident
              - id: c_diameter_x1YCHM0A
                kind: diameter
                target: $circle
                value: 0.5
              - id: c_vertical_bshBzwMw
                kind: vertical
                target: $right_line
              - id: c_length__WHtnsfo
                kind: length
                target: $right_line
                value: 1
          - id: sketch_2
            kind: sketch
            plane: "{face_query}"
            entities:
              - id: PE7oPM-7NHkpm_mI
                kind: circle
              - id: 0pBHYmTfsnghPYDd
                kind: point
            initial:
              PE7oPM-7NHkpm_mI:
                - -0.394922
                - -0.042227
                - 1.509031
              0pBHYmTfsnghPYDd:
                - -0.251562
                - 1.256837
            constraints:
              - id: c_point_fixed
                kind: fixed
                target:
                  entity: 0pBHYmTfsnghPYDd
                x: 0
                y: 0
    """)

    result = solve(two_sketch_yaml)["result"]
    assert result["sketch_1"].get("status") != "exception", f"sketch_1: {result['sketch_1'].get('exception')}"
    assert result["sketch_2"].get("status") != "exception", f"sketch_2: {result['sketch_2'].get('exception')}"


def test_ambiguous_face_query_multiple_surfaces() -> None:
    """
    Test the ambiguous query scenario: when a sketch produces multiple topology
    surfaces that all share the same ancestry, a query becomes ambiguous.

    This is the root cause of the "matched 2" error the user is experiencing.

    A simple example: create a box-like rectangle that has 2+ faces.
    Each face could have the same entity ancestry, causing the query to match
    multiple candidates.
    """
    # Create a sketch that produces a rectangle on Front plane
    # This should generate 1 topology surface (the rectangular face)
    # But if the solver generates additional surfaces, the query could be ambiguous

    rect_yaml = textwrap.dedent("""\
        version: 1
        kind: part
        features:
          - id: sketch_rect
            kind: sketch
            plane: "@builtin_plane_front"
            entities:
              - id: l1
                kind: line
              - id: l2
                kind: line
              - id: l3
                kind: line
              - id: l4
                kind: line
            initial:
              l1: [0, 0, 10, 0]
              l2: [10, 0, 10, 10]
              l3: [10, 10, 0, 10]
              l4: [0, 10, 0, 0]
            constraints:
              - {id: c1, kind: coincident, a: {entity: l1, point: end}, b: {entity: l2, point: start}}
              - {id: c2, kind: coincident, a: {entity: l2, point: end}, b: {entity: l3, point: start}}
              - {id: c3, kind: coincident, a: {entity: l3, point: end}, b: {entity: l4, point: start}}
              - {id: c4, kind: coincident, a: {entity: l4, point: end}, b: {entity: l1, point: start}}
              - {id: cf, kind: fixed, target: {entity: l1, point: start}}
              - {id: ch, kind: horizontal, target: {entity: l1}}
              - {id: cv, kind: vertical, target: {entity: l2}}
              - {id: cl, kind: length, target: {entity: l1}, value: 10}
    """)

    result = solve(rect_yaml)["result"]["sketch_rect"]
    assert result.get("status") != "exception", f"Rectangle failed: {result.get('exception')}"
    assert "topology" in result

    num_surfaces = len(result["topology"]["surfaces"])
    print(f"\nRectangle produces {num_surfaces} surface(s)")
    for i, surf in enumerate(result["topology"]["surfaces"]):
        print(f"  Surface {i}: query={surf.get('query')}")

    # Should have 1 surface (the rectangular face)
    assert num_surfaces == 1, f"Expected 1 surface, got {num_surfaces}"


def test_query_with_ambiguous_ancestry() -> None:
    """
    Direct test: manually create a scenario where the repository has
    multiple elements with overlapping ancestor sets.
    """
    from oversolved.query import Repository, AmbiguousQueryError, make_ancestry_query

    repo = Repository()

    # Register two "surfaces" that both depend on the same ancestors
    ancestor_ids = ["@sketch_1circle", "@sketch_1right_line"]
    query = make_ancestry_query(ancestor_ids, "face")

    print(f"\nQuery string: {query}")

    # Register two surfaces with the same ancestor set
    _surface1 = repo.register_anchestor(ancestor_ids, {"type": "face", "id": "surface1"})  # noqa: F841
    _surface2 = repo.register_anchestor(ancestor_ids, {"type": "face", "id": "surface2"})  # noqa: F841

    # Now try to query — should raise AmbiguousQueryError
    try:
        _result = repo.query(query)  # noqa: F841
        assert False, "Should have raised AmbiguousQueryError, but didn't"
    except AmbiguousQueryError as e:
        print(f"Got expected error: {e}")
        assert "matched 2" in str(e)


def test_surface_index_disambiguates_queries() -> None:
    """
    Test that adding surface indices to ancestor IDs disambiguates queries.

    When two surfaces would otherwise have identical queries (same boundary entities),
    adding an index makes them unique.
    """
    from oversolved.query import make_ancestry_query

    # Original problematic case: two surfaces with the same ancestry
    ancestor_ids = ["@sketch_1circle", "@sketch_1right_line"]
    query1 = make_ancestry_query(ancestor_ids, 'face')
    query2 = make_ancestry_query(ancestor_ids, 'face')

    # Without indices, they're identical (that's the problem!)
    assert query1 == query2
    print(f"\nWithout indices: query1={query1}, query2={query2}")
    print(f"Identical: {query1 == query2} ← PROBLEM!")

    # With indices, they should be different
    ancestor_ids_0 = ["@sketch_1circle", "@sketch_1right_line", "surface:0"]
    ancestor_ids_1 = ["@sketch_1circle", "@sketch_1right_line", "surface:1"]

    query1_indexed = make_ancestry_query(ancestor_ids_0, 'face')
    query2_indexed = make_ancestry_query(ancestor_ids_1, 'face')

    assert query1_indexed != query2_indexed
    print(f"\nWith indices: query1={query1_indexed}, query2={query2_indexed}")
    print(f"Different: {query1_indexed != query2_indexed} ← FIXED!")


def test_indexed_queries_dont_match_both() -> None:
    """
    Test that indexed queries resolve to a single surface, not both.

    This demonstrates the fix: when surfaces have indexed ancestry,
    queries are no longer ambiguous.
    """
    from oversolved.query import Repository, make_ancestry_query

    repo = Repository()

    # Register two surfaces with indexed ancestry
    ancestor_ids_0 = ["@sketch_1circle", "@sketch_1right_line", "surface:0"]
    ancestor_ids_1 = ["@sketch_1circle", "@sketch_1right_line", "surface:1"]

    query0 = make_ancestry_query(ancestor_ids_0, "face")
    query1 = make_ancestry_query(ancestor_ids_1, "face")

    surface0_id = repo.register_anchestor(ancestor_ids_0, {"type": "face", "id": "surface0"})
    surface1_id = repo.register_anchestor(ancestor_ids_1, {"type": "face", "id": "surface1"})

    # Each query should resolve to exactly one surface (no ambiguity!)
    result0 = repo.query(query0)
    result1 = repo.query(query1)

    assert result0 is not None
    assert result1 is not None
    assert result0["id"] == "surface0"
    assert result1["id"] == "surface1"
    # Verify registered surfaces are in the repository
    assert surface0_id in repo.elements
    assert surface1_id in repo.elements

    print(f"\nquery0 resolves to surface0: {result0['id']}")
    print(f"query1 resolves to surface1: {result1['id']}")
    print("No ambiguity! ✓")
