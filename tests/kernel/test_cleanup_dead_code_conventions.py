"""Tests for cleanup-dead-code-conventions changes."""


def test_plane_types_is_frozenset():
    from oversolved.kernel.solver_constants import _PLANE_TYPES
    assert isinstance(_PLANE_TYPES, frozenset)


def test_point_types_is_frozenset():
    from oversolved.kernel.solver_constants import _POINT_TYPES
    assert isinstance(_POINT_TYPES, frozenset)


def test_face_types_is_frozenset():
    from oversolved.kernel.solver_constants import _FACE_TYPES
    assert isinstance(_FACE_TYPES, frozenset)


def test_dead_typeddicts_removed():
    """Dead TypedDicts should no longer be importable from types3d."""
    import oversolved.kernel.types3d as t3d
    assert not hasattr(t3d, "FilletFeatureDef")
    assert not hasattr(t3d, "ChamferFeatureDef")
    assert not hasattr(t3d, "BooleanFeatureDef")
    assert not hasattr(t3d, "HoleFeatureDef")


def test_query_class_removed():
    """The bare Query wrapper class should no longer exist in query.py."""
    import oversolved.kernel.query as qmod
    assert not hasattr(qmod, "Query")


def test_snapshot_alias_removed():
    """_snapshot_with_brep_faces alias should no longer exist in builder."""
    import oversolved.kernel.builder as bmod
    assert not hasattr(bmod, "_snapshot_with_brep_faces")


def test_bare_id_map_at_module_level():
    """_BARE_ID_MAP should be accessible at module level in solver_plane."""
    from oversolved.kernel.solver_plane import _BARE_ID_MAP
    assert isinstance(_BARE_ID_MAP, dict)
    assert "Front" in _BARE_ID_MAP
    assert "Top" in _BARE_ID_MAP
    assert "Right" in _BARE_ID_MAP


def test_register_positional_still_works():
    """Repository.register() positional call should still work after param rename."""
    from oversolved.kernel.query import Repository
    repo = Repository()
    obj = {"v": 1}
    repo.register("key1", obj)
    assert repo.elements["key1"] is obj


def test_register_keyword_element_id():
    """Repository.register() keyword call with element_id= should work."""
    from oversolved.kernel.query import Repository
    repo = Repository()
    obj = {"v": 2}
    repo.register(element_id="key2", obj=obj)
    assert repo.elements["key2"] is obj
