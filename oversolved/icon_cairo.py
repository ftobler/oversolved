import math
import cairo
from pathlib import Path

SIZE = 24
_registry = []


def icon(path, angle=0, offset_x=0, offset_y=0):
    def wrapper(fn):
        _registry.append((path, fn, angle, offset_x, offset_y))
        return fn
    return wrapper


def px(v):
    return v / SIZE


def setup_ctx(ctx):
    ctx.scale(SIZE, SIZE)
    ctx.set_line_cap(cairo.LineCap.BUTT)
    ctx.set_line_join(cairo.LineJoin.ROUND)


def stroke(ctx, width_px):
    ctx.set_line_width(px(width_px))
    ctx.stroke()


def source_default(ctx):
    ctx.set_source_rgb(0, 0, 0)


def _draw_one(path, fn, angle, offset_x=0, offset_y=0):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)

    surface = cairo.SVGSurface(str(path), SIZE, SIZE)
    ctx = cairo.Context(surface)

    # transparent background
    ctx.set_source_rgba(0, 0, 0, 0)
    ctx.paint()

    setup_ctx(ctx)
    source_default(ctx)

    # ===== rotation around center =====
    if angle != 0:
        rad = math.radians(angle)
        ctx.translate(0.5, 0.5)   # move origin to center
        ctx.rotate(rad)
        ctx.translate(-0.5, -0.5)

    # ===== offset translation =====
    if offset_x != 0 or offset_y != 0:
        ctx.translate(offset_x, offset_y)

    fn(ctx)

    surface.finish()
    _postprocess_svg(path)


def _postprocess_svg(path: Path):
    txt = path.read_text()
    txt = txt.replace("#000000", "currentColor")
    path.write_text(txt)


def draw_all():
    for entry in _registry:
        path, fn, angle = entry[:3]
        offset_x, offset_y = entry[3:5] if len(entry) > 3 else (0, 0)
        # print(f"→ {path} (angle={angle}, offset=({offset_x}, {offset_y}))")
        _draw_one(path, fn, angle, offset_x, offset_y)
    print(f"→ created {len(_registry)} icons")