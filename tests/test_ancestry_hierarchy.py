"""Tests for the ancestry hierarchy: solid, extrusion-feature, sketch-feature queries.

The ancestry system gives every piece of geometry a stable identity rooted in the
feature that created it. This allows downstream references (sketch planes, constraints)
to survive topology changes on rebuild -- the topological naming problem in parametric CAD.

Key invariants tested here:
- Leaf entities carry the feature root in their ancestor set.
- query() with a full ancestor set finds the exact entity.
- query_all() with just the feature root enumerates all entities of a given type.
- Solid and feature entities are registered as first-class queryable objects.
- Sketch features register as sketch-feature entities.
- Extrusion features register as both extrusion-feature and solid entities.
"""
import pytest
from oversolved.query import Repository, make_ancestry_query


# ── query_all unit tests ───────────────────────────────────────────────────────

def test_query_all_returns_empty_for_non_ancestry_query():
    repo = Repository()
    repo.register_anchestor(["@feat1face0", "@feat1"], {"type": "flatface"})
    assert repo.query_all("@feat1") == []
    assert repo.query_all("") == []


def test_query_all_finds_by_feature_root():
    repo = Repository()
    repo.register_anchestor(["@feat1face0", "@feat1"], {"type": "flatface", "idx": 0})
    repo.register_anchestor(["@feat1face1", "@feat1"], {"type": "flatface", "idx": 1})
    repo.register_anchestor(["@feat2face0", "@feat2"], {"type": "flatface", "idx": 99})

    results = repo.query_all(make_ancestry_query(["@feat1"], "flatface"))
    assert len(results) == 2
    assert all(r["type"] == "flatface" for r in results)
    assert {r["idx"] for r in results} == {0, 1}


def test_query_all_type_filters_correctly():
    repo = Repository()
    repo.register_anchestor(["@feat1face0", "@feat1"], {"type": "flatface"})
    repo.register_anchestor(["@feat1edge0", "@feat1"], {"type": "straightedge"})

    assert len(repo.query_all(make_ancestry_query(["@feat1"], "flatface"))) == 1
    assert len(repo.query_all(make_ancestry_query(["@feat1"], "straightedge"))) == 1


def test_query_all_without_type_restriction_returns_all():
    repo = Repository()
    repo.register_anchestor(["@feat1face0", "@feat1"], {"type": "flatface"})
    repo.register_anchestor(["@feat1edge0", "@feat1"], {"type": "straightedge"})

    assert len(repo.query_all(make_ancestry_query(["@feat1"]))) == 2


def test_query_all_does_not_bleed_across_features():
    repo = Repository()
    repo.register_anchestor(["@feat1face0", "@feat1"], {"type": "flatface"})
    repo.register_anchestor(["@feat2face0", "@feat2"], {"type": "flatface"})

    feat1_results = repo.query_all(make_ancestry_query(["@feat1"], "flatface"))
    assert len(feat1_results) == 1

    feat2_results = repo.query_all(make_ancestry_query(["@feat2"], "flatface"))
    assert len(feat2_results) == 1


def test_query_still_resolves_with_extended_ancestor_set():
    """Existing exact queries must still resolve after the feature root is added."""
    repo = Repository()
    repo.register_anchestor(["@feat1face0", "@feat1"], {"type": "flatface", "x": 1})

    result = repo.query(make_ancestry_query(["@feat1face0", "@feat1"], "flatface"))
    assert result is not None
    assert result["x"] == 1


def test_query_solid_finds_registered_solid():
    repo = Repository()
    repo.register_anchestor(["@ex1"], {"type": "solid", "created_by": "ex1"})
    repo.register_anchestor(["@ex1face0", "@ex1"], {"type": "flatface"})

    solid = repo.query(make_ancestry_query(["@ex1"], "solid"))
    assert solid is not None
    assert solid["type"] == "solid"

    face = repo.query(make_ancestry_query(["@ex1face0", "@ex1"], "flatface"))
    assert face is not None


# ── Extrusion ancestry integration tests ─────────────────────────────────────

def test_extrusion_registers_solid_entity():
    pytest.importorskip("OCP.gp")
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import full_rect_extrude_spec  # type: ignore[import]

    r = build(full_rect_extrude_spec())
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)

    solid = repo.query(make_ancestry_query(["@ex1"], "solid"))
    assert solid is not None, "extrusion should register a solid entity"
    assert solid["type"] == "solid"
    assert solid["created_by"] == "ex1"


