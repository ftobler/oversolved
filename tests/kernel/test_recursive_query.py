"""Tests for recursive ancestral queries (Stage 1).

Covers: QueryNode, build_query, resolve_query, HeuristicConfig, Outcome.
Stage 1 exercises the type/builder/walker against synthetic trees and
the area re-ID case; producers still emit flat queries during the transition.
"""

import pytest

from oversolved.kernel.query import (
    Repository, QueryNode, build_query, resolve_query, ref,
    make_ancestry_query, _parse_ancestry,
)
from oversolved.kernel.query_heuristics import (
    HeuristicConfig, Outcome, score_overlap, pick_best,
)
from oversolved.kernel.profile_loops import match_area_reid, _surface_entity_ids


def test_builder_composes_parent_chain():
    """build_query walks parent_map recursively and produces a QueryNode
    tree that matches the lineage we'd expect for an extrude edge."""
    # lineage: edge -> extrude1 -> flatface -> sketch1 entities -> plane
    parent_map = {
        "edge0": ["extrude1"],
        "extrude1": ["face_area1"],
        "face_area1": ["sketch1/line1", "sketch1/line2", "sketch1/arc1"],
        "sketch1/line1": ["plane_front"],
        "sketch1/line2": ["plane_front"],
        "sketch1/arc1": ["plane_front"],
    }

    node = build_query("edge0", parent_map)
    assert node is not None
    assert node.id == ref("edge0")

    # one parent: extrude1
    assert len(node.parents) == 1
    extrude_node = node.parents[0]
    assert extrude_node.id == ref("extrude1")

    # extrude1 has one parent: face_area1
    assert len(extrude_node.parents) == 1
    face_node = extrude_node.parents[0]
    assert face_node.id == ref("face_area1")

    # face_area1 has three parents: the sketch entities
    assert len(face_node.parents) == 3
    entity_ids = {p.id for p in face_node.parents}
    assert entity_ids == {ref("sketch1/line1"), ref("sketch1/line2"), ref("sketch1/arc1")}

    # all three entities reconverge at plane_front
    for entity_node in face_node.parents:
        assert len(entity_node.parents) == 1
        assert entity_node.parents[0].id == ref("plane_front")

    # plane_front has no parents (terminal)
    for entity_node in face_node.parents:
        assert len(entity_node.parents[0].parents) == 0

    # tag_set derivation
    tags = node.tag_set()
    assert ref("edge0") in tags
    assert ref("extrude1") in tags
    assert ref("sketch1/line1") in tags
    assert ref("plane_front") in tags


