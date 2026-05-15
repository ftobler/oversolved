"""Tests for _collinear_overlap degenerate-segment handling."""

import logging
from oversolved.kernel.topology import _collinear_overlap, detect_topology


def _line(x1, y1, x2, y2):
    return {"start": [x1, y1], "end": [x2, y2]}


def test_collinear_overlap_zero_length_segment_a():
    ea = _line(1.0, 0.0, 1.0, 0.0)  # zero length
    eb = _line(0.0, 0.0, 2.0, 0.0)
    assert _collinear_overlap(ea, eb) == []


def test_collinear_overlap_near_zero_segment_b():
    ea = _line(0.0, 0.0, 2.0, 0.0)
    eb = _line(1.0, 0.0, 1.0, 0.0)  # zero length
    assert _collinear_overlap(ea, eb) == []


def test_collinear_overlap_normal_case_unchanged():
    ea = _line(0.0, 0.0, 2.0, 0.0)
    eb = _line(1.0, 0.0, 3.0, 0.0)
    result = _collinear_overlap(ea, eb)
    assert len(result) > 0


def test_collinear_overlap_logs_degenerate(caplog):
    ea = _line(1.0, 0.0, 1.0, 0.0)  # zero length segment A
    eb = _line(0.0, 0.0, 2.0, 0.0)
    with caplog.at_level(logging.WARNING, logger="oversolved.kernel.topology"):
        _collinear_overlap(ea, eb)
    assert any("degenerate" in r.message for r in caplog.records)


def test_topology_with_degenerate_line():
    # A square plus a zero-length degenerate line; topology should still find the square surface.
    geometry = {
        "e1": {"kind": "line", "construction": False, **_line(0.0, 0.0, 1.0, 0.0)},
        "e2": {"kind": "line", "construction": False, **_line(1.0, 0.0, 1.0, 1.0)},
        "e3": {"kind": "line", "construction": False, **_line(1.0, 1.0, 0.0, 1.0)},
        "e4": {"kind": "line", "construction": False, **_line(0.0, 1.0, 0.0, 0.0)},
        "e5": {"kind": "line", "construction": False, **_line(0.5, 0.5, 0.5, 0.5)},  # degenerate
    }
    result = detect_topology(geometry)
    assert len(result["surfaces"]) == 1
