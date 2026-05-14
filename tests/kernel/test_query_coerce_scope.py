"""Tests that _coerce_type scopes its search to the same created_by feature."""
from oversolved.kernel.query import Repository, make_ancestry_query


class FakeBody:
    def __init__(self, body_id: str):
        self.id = body_id


def test_coerce_within_same_feature():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1face0", "@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0, "created_by": "ex1"},
    )
    repo.register_ancestor(
        ["@ex1edge0", "@ex1"],
        {"type": "straightedge", "body_id": "body_ex1", "edge_index": 0, "created_by": "ex1"},
    )
    q = make_ancestry_query(["@ex1face0", "@ex1"], type_restriction="edge")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "straightedge"


def test_coerce_fails_across_features():
    repo = Repository()
    body_store = {"shared_body": FakeBody("shared_body")}
    # face from feature ex1, edge from feature ex2 -- both share the same body_id
    repo.register_ancestor(
        ["@ex1face0", "@ex1"],
        {"type": "flatface", "body_id": "shared_body", "face_index": 0, "created_by": "ex1"},
    )
    repo.register_ancestor(
        ["@ex2edge0", "@ex2"],
        {"type": "straightedge", "body_id": "shared_body", "edge_index": 0, "created_by": "ex2"},
    )
    # Querying the ex1 face for an edge should NOT return the ex2 edge
    q = make_ancestry_query(["@ex1face0", "@ex1"], type_restriction="edge")
    result = repo.query(q, body_store=body_store)
    assert result is None


def test_coerce_rejects_missing_created_by():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1face0", "@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0},  # no created_by
    )
    repo.register_ancestor(
        ["@ex1edge0", "@ex1"],
        {"type": "straightedge", "body_id": "body_ex1", "edge_index": 0},  # no created_by
    )
    q = make_ancestry_query(["@ex1face0", "@ex1"], type_restriction="edge")
    result = repo.query(q, body_store=body_store)
    assert result is None