def test_extrusion_registers_extrusion_feature_entity():
    pytest.importorskip("OCP.gp")
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import full_rect_extrude_spec  # type: ignore[import]

    r = build(full_rect_extrude_spec())
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)

    feat = repo.query(make_ancestry_query(["@ex1"], "extrusion-feature"))
    assert feat is not None, "extrusion should register an extrusion-feature entity"
    assert feat["type"] == "extrusion-feature"
    assert feat["feature_id"] == "ex1"
    assert feat["sketch_id"] == "sk1", "extrusion-feature must record its source sketch"


def test_extrusion_faces_belong_to_feature_root():
    pytest.importorskip("OCP.gp")
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import full_rect_extrude_spec  # type: ignore[import]

    r = build(full_rect_extrude_spec())
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)

    faces = repo.query_all(make_ancestry_query(["@ex1"], "flatface"))
    assert len(faces) > 0, "extrusion should have at least one flat face"
    assert all(f["type"] == "flatface" for f in faces)
    assert all(f["created_by"] == "ex1" for f in faces)


def test_extrusion_edges_belong_to_feature_root():
    pytest.importorskip("OCP.gp")
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import full_rect_extrude_spec  # type: ignore[import]

    r = build(full_rect_extrude_spec())
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)

    edges = repo.query_all(make_ancestry_query(["@ex1"], "straightedge"))
    assert len(edges) > 0, "box extrusion should have straight edges"
    assert all(e["type"] == "straightedge" for e in edges)


def test_extrusion_vertices_belong_to_feature_root():
    pytest.importorskip("OCP.gp")
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import full_rect_extrude_spec  # type: ignore[import]

    r = build(full_rect_extrude_spec())
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)

    verts = repo.query_all(make_ancestry_query(["@ex1"], "vertex"))
    assert len(verts) == 8, "box extrusion should have 8 vertices"
    assert all(v["type"] == "vertex" for v in verts)


def test_feature_root_does_not_bleed_between_extrusions():
    """Entities from one extrusion must not appear in another's query_all."""
    pytest.importorskip("OCP.gp")
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import full_rect_extrude_spec  # type: ignore[import]

    r = build(full_rect_extrude_spec())
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["ex1"].repo_snapshot)

    assert repo.query_all(make_ancestry_query(["@other_feature"], "flatface")) == []


# ── Sketch-feature ancestry integration tests ─────────────────────────────────

def test_sketch_feature_entity_registered():
    """sketch-feature entity must be registered after a sketch is solved."""
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import rect_sketch_spec  # type: ignore[import]

    r = build({"features": [rect_sketch_spec(sketch_id="sk1")]})
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["sk1"].repo_snapshot)

    feat = repo.query(make_ancestry_query(["@sk1"], "sketch-feature"))
    assert feat is not None, "sketch should register a sketch-feature entity"
    assert feat["type"] == "sketch-feature"
    assert feat["feature_id"] == "sk1"


def test_sketch_topology_surfaces_carry_feature_root():
    """Topology surface query strings must include the feature root ID."""
    from oversolved.builder import build
    from solver_helpers import rect_sketch_spec  # type: ignore[import]

    r = build({"features": [rect_sketch_spec(sketch_id="sk1")]})
    sk_result = r["result"]["sk1"]
    assert sk_result.get("status") != "exception"

    surfaces = sk_result.get("topology", {}).get("surfaces", [])
    assert len(surfaces) > 0
    for surface in surfaces:
        assert "@sk1" in surface["query"], (
            f"surface query {surface['query']!r} should contain @sk1"
        )


def test_sketch_topology_vertices_belong_to_feature_root():
    """Topology vertices must be enumerable via query_all on the feature root."""
    from oversolved.builder import build, _repo_from_snapshot
    from solver_helpers import rect_sketch_spec  # type: ignore[import]

    r = build({"features": [rect_sketch_spec(sketch_id="sk1")]})
    repo = _repo_from_snapshot(r["_build_state"].checkpoints["sk1"].repo_snapshot)

    verts = repo.query_all(make_ancestry_query(["@sk1"], "vertex"))
    assert len(verts) > 0, "sketch vertices should be enumerable by feature root"
    assert all(v["type"] == "vertex" for v in verts)


def test_sketch_topology_edges_carry_feature_root():
    """Topology edge query strings must include the feature root ID."""
    from oversolved.builder import build
    from solver_helpers import rect_sketch_spec  # type: ignore[import]

    r = build({"features": [rect_sketch_spec(sketch_id="sk1")]})
    sk_result = r["result"]["sk1"]
    edges = sk_result.get("topology", {}).get("edges", [])
    assert len(edges) > 0
    for edge in edges:
        assert "@sk1" in edge["query"], (
            f"edge query {edge['query']!r} should contain @sk1"
        )