def test_walker_branches_and_reconverges():
    """resolve_query descends a tree against a Repository and matches
    when all branches are present."""
    repo = Repository()

    # Register two elements under overlapping ancestor sets.
    # Element A: @sketch1/line1 + @sketch1/line2 + @plane_front
    # Element B: @sketch1/line1 + @sketch1/line3 + @plane_front
    payload_a = {"type": "test_a", "value": 1}
    payload_b = {"type": "test_b", "value": 2}
    # use register_ancestor with the flat tag sets
    repo.register_ancestor(
        [ref("sketch1/line1"), ref("sketch1/line2"), ref("plane_front")],
        payload_a,
    )
    repo.register_ancestor(
        [ref("sketch1/line1"), ref("sketch1/line3"), ref("plane_front")],
        payload_b,
    )

    # Build a query tree that matches element A exactly.
    # face_area -> sketch1/line1, sketch1/line2 -> plane_front
    node = QueryNode(
        id=ref("face_area"),
        parents=(
            QueryNode(
                id=ref("sketch1/line1"),
                parents=(QueryNode(id=ref("plane_front")),),
            ),
            QueryNode(
                id=ref("sketch1/line2"),
                parents=(QueryNode(id=ref("plane_front")),),
            ),
        ),
    )

    outcome, result = resolve_query(node, repo)
    assert outcome == Outcome.RESOLVED, f"expected RESOLVED, got {outcome}"
    assert result is not None
    assert result.get("value") == 1  # matches element A

    # A query that only mentions sketch1/line1 (without line2) is ambiguous —
    # both A and B match. Should be Ambiguous (not silently picking one).
    node_ambiguous = QueryNode(
        id=ref("face_area"),
        parents=(
            QueryNode(
                id=ref("sketch1/line1"),
                parents=(QueryNode(id=ref("plane_front")),),
            ),
        ),
    )
    outcome2, result2 = resolve_query(node_ambiguous, repo)
    assert outcome2 == Outcome.AMBIGUOUS, (
        f"expected AMBIGUOUS when two candidates match, got {outcome2}"
    )

    # With a slight edge from a dedicated ancestor, one wins.
    node_winner = QueryNode(
        id=ref("face_area"),
        parents=(
            QueryNode(
                id=ref("sketch1/line1"),
                parents=(QueryNode(id=ref("plane_front")),),
            ),
            QueryNode(
                id=ref("sketch1/line2"),  # only in A
                parents=(QueryNode(id=ref("plane_front")),),
            ),
        ),
    )
    # Run with margin=0: tag_set={@face_area,@sketch1/line1,@sketch1/line2,@plane_front}
    # A overlap=4/5=0.8, B overlap=2/5=0.4 (not enough for default threshold?)
    # Actually A overlap=4/4=1.0 (all 4 tags match A: all present in A key)
    # B overlap=2/4=0.5 (only line1 and plane_front)
    # margin 0: 1.0 - 0.5 = 0.5 > 0 → RESOLVED A
    outcome3, result3 = resolve_query(node_winner, repo)
    assert outcome3 == Outcome.RESOLVED
    assert result3 is not None
    assert result3.get("value") == 1  # A

    # Unrelated query should be UNRESOLVED.
    node_unrelated = QueryNode(
        id=ref("face_other"),
        parents=(QueryNode(id=ref("sketch99/article99")),),
    )
    outcome3, result3 = resolve_query(node_unrelated, repo)
    assert outcome3 == Outcome.UNRESOLVED


def test_partial_branch_heuristic():
    """Replace one constituent entity with a new one — the area still resolves
    via partial-overlap scoring (generalized match_area_reid)."""
    repo = Repository()

    # Register an area with three entity ancestors.
    old_ancestors = [
        ref("sk1/line_a"), ref("sk1/line_b"), ref("sk1/line_c"),
    ]
    payload = {"type": "flatface", "area": 12.0}
    repo.register_ancestor(old_ancestors, payload)

    # Build a query that overlaps 2/3 (66% > default 50% threshold).
    # Replace line_c with arc_new — partial match via overlap.
    node = QueryNode(
        id=ref("surface_area"),
        parents=(
            QueryNode(id=ref("sk1/line_a")),
            QueryNode(id=ref("sk1/line_b")),
            QueryNode(id=ref("sk1/arc_new")),
        ),
    )

    outcome, result = resolve_query(node, repo)
    # Stock threshold (0.5) and 2/3 overlap should resolve.
    assert outcome == Outcome.RESOLVED, f"expected RESOLVED with 2/3 overlap, got {outcome}"
    assert result is not None
    assert result.get("area") == 12.0

    # Query with only 1/3 overlap should fail with default threshold.
    node_low = QueryNode(
        id=ref("surface_area"),
        parents=(
            QueryNode(id=ref("sk1/line_a")),
            QueryNode(id=ref("sk1/other_x")),
            QueryNode(id=ref("sk1/other_y")),
        ),
    )
    outcome2, _ = resolve_query(node_low, repo)
    assert outcome2 == Outcome.UNRESOLVED, (
        f"1/3 overlap below 0.5 threshold must be UNRESOLVED, got {outcome2}"
    )


