"""Guard the committed fit-spline golden fixture.

`sketch-solver/src/fit_spline/golden.json` is generated from OCP by
`tests/fit_spline_golden.py` and read by both the Rust and the TypeScript
suites. The first test pins the file's shape so a truncated or hand-edited
fixture fails; the second regenerates it when OCP imports and requires an exact
match, so the committed data cannot drift from the oracle.
"""

from __future__ import annotations

import importlib.util
import json
import pathlib
from typing import Any

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
GOLDEN = ROOT / "sketch-solver" / "src" / "fit_spline" / "golden.json"

spec = importlib.util.spec_from_file_location(
    "fit_spline_golden", ROOT / "tests" / "fit_spline_golden.py"
)
assert spec is not None and spec.loader is not None
golden_generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(golden_generator)


def read_golden() -> dict[str, Any]:
    return json.loads(GOLDEN.read_text())


def test_the_fixture_parses_and_covers_every_required_case() -> None:
    fixture = read_golden()
    assert fixture["source"]["tool"] == "OCP"
    assert fixture["samples_per_span"] == 9
    cases = fixture["cases"]
    names = {case["name"] for case in cases}
    # The plan's required cases: Ex010, 2..5 points without handles, both
    # handles with and without scaling, and one handle for 3..5 points.
    required = {
        "ex010",
        "n2",
        "n3",
        "n4",
        "n5",
        "n2_both_noscale",
        "n3_both_noscale",
        "n4_both_noscale",
        "n5_both_noscale",
        "n3_start_noscale",
        "n4_start_noscale",
        "n5_start_noscale",
        "n3_end_noscale",
        "n4_end_noscale",
        "n5_end_noscale",
        "n2_both_scale",
        "n3_both_scale",
        "n4_both_scale",
        "n5_both_scale",
    }
    assert names == required
    for case in cases:
        # A case carries every field the readers index.
        for key in (
            "points",
            "handle_start",
            "handle_end",
            "poles",
            "knots",
            "mults",
            "chain",
            "tangent_start",
            "tangent_end",
            "samples",
        ):
            assert key in case, f"{case['name']} lacks {key}"
        assert len(case["samples"]) == len(case["points"]) - 1
        assert len(case["chain"]) == 3 * (len(case["points"]) - 1) + 1


def test_ex010_matches_the_plan_reference_numbers() -> None:
    # The plan pins these knots and the 10-pole C2 form; they are the fixture's
    # independent anchor, not just a copy of whatever OCP printed.
    case = next(c for c in read_golden()["cases"] if c["name"] == "ex010")
    assert case["knots"] == pytest.approx(
        [
            0.0,
            0.5590169943749475,
            0.9125703849682212,
            1.4715873793431686,
            2.1786941605297163,
            2.7377111549046638,
            3.296728149279611,
            3.796728149279611,
        ]
    )
    assert case["mults"] == [4, 1, 1, 1, 1, 1, 1, 4]
    assert len(case["poles"]) == 10


@pytest.mark.skipif(
    importlib.util.find_spec("OCP") is None,
    reason="OCP (the CadQuery extra) is not installed",
)
def test_the_committed_fixture_is_what_the_generator_produces() -> None:
    assert golden_generator.build_cases() == read_golden()
