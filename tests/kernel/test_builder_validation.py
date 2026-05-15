"""Rebuild assertion tests.

User invariant (solver_arch.user.md §Rebuild Button):
  "A rebuild must produce the same result as the current state.
   If different → desynced/broken."

These tests cover the three-layer validation helpers and the opt-in
_validate flow in build().
"""

import pytest

from oversolved.kernel.builder import (
    build,
    _hash_checkpoint_spec,
    _hash_result_dict,
    _validate_incremental,
)
from oversolved.kernel.types3d import FeatureCheckpoint
from solver_helpers import rect_sketch_spec, extrude_spec


def test_hash_checkpoint_spec_stable():
    cp1 = FeatureCheckpoint(spec={"id": "x", "kind": "extrude", "distance": 3.0},
                            result={}, repo_snapshot={"elements": {}, "ancestral": {}},
                            body_store_snapshot={})
    cp2 = FeatureCheckpoint(spec={"distance": 3.0, "kind": "extrude", "id": "x"},
                            result={}, repo_snapshot={"elements": {}, "ancestral": {}},
                            body_store_snapshot={})
    assert _hash_checkpoint_spec(cp1) == _hash_checkpoint_spec(cp2)


def test_hash_result_dict_strict_vs_fp():
    a = {"ex1": {"vertex": [1.0, 2.0, 3.0]}}
    b = {"ex1": {"vertex": [1.0000001, 2.0, 3.0]}}
    assert _hash_result_dict(a) != _hash_result_dict(b)  # strict catches drift
    assert _hash_result_dict(a, fp_round=4) == _hash_result_dict(b, fp_round=4)  # fp tolerates


def test_hash_result_dict_structural_diff_still_caught_with_fp_round():
    a = {"ex1": {"status": "ok"}}
    b = {"ex1": {"status": "error"}}
    assert _hash_result_dict(a, fp_round=4) != _hash_result_dict(b, fp_round=4)


def test_builder_validate_incremental_passes():
    """Healthy doc -> all three layers green."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    spec = {"features": [sk1, ex1], "_validate": True}
    r = build(spec)
    v = r["_validation"]
    assert v["passed"] is True
    assert v["level"] == 3
    assert v["diffs"] == {}


def test_builder_validate_incremental_catches_mutation():
    """Manually corrupt a checkpoint result; validation must flag a structural diff."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    spec = {"features": [sk1, ex1]}
    r = build(spec)
    state = r["_build_state"]
    state.checkpoints["ex1"].result["status"] = "TAMPERED"
    # Use the corrupted incremental_result so L2 detects the mismatch.
    incremental_result = dict(r["result"])
    incremental_result["ex1"] = dict(incremental_result["ex1"])
    incremental_result["ex1"]["status"] = "TAMPERED"
    v = _validate_incremental(state, incremental_result, spec)
    assert v["passed"] is False
    assert v["level"] in (2, 3)
    assert not v.get("fp_only")


def test_builder_validate_incremental_catches_fp_noise():
    """1e-7 perturbation in a result float -> L2 fp_only=True."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    spec = {"features": [sk1, ex1]}
    r = build(spec)
    state = r["_build_state"]

    # Walk a few floats in the incremental_result and nudge them by 1e-7.
    incremental_result = _deep_perturb(dict(r["result"]), epsilon=1e-7)
    v = _validate_incremental(state, incremental_result, spec)
    assert v["passed"] is False
    assert v["level"] == 2
    assert v.get("fp_only") is True


def test_builder_validate_incremental_catches_repo_drift():
    """Drop an element from a checkpoint's repo snapshot; L3 catches it."""
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    spec = {"features": [sk1, ex1]}
    r = build(spec)
    state = r["_build_state"]

    ancestral = state.checkpoints["ex1"].repo_snapshot["ancestral"]
    assert ancestral, "expected ancestral entries to remove"
    first_key = next(iter(ancestral))
    ancestral.pop(first_key)

    v = _validate_incremental(state, r["result"], spec)
    assert v["passed"] is False
    assert v["level"] == 3
    assert "repo_ancestral" in v["diffs"] or v["diffs"]


def test_build_with_validate_flag_attaches_validation_key():
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    r = build({"features": [sk1, ex1], "_validate": True})
    assert "_validation" in r
    assert r["_validation"]["passed"] is True


def test_build_without_validate_flag_does_not_attach_validation():
    pytest.importorskip("OCP.gp")
    sk1 = rect_sketch_spec(w=10.0, h=10.0, sketch_id="sk1")
    ex1 = extrude_spec("sk1", "ex1", distance=5.0)
    r = build({"features": [sk1, ex1]})
    assert "_validation" not in r


def _deep_perturb(obj, *, epsilon: float):
    if isinstance(obj, float):
        return obj + epsilon
    if isinstance(obj, dict):
        return {k: _deep_perturb(v, epsilon=epsilon) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_deep_perturb(v, epsilon=epsilon) for v in obj]
    return obj
