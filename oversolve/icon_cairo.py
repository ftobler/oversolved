import math
import cairo
from pathlib import Path

SIZE = 24
_registry = []


def icon(path, angle=0):
    def wrapper(fn):
        _registry.append((path, fn, angle))
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


def _draw_one(path, fn, angle):
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

    fn(ctx)

    surface.finish()
    _postprocess_svg(path)


def _postprocess_svg(path: Path):
    txt = path.read_text()
    txt = txt.replace("#000000", "currentColor")
    path.write_text(txt)


def drawall():
    for path, fn, angle in _registry:
        print(f"→ {path} (angle={angle})")
        _draw_one(path, fn, angle)