import secrets
import pytest
from oversolved.kernel.query import Repository, AmbiguousQueryError, _parse_ancestry
from oversolved.kernel.solver_registry import (
    _register_topology_edges,
    _register_topology_vertices,
    _clear_feature_geometry_registrations,
)


_PLANE_OBJ = {
    "x_axis": [1, 0, 0],
    "y_axis": [0, 1, 0],
    "normal": [0, 0, 1],
    "origin": [0, 0, 0],
}

_EDGE_QUERY = "?2,4;e1line"

_TOPOLOGY_ONE_EDGE = {
    "surfaces": [],
    "edges": [
        {
            "query": _EDGE_QUERY,
            "start": [0.0, 0.0],
            "end": [1.0, 0.0],
            "kind": "line",
        }
    ],
    "vertices": {
        "v1": {"x": 0.0, "y": 0.0}
    },
}


def _ancestral_count_for_query(repo: Repository, query: str) -> int:
    ids, _ = _parse_ancestry(query)
    key = frozenset(ids)
    return len(repo.ancestral.get(key, []))


def test_edge_no_accumulation_on_resolves():
    repo = Repository()
    for _ in range(10):
        _register_topology_edges(repo, _TOPOLOGY_ONE_EDGE, _PLANE_OBJ)
    assert _ancestral_count_for_query(repo, _EDGE_QUERY) == 1


def test_vertex_no_accumulation_on_resolves():
    repo = Repository()
    topology = {
        "surfaces": [],
        "edges": [],
        "vertices": {"v1": {"x": 0.0, "y": 0.0}},
    }
    for _ in range(10):
        _register_topology_vertices(repo, topology, _PLANE_OBJ, feature_id="sk1")

    # Find the vertex ancestral key by scanning all entries
    vertex_counts = []
    for key, eids in repo.ancestral.items():
        payloads = [repo.elements.get(eid) for eid in eids]
        if any(isinstance(p, dict) and p.get("type") == "vertex" for p in payloads):
            vertex_counts.append(len(eids))

    assert vertex_counts, "expected at least one vertex registered"
    for count in vertex_counts:
        assert count == 1, f"vertex accumulated {count} entries, expected 1"


def test_edge_replaced_on_changed_geometry():
    repo = Repository()

    topo_v1 = {
        "surfaces": [],
        "edges": [
            {
                "query": _EDGE_QUERY,
                "start": [0.0, 0.0],
                "end": [1.0, 0.0],
                "kind": "line",
            }
        ],
        "vertices": {},
    }
    topo_v2 = {
        "surfaces": [],
        "edges": [
            {
                "query": _EDGE_QUERY,
                "start": [0.0, 0.0],
                "end": [2.0, 0.0],
                "kind": "line",
            }
        ],
        "vertices": {},
    }

    _register_topology_edges(repo, topo_v1, _PLANE_OBJ)
    _register_topology_edges(repo, topo_v2, _PLANE_OBJ)

    ids, _ = _parse_ancestry(_EDGE_QUERY)
    key = frozenset(ids)
    eids = repo.ancestral.get(key, [])
    assert len(eids) == 1, f"expected 1 entry after update, got {len(eids)}"

    payload = repo.elements.get(eids[0])
    assert payload is not None
    assert payload["end"][0] == pytest.approx(2.0), "end coordinate should reflect updated geometry"


def test_clear_removes_all_accumulated_elements():
    repo = Repository()

    # Simulate the accumulation bug: inject 3 elements for the same ancestral key
    sketch_id = "sk_test"
    key = frozenset(["ancestor_a", "ancestor_b"])
    for i in range(3):
        eid = secrets.token_urlsafe(9)
        repo.ancestral.setdefault(key, []).append(eid)
        repo.elements[eid] = {"type": "straightedge", "sketch_id": sketch_id, "idx": i}

    assert len(repo.ancestral[key]) == 3

    _clear_feature_geometry_registrations(repo, sketch_id)

    # All 3 elements must be gone
    remaining = [eid for eid in repo.elements if repo.elements[eid].get("sketch_id") == sketch_id]
    assert remaining == [], f"expected all elements cleared, found: {remaining}"

    # The ancestral key itself must be gone
    assert key not in repo.ancestral, "ancestral key should be removed after full clear"


def test_no_ambiguous_query_after_resolves():
    from oversolved.kernel.solver import _post_register, _init_global_repo

    topology = {
        "surfaces": [],
        "edges": [
            {
                "query": "?2,4;e1line",
                "start": [0.0, 0.0],
                "end": [1.0, 0.0],
                "kind": "line",
            }
        ],
        "vertices": {
            "v1": {"x": 0.0, "y": 0.0}
        },
    }
    feature = {
        "id": "sk1",
        "kind": "sketch",
        "plane": "@builtin_plane_front",
        "entities": [],
    }
    feature_result = {
        "status": "ok",
        "geometry": {},
        "plane_transform": {"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "origin": [0, 0, 0]},
        "topology": topology,
    }

    repo = _init_global_repo()
    for _ in range(5):
        _post_register(repo, "sk1", feature, feature_result)

    # Querying the edge must not raise AmbiguousQueryError
    edge_query = "?2,4;e1line"
    try:
        result = repo.query(edge_query)
    except AmbiguousQueryError as exc:
        pytest.fail(f"AmbiguousQueryError raised after repeated _post_register calls: {exc}")

    assert result is not None, "edge query should resolve to a valid element"
