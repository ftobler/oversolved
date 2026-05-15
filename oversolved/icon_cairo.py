import logging
import math
import cairo
from io import BytesIO
from pathlib import Path

logger = logging.getLogger(__name__)

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

    existing = path.read_text() if path.exists() else None

    buffer = BytesIO()
    surface = cairo.SVGSurface(buffer, SIZE, SIZE)
    ctx = cairo.Context(surface)

    ctx.set_source_rgba(0, 0, 0, 0)
    ctx.paint()

    setup_ctx(ctx)
    source_default(ctx)

    if angle != 0:
        rad = math.radians(angle)
        ctx.translate(0.5, 0.5)
        ctx.rotate(rad)
        ctx.translate(-0.5, -0.5)

    if offset_x != 0 or offset_y != 0:
        ctx.translate(offset_x, offset_y)

    fn(ctx)

    surface.finish()

    written = buffer.getvalue().decode("utf-8")

    if existing is not None and existing.strip() == written.strip():
        return

    if existing is None:
        logger.info("creating: %s", path)
    else:
        logger.info("updating: %s", path)

    path.write_text(written)


def draw_all():
    for entry in _registry:
        path, fn, angle, offset_x, offset_y = entry
        _draw_one(path, fn, angle, offset_x, offset_y)
    logger.info("\u2192 icons up to date")