def test_heuristic_config_is_tweakable():
    """Same partial-match case under different HeuristicConfig values flips
    the outcome resolved↔unresolved purely from config, with no walker change."""
    repo = Repository()
    ancestors = [ref("sk/edge_a"), ref("sk/edge_b"), ref("sk/edge_c")]
    payload = {"type": "straightedge", "length": 10.0}
    repo.register_ancestor(ancestors, payload)

    # Query with only 1/3 overlap.
    node = QueryNode(
        id=ref("surface"),
        parents=(
            QueryNode(id=ref("sk/edge_a")),
            QueryNode(id=ref("sk/other1")),
            QueryNode(id=ref("sk/other2")),
        ),
    )

    # Strict config: overlap_threshold 0.6 → 1/3 fails → UNRESOLVED.
    strict = HeuristicConfig(overlap_threshold=0.6)
    outcome_strict, _ = resolve_query(node, repo, cfg=strict)
    assert outcome_strict == Outcome.UNRESOLVED, (
        f"strict threshold must yield UNRESOLVED, got {outcome_strict}"
    )

    # Loose config: overlap_threshold 0.2 → 1/3 passes → RESOLVED.
    loose = HeuristicConfig(overlap_threshold=0.2)
    outcome_loose, result = resolve_query(node, repo, cfg=loose)
    assert outcome_loose == Outcome.RESOLVED, (
        f"loose threshold must yield RESOLVED, got {outcome_loose}"
    )
    assert result is not None
    assert result.get("length") == 10.0

    # match_area_reid must now read its threshold from the shared config.
    old_surfaces = [
        {"query": make_ancestry_query(
            [ref("sk/edge_a"), ref("sk/edge_b"), ref("sk/edge_c")], "flatface",
        ), "boundary": [{"start": [0, 0], "end": [10, 0]}]},
    ]
    new_surfaces = [
        {"query": make_ancestry_query(
            [ref("sk/edge_a"), ref("sk/other1"), ref("sk/other2")], "flatface",
        ), "boundary": [{"start": [0, 0], "end": [10, 0]}]},
    ]
    mapping_strict = match_area_reid(old_surfaces, new_surfaces, cfg=strict)
    mapping_loose = match_area_reid(old_surfaces, new_surfaces, cfg=loose)
    assert not mapping_strict, "strict config must yield empty reid map"
    assert mapping_loose, "loose config must map surfaces"


def test_ambiguity_margin_forces_red():
    """Two candidates with scores within ambiguity_margin must produce
    AMBIGUOUS, never a silent pick."""
    repo = Repository()
    # loose threshold so both partial matches pass Tier 2
    cfg = HeuristicConfig(overlap_threshold=0.3, ambiguity_margin=0.3)

    # Two elements with nearly-equal overlap scores.
    ancestors_a = [ref("sk/edge_a"), ref("sk/edge_b")]
    ancestors_b = [ref("sk/edge_a"), ref("sk/edge_c")]
    repo.register_ancestor(ancestors_a, {"type": "straightedge", "id": "A"})
    repo.register_ancestor(ancestors_b, {"type": "straightedge", "id": "B"})

    # Query that overlaps both equally (each matches 1/2 = 0.5).
    node = QueryNode(
        id=ref("surface"),
        parents=(
            QueryNode(id=ref("sk/edge_a")),
            QueryNode(id=ref("sk/edge_z")),  # matches neither
        ),
    )

    outcome, _ = resolve_query(node, repo, cfg=cfg)
    assert outcome == Outcome.AMBIGUOUS, (
        f"equal scores must be AMBIGUOUS, got {outcome}"
    )


def test_geom_hash_only_when_no_lineage():
    """An element with only a geom-hash (no structural ancestors, like an
    imported STEP face) resolves via the hash fallback tier."""
    repo = Repository()

    # Register an element with only a geom-hash ancestor.
    repo.register_ancestor(
        [ref("gface_abc123")],
        {"type": "face", "area": 42.0},
        geom_hash="gface_abc123",
    )

    # Query node with only the geom hash.
    node = QueryNode(id=ref("gface_abc123"))

    outcome, result = resolve_query(node, repo)
    assert outcome == Outcome.RESOLVED, (
        f"geom-hash-only query must resolve, got {outcome}"
    )
    assert result is not None
    assert result.get("area") == 42.0


