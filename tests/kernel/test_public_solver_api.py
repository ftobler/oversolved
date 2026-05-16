"""Snapshot test for the public solver facade API.

This test detects accidental removals of public names from the solver module.
If a name is legitimately removed, update the snapshot below.
"""

import oversolved.kernel.solver as solver_mod

# Minimum expected public names in the solver facade.
_EXPECTED_PUBLIC = {
    "solve",
    "solve_features",
    "_try_solve_feature",
    "_init_global_repo",
    "_post_register",
}


def test_public_solver_api():
    """All expected public names must still be present in the solver facade."""
    available = set(dir(solver_mod))
    missing = _EXPECTED_PUBLIC - available
    assert not missing, (
        f"The following names were removed from oversolved.kernel.solver: {missing!r}. "
        "If this is intentional, update _EXPECTED_PUBLIC in this test."
    )
