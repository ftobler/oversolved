from __future__ import annotations

import pytest
from oversolved.kernel.solver import _FEATURE_HANDLERS, _solve_feature
from oversolved.kernel.solver_constants import _KNOWN_FEATURE_KINDS


def test_all_constant_kinds_have_handlers() -> None:
    missing = _KNOWN_FEATURE_KINDS - _FEATURE_HANDLERS.keys()
    assert not missing, f"feature kinds with no handler: {missing}"


def test_feature_dispatch_unknown_kind_raises_valueerror() -> None:
    with pytest.raises(ValueError, match="unknown_xyz"):
        _solve_feature({"kind": "unknown_xyz"}, None, {})  # type: ignore[arg-type]


def test_feature_dispatch_none_kind_raises_valueerror() -> None:
    with pytest.raises(ValueError):
        _solve_feature({}, None, {})  # type: ignore[arg-type]
