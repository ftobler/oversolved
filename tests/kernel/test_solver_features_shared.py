"""Tests for _resolve_face_profile ancestry order sensitivity (fix-136)."""
import pytest
from oversolved.kernel.query import Repository, make_ancestry_query
from oversolved.kernel.solver_features_shared import _resolve_face_profile


def _make_repo_with_surfaces(surfaces: list[dict], sketch_id: str = "sk1", ancestor_ids: list[str] | None = None) -> Repository:
    """Build a minimal repo with _pt_ and _topo_ entries for _resolve_face_profile.

    Also registers an ancestral placeholder element so that global_repo.query()
    on the ?-query returns a non-None result (without body_id/face_index), allowing
    the function to fall through to the ?-path that does the surface matching.
    """
    repo = Repository()
    repo.elements[f"_pt_{sketch_id}"] = {
        "origin": [0, 0, 0],
        "normal": [0, 0, 1],
        "x_dir": [1, 0, 0],
    }
    repo.elements[f"_topo_{sketch_id}"] = {"surfaces": surfaces}
    ids = ancestor_ids if ancestor_ids is not None else [f"@{sketch_id}"]
    repo.register_ancestor(ids, {"type": "sketch_surface"})
    return repo


def _surface(query: str) -> dict:
    return {"query": query, "loops": []}


def test_ancestry_order_matters() -> None:
    """?@sk1/@B and ?@B/@sk1 must resolve to different surfaces."""
    q_ab = make_ancestry_query(["@sk1", "@B"])
    q_ba = make_ancestry_query(["@B", "@sk1"])

    surface_ab = _surface(q_ab)
    surface_ba = _surface(q_ba)

    # Two separate repos so each query has the right ancestral placeholder
    repo_ab = _make_repo_with_surfaces([surface_ab, surface_ba], ancestor_ids=["@sk1", "@B"])
    repo_ba = _make_repo_with_surfaces([surface_ab, surface_ba], ancestor_ids=["@B", "@sk1"])

    matched_ab, _ = _resolve_face_profile(q_ab, repo_ab, {})
    matched_ba, _ = _resolve_face_profile(q_ba, repo_ba, {})

    assert matched_ab == surface_ab["loops"]
    assert matched_ba == surface_ba["loops"]


def test_ancestry_order_single_id_unaffected() -> None:
    """Single-ID ancestry queries still resolve correctly."""
    q = make_ancestry_query(["@sk1"])
    surface = _surface(q)
    repo = _make_repo_with_surfaces([surface], ancestor_ids=["@sk1"])

    matched, _ = _resolve_face_profile(q, repo, {})
    assert matched == surface["loops"]


def test_ancestry_order_three_ids() -> None:
    """Three-element ancestry paths are order-sensitive."""
    q_abc = make_ancestry_query(["@sk1", "@B", "@C"])
    q_acb = make_ancestry_query(["@sk1", "@C", "@B"])

    surface_abc = _surface(q_abc)
    surface_acb = _surface(q_acb)

    repo_abc = _make_repo_with_surfaces([surface_abc, surface_acb], ancestor_ids=["@sk1", "@B", "@C"])
    repo_acb = _make_repo_with_surfaces([surface_abc, surface_acb], ancestor_ids=["@sk1", "@C", "@B"])

    matched, _ = _resolve_face_profile(q_abc, repo_abc, {})
    assert matched == surface_abc["loops"]

    matched, _ = _resolve_face_profile(q_acb, repo_acb, {})
    assert matched == surface_acb["loops"]
