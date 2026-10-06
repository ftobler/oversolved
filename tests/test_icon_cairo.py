"""Behavior tests for oversolved/icon_cairo.py, the icon rasterizer.

`icon_cairo` holds the actual drawing pipeline: the `@icon` registry, the
normalized-coordinate scale, the angle/offset transform applied around the
unit square's center, and the idempotent write that leaves an already correct
file alone. The icon set itself (the oversolved/icons/ package) declares the drawings;
this file checks the engine that renders them.
"""

import pathlib

import pytest

from oversolved import icon_cairo


def render_to(target: pathlib.Path, draw, angle: float = 0, offset_x: float = 0, offset_y: float = 0):
    icon_cairo._draw_one(target, draw, angle, offset_x, offset_y)


def test_px_scales_normalized_units_against_the_24px_surface():
    assert icon_cairo.SIZE == 24
    assert icon_cairo.px(24) == 1.0
    assert icon_cairo.px(12) == 0.5
    assert icon_cairo.px(4) == pytest.approx(4.0 / 24.0)


def test_icon_decorator_registers_path_and_transform(monkeypatch):
    monkeypatch.setattr(icon_cairo, "_registry", [])

    @icon_cairo.icon("some/dir/thing.svg", angle=30, offset_x=0.1, offset_y=-0.2)
    def draw(ctx):
        pass

    assert icon_cairo._registry == [("some/dir/thing.svg", draw, 30, 0.1, -0.2)]


def test_draw_one_writes_svg_then_skips_an_unchanged_rewrite(tmp_path, monkeypatch):
    writes = []
    real_write_text = pathlib.Path.write_text

    def counting_write_text(self, data, *args, **kwargs):
        writes.append(self)
        return real_write_text(self, data, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "write_text", counting_write_text)

    target = tmp_path / "icons" / "sample.svg"

    def draw(ctx):
        ctx.move_to(0.2, 0.2)
        ctx.line_to(0.8, 0.8)
        icon_cairo.stroke(ctx, 1.5)

    render_to(target, draw)
    assert target.exists()
    assert "<svg" in target.read_text()
    assert len(writes) == 1, "the first render must create the file"
    mtime_after_first = target.stat().st_mtime_ns

    render_to(target, draw)
    assert len(writes) == 1, "a byte-identical render must not rewrite the file"
    assert target.stat().st_mtime_ns == mtime_after_first


def test_draw_one_rewrites_when_the_existing_file_differs(tmp_path, monkeypatch):
    writes = []
    real_write_text = pathlib.Path.write_text

    def counting_write_text(self, data, *args, **kwargs):
        writes.append(self)
        return real_write_text(self, data, *args, **kwargs)

    monkeypatch.setattr(pathlib.Path, "write_text", counting_write_text)

    target = tmp_path / "sample.svg"
    target.write_text("stale content")
    writes.clear()

    def draw(ctx):
        ctx.move_to(0.1, 0.1)
        ctx.line_to(0.9, 0.9)
        icon_cairo.stroke(ctx, 1.5)

    render_to(target, draw)
    assert len(writes) == 1
    assert "<svg" in target.read_text()


def capture_matrix(tmp_path, **transform):
    captured = {}

    def draw(ctx):
        captured["matrix"] = ctx.get_matrix()

    render_to(tmp_path / "sample.svg", draw, **transform)
    return captured["matrix"]


def test_angle_rotates_about_the_unit_square_center(tmp_path):
    # Rotating 180 degrees about (0.5, 0.5) must fix the center and send the
    # (0, 0) corner to (1, 1); after the 24px scale those are (12, 12) and
    # (24, 24) on the surface.
    matrix = capture_matrix(tmp_path, angle=180)
    assert matrix.transform_point(0.5, 0.5) == pytest.approx((12.0, 12.0))
    assert matrix.transform_point(0.0, 0.0) == pytest.approx((24.0, 24.0))


def test_offset_translates_by_the_given_normalized_distance(tmp_path):
    matrix = capture_matrix(tmp_path, offset_x=0.1, offset_y=0.2)
    # (0.25, 0.5) shifted by (0.1, 0.2) then scaled by 24.
    assert matrix.transform_point(0.25, 0.5) == pytest.approx((8.4, 16.8))