def test_tag_set_derives_flat_set():
    """QueryNode.tag_set() flattens the tree to a frozenset suitable for
    the existing flat Repository.ancestral resolver."""
    node = QueryNode(
        id=ref("root"),
        parents=(
            QueryNode(
                id=ref("parent_a"),
                parents=(QueryNode(id=ref("grandparent")),),
            ),
            QueryNode(
                id=ref("parent_b"),
                parents=(QueryNode(id=ref("grandparent")),),
            ),
        ),
    )
    tags = node.tag_set()
    assert tags == {ref("root"), ref("parent_a"), ref("parent_b"), ref("grandparent")}
    # ancestor_ids() returns a sorted tuple of the same set
    assert set(node.ancestor_ids()) == tags


def test_heuristic_config_defaults():
    """DEFAULT_HEURISTIC_CONFIG has sensible defaults."""
    from oversolved.kernel.query_heuristics import DEFAULT_HEURISTIC_CONFIG
    cfg = DEFAULT_HEURISTIC_CONFIG
    assert cfg.overlap_threshold == 0.5
    assert cfg.ambiguity_margin == 0.0
    assert cfg.geometry_leaf_tolerance == 0.01
    assert cfg.kind_weights == {}
    assert cfg.weight_for("any") == 1.0
    assert cfg.weight_for("edge") == 1.0


def test_score_overlap_edge_cases():
    """score_overlap handles empty sets and perfect matches."""
    assert score_overlap(frozenset(), frozenset()) == 0.0
    assert score_overlap(frozenset(["a"]), frozenset()) == 0.0
    assert score_overlap(frozenset(["a", "b"]), frozenset(["a", "b"])) == 1.0
    assert score_overlap(frozenset(["a", "b"]), frozenset(["b", "c"])) == 0.5
    assert score_overlap(frozenset(["a", "b", "c"]), frozenset(["a"])) == 1.0 / 3.0


def test_pick_best_single_candidate():
    """pick_best with one candidate returns RESOLVED."""
    cfg = HeuristicConfig()
    outcome, winner = pick_best([("item", 0.8)], cfg)
    assert outcome == Outcome.RESOLVED
    assert winner == "item"


def test_pick_best_clear_winner():
    """pick_best with one candidate beating another by > margin."""
    cfg = HeuristicConfig(ambiguity_margin=0.2)
    outcome, winner = pick_best([("A", 0.9), ("B", 0.5)], cfg)
    assert outcome == Outcome.RESOLVED
    assert winner == "A"


def test_pick_best_ambiguous_within_margin():
    """pick_best with scores within margin returns AMBIGUOUS."""
    cfg = HeuristicConfig(ambiguity_margin=0.3)
    outcome, winner = pick_best([("A", 0.8), ("B", 0.7)], cfg)
    assert outcome == Outcome.AMBIGUOUS
    assert winner is None


def test_pick_best_empty():
    """pick_best with no candidates returns UNRESOLVED."""
    outcome, winner = pick_best([], HeuristicConfig())
    assert outcome == Outcome.UNRESOLVED
    assert winner is None


def test_tag_set_empty_terminal_node():
    """A terminal node (no parents) produces a tag set of size 1."""
    node = QueryNode(id=ref("solo"))
    assert node.tag_set() == frozenset([ref("solo")])
    assert node.ancestor_ids() == (ref("solo"),)


def test_leaf_geom_is_preserved():
    """QueryNode stores leaf_geom but it's not part of tag_set."""
    node = QueryNode(
        id=ref("edge"),
        leaf_geom={"normal": [0, 0, 1], "area": 5.0},
    )
    assert node.leaf_geom == {"normal": [0, 0, 1], "area": 5.0}
    assert node.tag_set() == frozenset([ref("edge")])


def test_build_query_preserves_at_prefix():
    """build_query leaves @-prefixed IDs untouched."""
    parent_map = {"el": ["@already_prefixed"]}
    node = build_query("el", parent_map)
    assert len(node.parents) == 1
    assert node.parents[0].id == "@already_prefixed"


