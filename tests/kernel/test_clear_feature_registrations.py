"""Characterization tests for feature-geometry registration cleanup.

Two related contracts:

1. `Repository.clear_by_sketch_id` is *elements-only*: it removes direct
   `register()`-keyed payloads carrying the sketch_id but does NOT prune the
   `ancestral` index. Used standalone it could leave ancestral lists pointing
   at removed element ids. It is therefore only safe when paired with ancestral
   cleanup -- which is exactly how `_clear_feature_geometry_registrations`
   calls it (ancestral entries first, then clear_by_sketch_id for the rest).

2. `_clear_feature_geometry_registrations` -- the real entry point -- must
   leave no dangling references: every eid still listed in any ancestral list
   must still exist in `elements`.
"""
from oversolved.kernel.query import Repository
from oversolved.kernel.solver_registry import _clear_feature_geometry_registrations


def test_clear_by_sketch_id_can_dangle_standalone():
    """Standalone clear_by_sketch_id removes every elements[*] payload carrying
    the sketch_id -- including ancestral-registered payloads, which
    register_ancestor also stores in elements -- but does NOT prune the
    ancestral index. Called on its own it therefore leaves a dangling ref: a
    token still listed in ancestral but absent from elements.

    This is precisely why _clear_feature_geometry_registrations prunes the
    ancestral entries first and only then calls clear_by_sketch_id for the
    remaining direct elements (see the next test).
    """
    repo = Repository()
    eid = repo.register_ancestor(
        ["@sketch1/line1", "@sketch1"],
        {"type": "flatface", "sketch_id": "sketch1"},
    )
    repo.register("sketch1/line1", {"external_params": [0, 0, 1, 0], "sketch_id": "sketch1"})

    repo.clear_by_sketch_id("sketch1")

    # Both payloads are gone from elements...
    assert "sketch1/line1" not in repo.elements
    assert eid not in repo.elements
    # ...but the ancestral list still references the now-removed token (dangling).
    assert any(eid in eids for eids in repo.ancestral.values())


def test_clear_feature_registrations_leaves_no_dangling_refs():
    """The orchestration prunes ancestral + elements together: no dangling eid."""
    repo = Repository()
    # Topology-style entry: key carries the bare @sketch1 tag.
    topo_eid = repo.register_ancestor(
        ["@sketch1/line1", "surface:0", "@sketch1"],
        {"type": "flatface", "sketch_id": "sketch1"},
    )
    # Direct entity-param elements (slash keys) carrying the sketch_id.
    repo.register("sketch1/line1", {"external_params": [0, 0, 1, 0], "sketch_id": "sketch1"})
    repo.register("sketch1/line1/start", {"external_xy": [0, 0], "sketch_id": "sketch1"})
    # An unrelated feature must survive cleanup untouched.
    other_eid = repo.register_ancestor(
        ["@sketch2/line1", "@sketch2"],
        {"type": "flatface", "sketch_id": "sketch2"},
    )

    _clear_feature_geometry_registrations(repo, "sketch1")

    # No ancestral list references an eid that is missing from elements.
    for key, eids in repo.ancestral.items():
        for eid in eids:
            assert eid in repo.elements, f"dangling {eid} under {key}"

    # sketch1 geometry is fully gone from both indices.
    assert topo_eid not in repo.elements
    assert "sketch1/line1" not in repo.elements
    assert "sketch1/line1/start" not in repo.elements

    # sketch2 survives.
    assert other_eid in repo.elements
