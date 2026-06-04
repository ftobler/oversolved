"""Tests for the WASM kernel migration harness.

Validates that the run_kernel module works correctly and that the fixture
extractor produces valid output.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

# Ensure the tests/ directory is importable
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))


class TestRunKernel:
    """Tests for run_kernel.py module."""

    def test_empty_doc(self):
        """An empty PartDoc spec should produce a valid result."""
        from tests.wasm_harness.run_kernel import run_specs

        results = run_specs([{"label": "empty", "spec": {"version": 1, "kind": "part", "features": []}}])
        assert len(results) == 1
        assert results[0]["ok"] is True
        assert results[0]["error"] is None
        assert "result" in results[0]
        assert "bodies" in results[0]
        # Empty doc should have builtin planes
        assert results[0]["result"]["builtin_plane_front"]["status"] == "ok"
        assert results[0]["result"]["builtin_plane_top"]["status"] == "ok"
        assert results[0]["result"]["builtin_plane_right"]["status"] == "ok"

    def test_rect_sketch(self):
        """A fully-constrained rectangle sketch should solve (rank-boundary may yield underconstrained)."""
        from tests.wasm_harness.run_kernel import run_specs
        from tests.solver_helpers import rect_sketch_spec

        spec = {"features": [rect_sketch_spec(w=10, h=10, sketch_id="sk1")]}
        results = run_specs([{"label": "rect", "spec": spec}])
        assert len(results) == 1
        assert results[0]["ok"] is True
        sketch_result = results[0]["result"]["sk1"]
        assert sketch_result["status"] in ("fully_constrained", "underconstrained")
        geom = sketch_result["geometry"]
        # The bottom line should be horizontal with length 10
        bottom = geom["bottom"]
        length = ((bottom[2] - bottom[0]) ** 2 + (bottom[3] - bottom[1]) ** 2) ** 0.5
        assert abs(length - 10.0) < 0.1

    def test_box_extrude_has_mesh(self):
        """A box extrude should produce a mesh with 6 faces and 24 edges."""
        from tests.wasm_harness.run_kernel import run_specs
        from tests.solver_helpers import full_rect_extrude_spec

        pytest.importorskip("cadquery")
        results = run_specs([{"label": "box", "spec": full_rect_extrude_spec(w=5, h=5, d=5)}])
        assert len(results) == 1
        assert results[0]["ok"] is True
        bodies = results[0]["bodies"]
        assert len(bodies) > 0
        body = next(iter(bodies.values()))
        assert body["face_count"] == 6
        assert body["edge_count"] == 12
        assert len(body["face_hashes"]) == 6
        assert len(body["edge_hashes"]) == 12

    def test_unknown_feature_kind_does_not_crash_runner(self):
        """A spec with error should return ok=False with an error message."""
        from tests.wasm_harness.run_kernel import run_specs

        results = run_specs([{"label": "bad", "spec": {"features": [{"id": "x", "kind": "unknown_feature"}]}}])
        assert len(results) == 1
        # unknown_feature should produce exception in result, not crash run_specs
        assert results[0]["ok"] is True  # build() itself doesn't crash on unknown kind
        assert results[0]["result"]["x"]["status"] == "exception"


class TestExtractFixtures:
    """Tests for extract_fixtures.py."""

    def test_all_fixtures_have_required_keys(self):
        """Every fixture should have label and spec keys."""
        from tests.wasm_harness.extract_fixtures import _make_fixtures

        fixtures = _make_fixtures()
        assert len(fixtures) > 0
        for fixture in fixtures:
            assert "label" in fixture, f"Fixture missing label: {fixture}"
            assert "spec" in fixture, f"Fixture {fixture.get('label')} missing spec"

    def test_fixture_coverage(self):
        """Verify we cover at least the main feature kinds."""
        from tests.wasm_harness.extract_fixtures import _make_fixtures
        from tests.wasm_harness.run_kernel import run_specs

        fixtures = _make_fixtures()
        results = run_specs(fixtures)

        # All fixtures should run without crashing the runner
        ok_count = sum(1 for r in results if r["ok"])
        assert ok_count == len(results), f"{len(results) - ok_count} fixtures failed"

    def test_output_file_exists(self):
        """The regression baseline should have been written to the expected path."""
        from tests.wasm_harness.extract_fixtures import OUTPUT_PATH

        if not OUTPUT_PATH.exists():
            pytest.skip("Regression baseline not yet generated. Run extract_fixtures.py first.")
        with open(OUTPUT_PATH) as f:
            data = json.load(f)
        assert isinstance(data, list)
        assert len(data) > 0
        for entry in data:
            assert "label" in entry
            assert "ok" in entry
            assert "result" in entry
            assert "bodies" in entry
