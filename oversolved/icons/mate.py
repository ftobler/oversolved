import math

from icon_cairo import icon, px, stroke

from .helpers import _draw_arrow, _rotation_arc


# ─── Mate icons ───
# One glyph per assembly mate kind, shown as insert buttons on the assembly
# toolbar. Shared vocabulary: a straight double arrow means a sliding degree of
# freedom, a swirl arc means a rotating one, hatching is the ground symbol and
# marks the side that cannot move.


@icon("frontend/src/assets/icons/mate-fixed.svg")
def mate_fixed(ctx):
    """Fixed mate: a block welded onto hatched ground, no freedom left."""
    x0, x1 = 0.32, 0.68
    y_ground = 0.66

    ctx.rectangle(x0, 0.34, x1 - x0, y_ground - 0.34)
    stroke(ctx, 2)

    ctx.move_to(0.14, y_ground)
    ctx.line_to(0.86, y_ground)
    stroke(ctx, 1.5)

    dash_n = 4
    dash_len = 0.72 / dash_n
    for i in range(dash_n):
        dx = 0.14 + i * dash_len
        ctx.move_to(dx, y_ground + 0.03)
        ctx.line_to(dx + dash_len, y_ground + 0.03 + dash_len)
    stroke(ctx, 1)


@icon("frontend/src/assets/icons/mate-sliding.svg")
def mate_sliding(ctx):
    """Sliding mate: a block on a rail, free along it both ways."""
    _draw_arrow(ctx, 0.16, 0.24, 0.84, 0.24, px(6))

    ctx.rectangle(0.36, 0.46, 0.28, 0.26)
    stroke(ctx, 2)

    ctx.move_to(0.08, 0.72)
    ctx.line_to(0.92, 0.72)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/mate-rotating.svg")
def mate_rotating(ctx):
    """Rotating mate: a hinge axis with the swirl around it."""
    ctx.arc(0.5, 0.5, px(2.5), 0, 2 * math.pi)
    ctx.fill()
    _rotation_arc(ctx, 0.5, 0.5, 0.3)


@icon("frontend/src/assets/icons/mate-sliding-rotating.svg")
def mate_sliding_rotating(ctx):
    """Cylindrical mate: slide arrow stacked over the rotation swirl."""
    _draw_arrow(ctx, 0.16, 0.2, 0.84, 0.2, px(6))

    ctx.arc(0.5, 0.62, px(2.5), 0, 2 * math.pi)
    ctx.fill()
    _rotation_arc(ctx, 0.5, 0.62, 0.24)


@icon("frontend/src/assets/icons/mate-spherical.svg")
def mate_spherical(ctx):
    """Spherical mate: ball resting in an open socket on a stem."""
    cx, cy = 0.5, 0.4
    ctx.arc(cx, cy, 0.15, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    socket_r = 0.24
    ctx.arc(cx, cy + 0.04, socket_r, math.radians(15), math.radians(165))
    stroke(ctx, 2)

    ctx.move_to(cx, cy + 0.04 + socket_r)
    ctx.line_to(cx, 0.9)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/mate-parallel.svg", angle=20)
def mate_parallel(ctx):
    """Parallel mate: same glyph family as the sketch parallel constraint."""
    for y in (0.35, 0.65):
        ctx.move_to(0.2, y)
        ctx.line_to(0.8, y)
        stroke(ctx, 2)


@icon("frontend/src/assets/icons/mate-parallel-plane-distance.svg", angle=20)
def mate_parallel_plane_distance(ctx):
    """Parallel at distance: the parallel pair plus a dimension between them."""
    for y in (0.2, 0.8):
        ctx.move_to(0.15, y)
        ctx.line_to(0.85, y)
        stroke(ctx, 2)

    _draw_arrow(ctx, 0.5, 0.28, 0.5, 0.72, px(5))


@icon("frontend/src/assets/icons/mate-tangential.svg")
def mate_tangential(ctx):
    """Tangential mate: circle kissing a plane."""
    cx, cy, r = 0.5, 0.34, 0.22
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    ctx.move_to(0.08, cy + r)
    ctx.line_to(0.92, cy + r)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/mate-copy-rotation.svg")
def mate_copy_rotation(ctx):
    """Copy rotation: two axes swirling in lockstep, gear-train style."""
    for cx in (0.27, 0.73):
        ctx.arc(cx, 0.5, px(2), 0, 2 * math.pi)
        ctx.fill()
        _rotation_arc(ctx, cx, 0.5, 0.17, start_deg=-60, end_deg=170, arr=px(5))