def test_resolve_query_no_tag_set():
    """A QueryNode with an empty tag set returns UNRESOLVED."""
    repo = Repository()
    node = QueryNode(id="")  # empty ID
    outcome, result = resolve_query(node, repo)
    assert outcome == Outcome.UNRESOLVED
    assert result is None


# ─── Stage 2: profile-layer integration tests ───


def test_profile_layer_survives_distance_change():
    """Profile entity tokens appear in edge/face query strings and repo keys.

    After a distance change, the new query strings include the same profile
    tokens (sketch didn't change), so Tier 1 resolution still matches.
    If the query targets a unique face (e.g. a single-profile extrude with
    only 1 face), it resolves without needing the stale geom-hash.
    """
    import importlib
    if not importlib.util.find_spec("cadquery"):
        pytest.skip("cadquery not installed")
    if not importlib.util.find_spec("vtkmodules"):
        pytest.skip("vtkmodules not installed")

    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec

    # first build: extrude 10mm
    spec1 = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {"id": "ex1", "kind": "extrude", "sketch": "$sk1",
             "distance": 10.0, "direction": "normal", "operation": "new"},
        ],
    }
    r1 = build(spec1)
    assert r1["result"]["ex1"]["status"] == "ok"
    body1 = r1["bodies"]["body_ex1"]
    face_queries_old = body1["mesh"].get("face_queries", [])

    # sanity: face queries contain profile tokens
    assert len(face_queries_old) > 0, "extrude must produce faces"
    profile_in_query = any("@sk1/" in q for q in face_queries_old)
    assert profile_in_query, "face queries must contain @sk1/entity tokens"

    # second build: same sketch, different distance
    spec2 = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {"id": "ex1", "kind": "extrude", "sketch": "$sk1",
             "distance": 25.0, "direction": "normal", "operation": "new"},
        ],
    }
    r2 = build(spec2)
    assert r2["result"]["ex1"]["status"] == "ok"

    # the new face queries also contain profile tokens
    body2 = r2["bodies"]["body_ex1"]
    face_queries_new = body2["mesh"].get("face_queries", [])
    profile_in_query2 = any("@sk1/" in q for q in face_queries_new)
    assert profile_in_query2, "face queries in rebuild must contain @sk1/entity tokens"

    # repo from second build has profile tokens in ancestral keys
    last_cp = list(r2["_build_state"].checkpoints.values())[-1]
    snap = last_cp.repo_snapshot
    profile_in_key = False
    for key in snap.get("ancestral", {}):
        for tag in key:
            if tag.startswith("@sk1/") and "surface" not in tag:
                profile_in_key = True
                break
    assert profile_in_key, "repo keys must contain @sk1/entity tokens"
    # Note: full edge-level disambiguation after distance change requires
    # Stage 2's MakePrism.Generated() entity-level lineage.


def test_profile_layer_entity_ids_attached():
    """Verify that profile entity tokens (@sketch_id/entity_id) appear in
    the ancestor sets of B-rep faces/edges after registration."""
    import importlib
    if not importlib.util.find_spec("cadquery"):
        pytest.skip("cadquery not installed")
    if not importlib.util.find_spec("vtkmodules"):
        pytest.skip("vtkmodules not installed")

    from oversolved.kernel.builder import build
    from solver_helpers import rect_sketch_spec

    spec = {
        "features": [
            rect_sketch_spec(w=10, h=10, sketch_id="sk1"),
            {"id": "ex1", "kind": "extrude", "sketch": "$sk1",
             "distance": 10.0, "direction": "normal", "operation": "new"},
        ],
    }
    r = build(spec)
    # Verify profile tokens in the last checkpoint's repo snapshot
    last_cp = list(r["_build_state"].checkpoints.values())[-1]
    snap = last_cp.repo_snapshot
    found_profile = False
    for key in snap.get("ancestral", {}):
        for tag in key:
            if tag.startswith("@sk1/") and "surface" not in tag:
                found_profile = True
                break
        if found_profile:
            break
    assert found_profile, (
        "repo.ancestral must contain keys with profile entity tokens "
        "(@sk1/bottom, @sk1/top, etc.) from _surface_entity_ids"
    )
