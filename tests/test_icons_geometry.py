"""Behavior tests for the drawing-math helpers in the oversolved/icons/ package.

The icon engine (icon_cairo) is covered elsewhere; the registry is covered in
test_icons.py. The geometry helpers those 72 icons share were not: a dotted
line that stopped short of its endpoint, or an arrowhead that pointed the wrong
way, would render every icon built from it wrong without any test noticing.

These drive the helpers against a recording context so the assertions are on
the coordinates the helper actually computes, not on the cairo surface.
"""

import math
import pathlib

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent


def _load(monkeypatch):
    # The icons package imports icon_cairo as a top-level module, mirroring `just icons`.
    monkeypatch.syspath_prepend(str(ROOT / "oversolved"))
    import icons

    return icons


class RecordingCtx:
    """A pycairo-context stand-in that records the drawing calls it receives."""

    def __init__(self) -> None:
        self.ops: list[tuple[str, tuple[float, ...]]] = []

    def move_to(self, x: float, y: float) -> None:
        self.ops.append(("move_to", (x, y)))

    def line_to(self, x: float, y: float) -> None:
        self.ops.append(("line_to", (x, y)))

    def close_path(self) -> None:
        self.ops.append(("close_path", ()))

    def set_line_width(self, width: float) -> None:
        self.ops.append(("set_line_width", (width,)))

    def stroke(self) -> None:
        self.ops.append(("stroke", ()))

    def fill(self) -> None:
        self.ops.append(("fill", ()))

    def points(self, op: str) -> list[tuple[float, ...]]:
        return [coords for name, coords in self.ops if name == op]


def _on_segment(
    point: tuple[float, ...],
    a: tuple[float, float],
    b: tuple[float, float],
) -> bool:
    # Cross product zero means collinear; the dot-product bounds keep it between.
    px, py = point[0], point[1]
    ax, ay = a
    bx, by = b
    cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    dot = (px - ax) * (bx - ax) + (py - ay) * (by - ay)
    return abs(cross) < 1e-9 and -1e-9 <= dot <= (bx - ax) ** 2 + (by - ay) ** 2 + 1e-9


def test_draw_dotted_line_emits_one_segment_per_dot_along_the_line(monkeypatch):
    icons = _load(monkeypatch)
    ctx = RecordingCtx()
    x0, y0, x1, y1, num_dots = 0.1, 0.9, 0.9, 0.3, 4

    icons.draw_dotted_line(ctx, x0, y0, x1, y1, num_dots)

    starts = ctx.points("move_to")
    ends = ctx.points("line_to")
    assert len(starts) == num_dots
    assert len(ends) == num_dots

    a, b = (x0, y0), (x1, y1)
    assert starts[0] == pytest.approx(a)
    # Every dash lies on the line, so none drifts off a diagonal.
    for start, end in zip(starts, ends):
        assert _on_segment(start, a, b)
        assert _on_segment(end, a, b)

    # Consecutive dashes start one dot apart; each dash is half a dot long.
    step_x = (x1 - x0) / num_dots
    step_y = (y1 - y0) / num_dots
    for i in range(1, num_dots):
        assert starts[i][0] - starts[i - 1][0] == pytest.approx(step_x)
        assert starts[i][1] - starts[i - 1][1] == pytest.approx(step_y)
    for start, end in zip(starts, ends):
        assert end[0] - start[0] == pytest.approx(step_x / 2)
        assert end[1] - start[1] == pytest.approx(step_y / 2)

    # The dashes cover all but the trailing half dot.
    assert ends[-1][0] == pytest.approx(x0 + step_x * (num_dots - 0.5))
    assert ends[-1][1] == pytest.approx(y0 + step_y * (num_dots - 0.5))
    # The dotted accent is stroked at the main-line 1.5 width.
    widths = [coords[0] for name, coords in ctx.ops if name == "set_line_width"]
    assert widths == [pytest.approx(1.5 / 24)]


def test_arrowhead_puts_its_tip_at_the_given_point_and_points_along_angle(monkeypatch):
    icons = _load(monkeypatch)
    ctx = RecordingCtx()
    x, y, angle, size = 0.3, 0.7, 90.0, 0.2

    icons._arrowhead(ctx, x, y, angle, size)

    assert ctx.points("move_to")[0] == pytest.approx((x, y))
    left, right = ctx.points("line_to")
    # Both base corners are one size away from the tip.
    assert math.hypot(left[0] - x, left[1] - y) == pytest.approx(size)
    assert math.hypot(right[0] - x, right[1] - y) == pytest.approx(size)
    # The tip minus the base midpoint is the arrow's axis: it points at `angle`.
    mid_x = (left[0] + right[0]) / 2
    mid_y = (left[1] + right[1]) / 2
    axis_x, axis_y = x - mid_x, y - mid_y
    assert math.hypot(axis_x, axis_y) == pytest.approx(size * math.sqrt(3) / 2)
    assert math.degrees(math.atan2(axis_y, axis_x)) == pytest.approx(angle)
    # A solid arrowhead: the outline is closed and filled.
    assert ctx.ops[-2] == ("close_path", ())
    assert ctx.ops[-1] == ("fill", ())


def test_draw_plane_grid_traces_the_perimeter_and_keeps_internal_lines_inside(monkeypatch):
    icons = _load(monkeypatch)
    ctx = RecordingCtx()
    corners = [(0.2, 0.7), (0.8, 0.65), (0.75, 0.2), (0.15, 0.25)]

    icons._draw_plane_grid(ctx, *[c for corner in corners for c in corner])

    starts = ctx.points("move_to")
    ends = ctx.points("line_to")
    # Perimeter from the bottom-left corner through the other three, then closed.
    assert starts[0] == pytest.approx(corners[0])
    assert ends[0] == pytest.approx(corners[1])
    assert ends[1] == pytest.approx(corners[2])
    assert ends[2] == pytest.approx(corners[3])
    assert ("close_path", ()) in ctx.ops

    # N=2/M=2 means one internal vertical and one internal horizontal line.
    # Pin their presence so the bounds loop below cannot pass over an empty
    # slice if the internal-line passes are dropped.
    assert len(starts) == 3
    assert len(ends) == 5

    # Every internal grid line stays within the plane's bounding box.
    min_x = min(c[0] for c in corners)
    max_x = max(c[0] for c in corners)
    min_y = min(c[1] for c in corners)
    max_y = max(c[1] for c in corners)
    for point in starts[1:] + ends[3:]:
        assert min_x <= point[0] <= max_x
        assert min_y <= point[1] <= max_y
