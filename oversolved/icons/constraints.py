import math

from icon_cairo import icon, px, stroke

from .helpers import _draw_arrow, draw_dotted_line


@icon("frontend/src/assets/icons/constraint-angle.svg", angle=-20)
def constraint_angle(ctx):
    # Draw two lines forming an angle
    x0, y0 = 0.8, 0.2
    x1, y1 = 0.2, 0.5
    x2, y2 = 0.8, 0.8

    ctx.move_to(x0, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x2, y2)
    stroke(ctx, 1.5)

    # Draw arc at the vertex (x1, y1)
    r = 0.4  # arc radius
    # Calculate angles for the arc
    angle1 = math.atan2(y0 - y1, x0 - x1)
    angle2 = math.atan2(y2 - y1, x2 - x1)
    # Ensure arc is drawn in the correct direction
    if angle2 < angle1:
        angle2 += 2 * math.pi
    ctx.arc(x1, y1, r, angle1, angle2)
    stroke(ctx, 1.5)


@icon(
    "frontend/src/assets/icons/constraint-coincident.svg", angle=-10, offset_y=-0.15
)  # double use: toolbar
def constraint_coincident(ctx):
    # a line with a point on it and a dotted line coming off that point

    # Draw main line
    ctx.move_to(0.15, 0.8)
    ctx.line_to(0.85, 0.8)
    stroke(ctx, 1.5)

    # Draw point on the line (center)
    ctx.arc(0.5, 0.8, px(2.2), 0, 2 * math.pi)
    ctx.fill()

    # Draw dotted line coming off the point (can be diagonal)
    x0, y0 = 0.5, 0.8
    x1, y1 = 0.35, 0.15
    num_dots = 3
    draw_dotted_line(ctx, x0, y0, x1, y1, num_dots)


@icon(
    "frontend/src/assets/icons/constraint-colinear.svg", angle=15
)  # double use: toolbar
def constraint_colinear(ctx):
    # two parallel lines, one dotted. shifted at an angle.

    # normal line
    ctx.move_to(0.25, 0.6)
    ctx.line_to(0.9, 0.6)
    stroke(ctx, 1.5)

    # dotted line (above, parallel)
    x0, y0 = 0.10, 0.4
    x1, y1 = 0.8, 0.4
    num_dots = 3
    draw_dotted_line(ctx, x0, y0, x1, y1, num_dots)


@icon("frontend/src/assets/icons/constraint-dimension.svg")  # double use: toolbar
def constraint_dimension(ctx):
    # Parameters
    x0, x1 = 0.15, 0.85  # left/right x of the measured feature
    y_obj1 = 0.25  # y of the object line (thing being measured)
    y_obj2 = 0.75  # y of the object line (thing being measured)
    y_dim = 0.5  # y of the dimension line
    arr = px(6)  # arrowhead size (base half-width = arr/2)

    # Extension lines (from just below object line down to dimension line)
    ctx.move_to(x0, y_obj1)
    ctx.line_to(x0, y_obj2)
    ctx.move_to(x1, y_obj1)
    ctx.line_to(x1, y_obj2)
    stroke(ctx, 1.5)

    # Draw dimension arrow between two points
    _draw_arrow(ctx, x0, y_dim, x1, y_dim, arr)


@icon("frontend/src/assets/icons/constraint-square.svg")  # double use: toolbar (normal)
def constraint_square(ctx):
    # Parameters
    cx, cy = 0.2, 0.8  # corner (vertex of the right angle)
    leg = 0.65  # length of each leg
    marker = 0.22  # size of the right-angle square marker

    # Vertical and horizontal legs (drawn in one stroke)
    ctx.move_to(cx, cy - leg)
    ctx.line_to(cx, cy)
    ctx.line_to(cx + leg, cy)
    stroke(ctx, 2)

    # Right-angle corner marker (small square notch inside the angle)
    ctx.move_to(cx, cy - marker)
    ctx.line_to(cx + marker, cy - marker)
    ctx.line_to(cx + marker, cy)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/constraint-horizontal.svg")  # double use: toolbar
def constraint_horizontal(ctx):
    # Parameters
    x0, x1 = 0.15, 0.85  # left and right endpoints
    y = 0.5  # vertical center
    cap_half = 0.08  # half-height of the end caps

    # Main horizontal line
    ctx.move_to(x0, y)
    ctx.line_to(x1, y)
    stroke(ctx, 2)

    # Left end cap (vertical bar)
    ctx.move_to(x0, y - cap_half)
    ctx.line_to(x0, y + cap_half)
    stroke(ctx, 2)

    # Right end cap (vertical bar)
    ctx.move_to(x1, y - cap_half)
    ctx.line_to(x1, y + cap_half)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/constraint-vertical.svg")  # double use: toolbar
