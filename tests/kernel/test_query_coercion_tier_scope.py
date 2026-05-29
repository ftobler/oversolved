"""Characterization tests: type coercion is exact-tier only.

`_resolve_ancestry_ids` attempts `_coerce_type` (subtype / child->solid /
sibling scan) ONLY when the exact tier (query_set <= registered_key) produced
candidates. The recovery tiers -- partial-subset (registered_key <= query_set)
and the no-ancestry geometry-hash fallback -- filter by strict
`_obj_type == type_restriction` and never coerce.

This asymmetry is intentional and follows the fail-safe rule: once we are
already guessing (a partial or hash-only match), layering type coercion on top
widens the guess and invites a fail-wrong pick. These tests pin that contract
so a future refactor cannot quietly start coercing in the recovery tiers.
"""
from oversolved.kernel.query import Repository, make_ancestry_query


class FakeBody:
    def __init__(self, body_id: str):
        self.id = body_id


def _repo_with_flatface(ancestors, geom_hash=None):
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ancestors,
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0, "created_by": "ex1"},
        geom_hash=geom_hash,
    )
    return repo, body_store


def test_coercion_happens_in_exact_tier():
    """Baseline: an exact-tier flatface coerces up to its solid."""
    repo, body_store = _repo_with_flatface(["@A"])
    q = make_ancestry_query(["@A"], type_restriction="solid")
    assert repo.query(q, body_store=body_store) is body_store["body_ex1"]


def test_coercion_skipped_in_partial_tier():
    """Same flatface reached via the partial tier (query carries an extra id)
    does NOT coerce to solid -- strict type filter -> no match."""
    repo, body_store = _repo_with_flatface(["@A"])
    # query_set {@A, @extra} is not a subset of {@A}, so the exact tier misses
    # and the partial tier ({@A} <= {@A, @extra}) is what fires.
    q = make_ancestry_query(["@A", "@extra"], type_restriction="solid")
    assert repo.query(q, body_store=body_store) is None


def test_partial_tier_still_resolves_without_type_restriction():
    """Contrast: the same partial match resolves fine when no type is demanded."""
    repo, body_store = _repo_with_flatface(["@A"])
    q = make_ancestry_query(["@A", "@extra"])
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "flatface"


def test_coercion_skipped_in_hash_fallback_tier():
    """A face reached only via the no-ancestry hash fallback does NOT coerce."""
    repo, body_store = _repo_with_flatface(["@A"], geom_hash="gface_h")
    # @X shares no subset relation with @A (tiers 1+2 miss); only the precise
    # hash matches. With type_restriction=solid the strict filter drops it.
    q = make_ancestry_query(["@gface_h", "@X"], type_restriction="solid")
    assert repo.query(q, body_store=body_store) is None


def test_hash_fallback_resolves_without_type_restriction():
    """Contrast: the hash fallback resolves the face when no type is demanded."""
    repo, body_store = _repo_with_flatface(["@A"], geom_hash="gface_h")
    q = make_ancestry_query(["@gface_h", "@X"])
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "flatface"
