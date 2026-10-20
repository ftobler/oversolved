"""Tests for frontend/scripts/cadqueryReference.py.

The runner is the dev-only bridge that turns a CadQuery script into a
translation `reference.json`. It needs CadQuery, so this module skips entirely
when the optional extra is absent; CI installs `.[dev]` and never fetches the
OCP wheel. Locally the assertions pin the reference format, the bbox order and
the default tolerance, so a hand-written or drifted reference cannot pass.
"""

import importlib.metadata
import importlib.util
import json
import pathlib

import pytest

cq = pytest.importorskip("cadquery")

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRIPT = REPO_ROOT / "frontend" / "scripts" / "cadqueryReference.py"

spec = importlib.util.spec_from_file_location("cadqueryReference", SCRIPT)
assert spec is not None and spec.loader is not None
cadqueryReference = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cadqueryReference)


def read_reference(path: pathlib.Path) -> dict:
    return json.loads(path.read_text())


def test_build_reference_measures_a_shape_with_an_ordered_bbox() -> None:
    # Asymmetric on every axis so a swapped bbox pair cannot pass by symmetry.
    shape = cq.Workplane("XY").box(4, 6, 8, centered=False)
    reference = cadqueryReference.build_reference(
        shape,
        version="test",
        source_file="source.py",
    )

    assert reference["source"] == {"tool": "cadquery", "version": "test", "file": "source.py"}
    assert reference["tolerance"] == {"rel": 1e-5, "abs": 1e-6}
    assert reference["topology"] == "report"
    assert reference["bodies"] == 1
    assert reference["volume"] == pytest.approx(192)
    assert reference["centroid"] == pytest.approx([2, 3, 4])
    assert reference["bbox"] == pytest.approx([0, 0, 0, 4, 6, 8])
    assert reference["faces"] == 6
    assert reference["edges"] == 12


def test_measure_accepts_a_bare_shape() -> None:
    shape = cq.Workplane("XY").box(2, 2, 2, centered=False).val()
    measures = cadqueryReference.measure(shape)

    assert measures["bodies"] == 1
    assert measures["bbox"] == pytest.approx([0, 0, 0, 2, 2, 2])


def test_main_writes_a_reference_for_the_script_result(tmp_path: pathlib.Path) -> None:
    source = tmp_path / "source.py"
    out = tmp_path / "reference.json"
    source.write_text(
        "result = cq.Workplane('XY').box(4, 5, 6, centered=False)\n"
    )

    assert cadqueryReference.main([str(source), "--out", str(out)]) == 0

    reference = read_reference(out)
    assert reference["source"]["tool"] == "cadquery"
    assert reference["source"]["version"] == importlib.metadata.version("cadquery")
    assert reference["source"]["file"] == "source.py"
    assert reference["tolerance"] == {"rel": 1e-5, "abs": 1e-6}
    assert reference["bbox"] == pytest.approx([0, 0, 0, 4, 5, 6])


def test_tolerance_and_topology_overrides_reach_the_reference(tmp_path: pathlib.Path) -> None:
    source = tmp_path / "source.py"
    out = tmp_path / "reference.json"
    source.write_text("model = cq.Workplane('XY').box(1, 1, 1)\n")

    cadqueryReference.main(
        [str(source), "--out", str(out), "--rel", "1e-3", "--abs", "1e-4", "--topology", "strict"]
    )

    reference = read_reference(out)
    assert reference["tolerance"] == {"rel": 1e-3, "abs": 1e-4}
    assert reference["topology"] == "strict"


def test_step_export_is_optional_and_writes_step_bytes(tmp_path: pathlib.Path) -> None:
    source = tmp_path / "source.py"
    out = tmp_path / "reference.json"
    step = tmp_path / "model.step"
    source.write_text("result = cq.Workplane('XY').box(1, 1, 1)\n")

    cadqueryReference.main([str(source), "--out", str(out), "--step", str(step)])

    assert step.read_text().startswith("ISO-10303-21")


def test_script_without_a_named_result_is_refused(tmp_path: pathlib.Path) -> None:
    source = tmp_path / "source.py"
    source.write_text("shape = 1\n")

    with pytest.raises(SystemExit, match="`result`"):
        cadqueryReference.execute_source(source)
