from unittest.mock import patch

from oversolved.kernel.solver import _process_projected_entities, solve_features


def test_process_projected_entities_return_value_captured():
    """_process_projected_entities returns a set with the projected entity ID."""
    spec = {
        "features": [
            {
                "id": "sk0",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [{"id": "l1", "kind": "line"}],
                "initial": {"l1": [0.0, 0.0, 1.0, 0.0]},
                "constraints": [],
            },
            {
                "id": "sk1",
                "kind": "sketch",
                "plane": "@builtin_plane_front",
                "entities": [
                    {"id": "pl1", "kind": "projected_line", "source": "@sk0/l1"},
                ],
                "constraints": [],
            },
        ]
    }

    captured: list = []
    original = _process_projected_entities

    def _wrapper(feature, global_repo, initial, constraints):
        result = original(feature, global_repo, initial, constraints)
        captured.append((feature.get("id"), result))
        return result

    with patch("oversolved.kernel.solver._process_projected_entities", _wrapper):
        solve_features(spec)

    sk1_result = next(r for fid, r in captured if fid == "sk1")
    assert isinstance(sk1_result, set)
    assert "pl1" in sk1_result


def test_process_projected_entities_returns_empty_set_without_repo():
    """Without a global_repo, the function returns an empty set, not None."""
    feature = {
        "id": "sk0",
        "kind": "sketch",
        "plane": "@builtin_plane_front",
        "entities": [{"id": "pl1", "kind": "projected_line", "source": "@other/l1"}],
        "constraints": [],
    }
    initial: dict = {}
    constraints: list = []

    result = _process_projected_entities(feature, None, initial, constraints)

    assert isinstance(result, set)
    assert len(result) == 0
    assert initial == {}
    assert constraints == []


def test_process_projected_entities_returns_empty_set_no_projected_entities():
    """With a real repo but no projected-kind entities, the returned set is empty."""
    from oversolved.kernel.query import Repository

    repo = Repository()
    feature = {
        "id": "sk0",
        "kind": "sketch",
        "plane": "@builtin_plane_front",
        "entities": [{"id": "l1", "kind": "line"}],
        "constraints": [],
    }
    initial: dict = {}
    constraints: list = []

    result = _process_projected_entities(feature, repo, initial, constraints)

    assert isinstance(result, set)
    assert len(result) == 0
    assert initial == {}
    assert constraints == []
