import math

from icon_cairo import px, stroke


# ctx is from pycairo
# coordinates are normalized (0 to 1).
# stroke widths: 2 primary, 1.5 secondary, 1.0 accent.


def draw_dotted_line(ctx, x0, y0, x1, y1, num_dots):
    for i in range(num_dots):
        t0 = i / num_dots
        t1 = (i + 0.5) / num_dots
        ctx.move_to(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
        ctx.line_to(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
    stroke(ctx, 1.5)


def _draw_x(ctx):
    # X shape: two crossing diagonal lines.
    ctx.move_to(0.2, 0.2)
    ctx.line_to(0.8, 0.8)
    stroke(ctx, 2)
    ctx.move_to(0.8, 0.2)
    ctx.line_to(0.2, 0.8)
    stroke(ctx, 2)


def _draw_plane_grid(ctx, x0, y0, x1, y1, x2, y2, x3, y3):
    # Tilted 3x2 plane: perimeter, 2 vertical and 1 horizontal internal lines.
    # Corners are bottom-left, bottom-right, top-right, top-left (isometric view).
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x2, y2)
    ctx.line_to(x3, y3)
    ctx.close_path()
    stroke(ctx, 1.5)

    N = 2  # internal vertical lines for 3 columns
    for i in range(1, N):
        t = i / N
        left_x = x0 + (x3 - x0) * t
        left_y = y0 + (y3 - y0) * t
        right_x = x1 + (x2 - x1) * t
        right_y = y1 + (y2 - y1) * t
        ctx.move_to(left_x, left_y)
        ctx.line_to(right_x, right_y)
    stroke(ctx, 1.5)

    M = 2  # internal horizontal line for 2 rows
    for i in range(1, M):
        t = i / M
        bottom_x = x0 + (x1 - x0) * t
        bottom_y = y0 + (y1 - y0) * t
        top_x = x3 + (x2 - x3) * t
        top_y = y3 + (y2 - y3) * t
        ctx.move_to(bottom_x, bottom_y)
        ctx.line_to(top_x, top_y)
    stroke(ctx, 1.5)


def _arrowhead(ctx, x, y, angle, size):
    """Draw a filled arrowhead at (x, y) pointing at angle (degrees). Uses size for the head length."""
    rad = math.radians(angle)
    # Arrowhead points: tip, left, right
    tip = (x, y)
    left = (
        x + size * math.cos(rad + math.radians(150)),
        y + size * math.sin(rad + math.radians(150)),
    )
    right = (
        x + size * math.cos(rad - math.radians(150)),
        y + size * math.sin(rad - math.radians(150)),
    )
    ctx.move_to(*tip)
    ctx.line_to(*left)
    ctx.line_to(*right)
    ctx.close_path()
    ctx.fill()


def _draw_arrow(ctx, x0, y0, x1, y1, arr):
    """Draw a dimension arrow from (x0, y0) to (x1, y1) with arrowheads at both ends."""
    # Draw main line (between arrowhead tips)
    dx, dy = x1 - x0, y1 - y0
    length = math.hypot(dx, dy)
    if length == 0:
        return
    ux, uy = dx / length, dy / length
    # Shorten line so arrowheads are outside
    start_x = x0 + ux * (arr / 2)
    start_y = y0 + uy * (arr / 2)
    end_x = x1 - ux * (arr / 2)
    end_y = y1 - uy * (arr / 2)
    ctx.move_to(start_x, start_y)
    ctx.line_to(end_x, end_y)
    stroke(ctx, 1.5)

    # Arrowheads
    angle0 = math.degrees(math.atan2(uy, ux))
    _arrowhead(ctx, x0, y0, angle0 + 180, arr)
    _arrowhead(ctx, x1, y1, angle0, arr)


def _draw_rect_outline(ctx, x0, x1, y0, y1):
    """Draw a rectangle outline from (x0, y0) to (x1, y1)."""
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x0, y1)
    ctx.close_path()
    stroke(ctx, 2)


def _pencil(ctx):
    # Sketch/pencil icon (horizontal)
    # Pencil shaft
    x0, y0 = 0.15, 0.5
    x1, y1 = 0.85, 0.5

    # Draw pencil shaft as a rectangle
    shaft_thickness = 0.25
    tip_size = 0.25
    ctx.move_to(x0, y0 - shaft_thickness / 2)
    ctx.line_to(x1 - tip_size, y1 - shaft_thickness / 2)
    ctx.line_to(x1 - tip_size, y1 + shaft_thickness / 2)
    ctx.line_to(x0, y0 + shaft_thickness / 2)
    ctx.close_path()
    stroke(ctx, 2)

    # Pencil tip (small triangle at the right end)
    tip_thickness = shaft_thickness
    ctx.move_to(x1, y1)
    ctx.line_to(x1 - tip_size, y1 - tip_thickness * 0.5)
    ctx.line_to(x1 - tip_size, y1 + tip_thickness * 0.5)
    ctx.close_path()
    ctx.stroke()


def _copy_icon_back_rect(ctx, bx0, by0, bx1, by1, fx0, fy0, fx1, fy1):
    """Draw the back rectangle of a copy icon, clipped by the front rectangle.
    Only the portions of the back rect not covered by the front rect are drawn."""
    # Visible: left edge top portion (by0 → fy0), top edge, right edge, bottom edge right portion (fx1 → bx1)
    ctx.move_to(bx0, fy0)
    ctx.line_to(bx0, by0)
    ctx.line_to(bx1, by0)
    ctx.line_to(bx1, by1)
    ctx.line_to(fx1, by1)
    stroke(ctx, 1.5)


def _trashcan(ctx):
    """Icon for Delete context menu entry: trash can."""
    # Body of trash can
    ctx.move_to(0.3, 0.35)
    ctx.line_to(0.35, 0.8)
    ctx.line_to(0.65, 0.8)
    ctx.line_to(0.7, 0.35)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Lid
    ctx.move_to(0.22, 0.35)
    ctx.line_to(0.78, 0.35)
    stroke(ctx, 1.5)

    # Handle on lid
    ctx.move_to(0.4, 0.35)
    ctx.line_to(0.4, 0.25)
    ctx.line_to(0.6, 0.25)
    ctx.line_to(0.6, 0.35)
    stroke(ctx, 1.5)


def _rotation_arc(ctx, cx, cy, r, start_deg=-60, end_deg=170, arr=None):
    """Open arc with an arrowhead at its end: the 'rotates' glyph."""
    if arr is None:
        arr = px(5)
    a0, a1 = math.radians(start_deg), math.radians(end_deg)
    ctx.arc(cx, cy, r, a0, a1)
    stroke(ctx, 1.5)
    ex = cx + r * math.cos(a1)
    ey = cy + r * math.sin(a1)
    # Arrowhead along the arc tangent (cairo sweeps clockwise on screen).
    _arrowhead(ctx, ex, ey, math.degrees(a1) + 90, arr)
