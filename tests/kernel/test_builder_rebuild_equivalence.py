"""Happy-path tests for the rebuild-assertion framework (_validate_incremental).

User invariant (solver_arch.user.md §Rebuild Button / #219):
  "A rebuild must produce the same result as the current incremental state.
   If different, the model is desynced/broken."

Defends the _validate_incremental pipeline itself: if the comparator is
silently broken, the assertion badge would always show green even when the
incremental state drifted from a fresh build.  If this test fails, suspect
a regression in _validate_incremental or _diff_repo_snapshot.
"""
import pytest

from solver_helpers import rect_sketch_spec, extrude_spec


def _boolean_stack():
    """Two boxes fused together by a boolean add-as-new then fused.

    Uses separate bodies that get fused to give the validation framework a
    non-trivial repo snapshot to compare (multiple ancestral entries).
    """
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=10.0)

    sk2 = rect_sketch_spec(w=8.0, h=8.0, sketch_id="sk2")
    sk2["initial"] = {
        "bottom": [8, 0, 16, 0],
        "right": [16, 0, 16, 8],
        "top": [16, 8, 8, 8],
        "left": [8, 8, 8, 0],
    }
    sk2["constraints"] = [
        c for c in sk2["constraints"] if c["id"] not in ("c9", "c10")
    ]
    sk2["constraints"].extend([
        {"id": "c9", "kind": "length", "target": {"entity": "bottom"}, "value": 8.0},
        {"id": "c10", "kind": "length", "target": {"entity": "left"}, "value": 8.0},
    ])
    ex2 = extrude_spec("sk2", "ex2", distance=8.0)
    return [sk1, ex1, sk2, ex2]


def test_rebuild_equivalence_incremental_passes():
    """Incremental build of a multi-feature stack passes all three validation layers.

    Setup: full build → make a small geometric change → incremental build.
    Validation of the incremental state against a fresh rebuild must pass.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _validate_incremental

    features = _boolean_stack()

    # Full build to establish prev_state.
    r_full = build({"features": features})
    assert r_full["result"]["ex1"]["status"] == "ok"
    prev_state = r_full["_build_state"]

    # Small edit: change ex2's distance (only ex2 becomes dirty).
    modified_features = features[:]
    modified_features[3] = extrude_spec("sk2", "ex2", distance=9.0)
    doc = {"features": modified_features}

    # Incremental build reusing prev_state checkpoints up to the first dirty feature.
    r_inc = build(doc, prev_state=prev_state)
    assert r_inc["result"]["ex1"]["status"] == "ok"
    assert r_inc["result"]["ex2"]["status"] == "ok"

    v = _validate_incremental(r_inc["_build_state"], r_inc["result"], doc)
    assert v["passed"] is True, f"validation unexpectedly failed: {v}"
    assert v["level"] == 3
    assert v["diffs"] == {}


def test_rebuild_equivalence_corrupt_created_by_fails():
    """Corrupting a body's created_by in the incremental state triggers a level-3 failure.

    This is the control test: verifies the comparator catches body_store drift.
    Without this, a bug in _diff_repo_snapshot could silently swallow corruption.
    """
    pytest.importorskip("OCP.gp")
    from oversolved.kernel.builder import build, _validate_incremental

    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    doc = {"features": [sk1, ex1]}

    r = build(doc)
    assert r["result"]["ex1"]["status"] == "ok"

    state = r["_build_state"]
    # Corrupt the body_store_snapshot in the ex1 checkpoint.
    body = state.checkpoints["ex1"].body_store_snapshot.get("body_ex1")
    assert body is not None, "body_ex1 missing from checkpoint"
    body.created_by = "TAMPERED"

    v = _validate_incremental(state, r["result"], doc)
    assert v["passed"] is False, "validation should have caught the created_by corruption"
    assert v["level"] == 3
