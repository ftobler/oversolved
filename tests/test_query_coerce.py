"""Tests for smart query type coercion in Repository.query()."""
from oversolved.query import Repository, make_ancestry_query


class FakeBody:
    def __init__(self, body_id: str):
        self.id = body_id


def test_query_coerce_face_to_solid():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0},
    )
    q = make_ancestry_query(["@ex1"], type_restriction="solid")
    result = repo.query(q, body_store=body_store)
    assert result is body_store["body_ex1"]


def test_query_coerce_solid_to_face():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1"],
        {"type": "solid", "body_id": "body_ex1"},
    )
    repo.register_ancestor(
        ["@ex1face0", "@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0},
    )
    q = make_ancestry_query(["@ex1"], type_restriction="face")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "flatface"


def test_query_coerce_edge_to_vertex():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1edge0", "@ex1"],
        {"type": "straightedge", "body_id": "body_ex1", "edge_index": 0},
    )
    repo.register_ancestor(
        ["@ex1vertex0", "@ex1"],
        {"type": "vertex", "body_id": "body_ex1", "vertex_index": 0},
    )
    q = make_ancestry_query(["@ex1edge0", "@ex1"], type_restriction="vertex")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "vertex"


def test_query_exact_match_takes_precedence():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1"],
        {"type": "face", "body_id": "body_ex1"},
    )
    repo.register_ancestor(
        ["@ex1"],
        {"type": "solid", "body_id": "body_ex1"},
    )
    q = make_ancestry_query(["@ex1"], type_restriction="face")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "face"


def test_query_coerce_flatface_subtype_matches_face():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0},
    )
    q = make_ancestry_query(["@ex1"], type_restriction="face")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "flatface"


def test_query_no_coercion_when_body_store_missing():
    repo = Repository()
    repo.register_ancestor(
        ["@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0},
    )
    q = make_ancestry_query(["@ex1"], type_restriction="solid")
    result = repo.query(q)
    assert result is None


def test_query_coerce_face_to_edge():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1face0", "@ex1"],
        {"type": "flatface", "body_id": "body_ex1", "face_index": 0},
    )
    repo.register_ancestor(
        ["@ex1edge0", "@ex1"],
        {"type": "straightedge", "body_id": "body_ex1", "edge_index": 0},
    )
    q = make_ancestry_query(["@ex1face0", "@ex1"], type_restriction="edge")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "straightedge"


def test_query_coerce_solid_to_edge():
    repo = Repository()
    body_store = {"body_ex1": FakeBody("body_ex1")}
    repo.register_ancestor(
        ["@ex1"],
        {"type": "solid", "body_id": "body_ex1"},
    )
    repo.register_ancestor(
        ["@ex1edge0", "@ex1"],
        {"type": "straightedge", "body_id": "body_ex1", "edge_index": 0},
    )
    q = make_ancestry_query(["@ex1"], type_restriction="edge")
    result = repo.query(q, body_store=body_store)
    assert isinstance(result, dict)
    assert result["type"] == "straightedge"
