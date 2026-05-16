"""Tests for tier-2 partial ancestral resolver.

Feature: partial-ancestral-resolver.md
The resolver has three tiers:
  1. Full ancestral — query_set <= registered_key
  2. Partial ancestral — registered_key <= query_set (reverse direction, unique only)
  3. Geometry hash fallback
"""
import pytest
from oversolved.kernel.query import Repository
from oversolved.kernel.query import make_ancestry_query


def test_partial_resolves_when_unique():
    """Query carries an extra ancestor not in registration; tier 2 resolves it."""
    repo = Repository()
    payload = {"type": "face", "body_id": "body1", "created_by": "ex1"}
    # Registered under {A, B} but the query has {A, B, extra}
    repo.register_ancestor(["@A", "@B"], payload, geom_hash="gface_hash1")

    result = repo.query(make_ancestry_query(["@A", "@B", "@extra"]))
    assert result is not None
    assert result["created_by"] == "ex1"


def test_partial_ambiguous_yields_no_match():
    """Two elements share no common registered superset but both match tier 2."""
    repo = Repository()
    repo.register_ancestor(
        ["@A"], {"type": "face", "body_id": "body1", "created_by": "ex1"}, geom_hash="gface_a"
    )
    repo.register_ancestor(
        ["@B"], {"type": "face", "body_id": "body2", "created_by": "ex2"}, geom_hash="gface_b"
    )

    # Query has both @A and @B — tier 1 finds nothing (query is not subset of any key).
    # Tier 2 finds both (@A <= query_set and @B <= query_set) — returns nothing because >1.
    # Tier 3 hash fallback not consulted because no hash ids in query.
    q = make_ancestry_query(["@A", "@B"])
    result = repo.query(q)
    assert result is None


def test_partial_does_not_match_disjoint():
    """No subset relation either way — tier 2 finds nothing, falls to tier 3 (hash)."""
    repo = Repository()
    repo.register_ancestor(
        ["@A", "@B", "@C"], {"type": "face", "body_id": "body1", "created_by": "ex1"},
        geom_hash="gface_hash1",
    )

    # Query with completely different ancestors
    q = make_ancestry_query(["@gface_hash1", "@X", "@Y"])
    # @X, @Y have no subset relation with @A, @B, @C. Tier 1+2 miss.
    # Hash fallback resolves via @gface_hash1.
    result = repo.query(q)
    assert result is not None
    assert result["created_by"] == "ex1"


def test_full_match_wins_over_partial():
    """Tier 1 exact-match candidate is returned without scanning tier 2."""
    repo = Repository()
    payload_full = {"type": "face", "body_id": "body1", "created_by": "full"}
    payload_partial = {"type": "face", "body_id": "body2", "created_by": "partial"}

    repo.register_ancestor(["@A", "@B", "@C"], payload_full)
    # This one is a subset that would match tier 2
    repo.register_ancestor(["@A", "@B"], payload_partial)

    # Query matching the full set — tier 1 should resolve to payload_full immediately
    result = repo.query(make_ancestry_query(["@A", "@B", "@C"]))
    assert result is not None
    assert result["created_by"] == "full"


def test_partial_with_type_restriction():
    """Tier 2 respects type_restriction."""
    repo = Repository()
    repo.register_ancestor(
        ["@A", "@B"], {"type": "face", "body_id": "body1", "created_by": "ex1"},
        geom_hash="gface_h1",
    )
    # Query with extra ancestor + type restriction
    result = repo.query(make_ancestry_query(["@gface_h1", "@A", "@B", "@extra"], "face"))
    assert result is not None
    assert result["created_by"] == "ex1"

    result_wrong = repo.query(make_ancestry_query(["@gface_h1", "@A", "@B", "@extra"], "edge"))
    assert result_wrong is None


def test_tier1_subset_still_works():
    """Verify that existing tier 1 behaviour (query <= key) is undisturbed."""
    repo = Repository()
    repo.register_ancestor(
        ["@A", "@B", "@C"], {"type": "face", "body_id": "body1", "created_by": "ex1"}
    )
    # Query with fewer ancestors — tier 1 resolves it
    result = repo.query(make_ancestry_query(["@A"]))
    assert result is not None
    assert result["created_by"] == "ex1"