def constraint_vertical(ctx):
    # Parameters
    y0, y1 = 0.15, 0.85  # top and bottom endpoints
    x = 0.5  # horizontal center
    cap_half = 0.08  # half-width of the end caps

    # Main vertical line
    ctx.move_to(x, y0)
    ctx.line_to(x, y1)
    stroke(ctx, 2)

    # Top end cap (horizontal bar)
    ctx.move_to(x - cap_half, y0)
    ctx.line_to(x + cap_half, y0)
    stroke(ctx, 2)

    # Bottom end cap (horizontal bar)
    ctx.move_to(x - cap_half, y1)
    ctx.line_to(x + cap_half, y1)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/constraint-equal.svg")  # double use: toolbar
def constraint_equal(ctx):
    # Draw a simple equal sign (two horizontal lines)
    x0, x1 = 0.25, 0.75
    y_top = 0.4
    y_bottom = 0.6

    ctx.move_to(x0, y_top)
    ctx.line_to(x1, y_top)
    stroke(ctx, 2)

    ctx.move_to(x0, y_bottom)
    ctx.line_to(x1, y_bottom)
    stroke(ctx, 2)


@icon(
    "frontend/src/assets/icons/constraint-tangent.svg", angle=-20, offset_x=0.1
)  # double use: toolbar
def constraint_tangent(ctx):
    # Parameters
    cx, cy = 0.34, 0.5  # circle center
    r = 0.22  # circle radius
    y0, y1 = 0.08, 0.92  # tangent line extent

    # Circle
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Tangent line (vertical, touching circle at its rightmost point)
    tx = cx + r
    ctx.move_to(tx, y0)
    ctx.line_to(tx, y1)
    stroke(ctx, 2)


@icon(
    "frontend/src/assets/icons/constraint-midpoint.svg", angle=-15
)  # double use: toolbar
def constraint_midpoint(ctx):
    # Parameters
    x0, y0 = 0.1, 0.5  # segment endpoints
    x1, y1 = 0.9, 0.5
    dot_r = px(3.2)  # radius of midpoint dot

    # Segment
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y1)
    stroke(ctx, 2)

    # Midpoint dot (drawn last so it sits on top)
    ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, dot_r, 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/constraint-concentric.svg")  # double use: toolbar
def constraint_concentric(ctx):
    # Parameters
    cx, cy = 0.5, 0.5  # shared center
    r_outer = 0.3  # outer ring radius

    ctx.arc(cx, cy, r_outer, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Center dot
    ctx.arc(cx, cy, px(2.5), 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/constraint-fixed.svg")  # double use: toolbar
def constraint_fixed(ctx):
    # Parameters
    x0, x1 = 0.2, 0.8  # endpoints of the fixed line
    x0d, x1d = 0.23, 0.83  # endpoints of the fixed line
    y_line = 0.5  # y of the fixed line
    y_base = 0.45  # y of the solid base
    dash_n = 3  # number of dashes for the base

    # Fixed line (the constrained object)
    ctx.move_to(x0, y_line)
    ctx.line_to(x1, y_line)
    stroke(ctx, 2)

    # 45-degree dashes below the fixed line, touching each other
    dash_len = (x1d - x0d) / dash_n
    dash_height = dash_len  # height equal to dash length for 45deg
    for i in range(dash_n):
        dx = x0d + i * dash_len
        dy = y_base + 0.08
        ctx.move_to(dx, dy)
        ctx.line_to(dx + dash_len, dy + dash_height)
    stroke(ctx, 1.5)


@icon(
    "frontend/src/assets/icons/constraint-parallel.svg", angle=20
)  # double use: toolbar
def constraint_parallel(ctx):
    # Two parallel lines with arrow indicators
    y1 = 0.35
    y2 = 0.65
    x0, x1 = 0.2, 0.8

    # First line
    ctx.move_to(x0, y1)
    ctx.line_to(x1, y1)
    stroke(ctx, 2)

    # Second line (parallel)
    ctx.move_to(x0, y2)
    ctx.line_to(x1, y2)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/constraint-line-swap.svg")
def constraint_line_swap(ctx):
    # Dashed line at the top
    x0, x1 = 0.15, 0.85
    line_1_height = 0.2
    num_dots = 4
    draw_dotted_line(ctx, x0, line_1_height, x1 + 0.1, line_1_height, num_dots)

    # Solid line at the bottom
    line_2_height = 1 - line_1_height
    ctx.move_to(x0, line_2_height)
    ctx.line_to(x1, line_2_height)
    stroke(ctx, 1.5)

    arrow_height = line_1_height + 0.03
    _draw_arrow(ctx, 0.5, arrow_height, 0.5, 1 - arrow_height, px(6))
