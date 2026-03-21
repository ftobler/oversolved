from icon_cairo import icon, drawall, px, stroke
import math


# ctx is from pycairo
# coordinates are normalized (0 to 1).
# use 1.5 stroke with for main lines, 1px or dotted for accents.


def draw_dotted_line(ctx, x0, y0, x1, y1, num_dots):
    for i in range(num_dots):
        t0 = i / num_dots
        t1 = (i + 0.5) / num_dots
        ctx.move_to(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
        ctx.line_to(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
    stroke(ctx, 1.5)


def _arrowhead(ctx, x, y, angle, size):
    """Draw a filled arrowhead at (x, y) pointing at angle (degrees). Uses arr for size."""
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


@icon("frontend/src/assets/icons/constraint-coincident.svg", angle=-10, offset_y=-0.15)  # double use: toolbar
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


@icon("frontend/src/assets/icons/constraint-colinear.svg", angle=15)  # double use: toolbar
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
    x0, x1 = 0.15, 0.85   # left/right x of the measured feature
    y_obj1 = 0.25          # y of the object line (thing being measured)
    y_obj2 = 0.75          # y of the object line (thing being measured)
    y_dim = 0.5           # y of the dimension line
    arr = px(6)         # arrowhead size (base half-width = arr/2)

    # Extension lines (from just below object line down to dimension line)
    ctx.move_to(x0, y_obj1)
    ctx.line_to(x0, y_obj2)
    ctx.move_to(x1, y_obj1)
    ctx.line_to(x1, y_obj2)
    stroke(ctx, 1.5)

    # Draw dimension arrow between two points
    _draw_arrow(ctx, x0, y_dim, x1, y_dim, arr)



@icon("frontend/src/assets/icons/constraint-square.svg")  # double use: toolbar (perpendicular)
def constraint_square(ctx):
    # Parameters
    cx, cy = 0.2, 0.8    # corner (vertex of the right angle)
    leg = 0.65        # length of each leg
    marker = 0.22        # size of the right-angle square marker

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
    x0, x1 = 0.15, 0.85   # left and right endpoints
    y = 0.5         # vertical center
    cap_half = 0.08        # half-height of the end caps

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
    y0, y1 = 0.15, 0.85   # top and bottom endpoints
    x = 0.5          # horizontal center
    cap_half = 0.08         # half-width of the end caps

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


@icon("frontend/src/assets/icons/constraint-equal.svg", angle=-5)  # double use: toolbar
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


@icon("frontend/src/assets/icons/constraint-tangent.svg", angle=-20, offset_x=0.1)  # double use: toolbar
def constraint_tangent(ctx):
    # Parameters
    cx, cy = 0.34, 0.5   # circle center
    r = 0.22        # circle radius
    y0, y1 = 0.08, 0.92  # tangent line extent

    # Circle
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Tangent line (vertical, touching circle at its rightmost point)
    tx = cx + r
    ctx.move_to(tx, y0)
    ctx.line_to(tx, y1)
    stroke(ctx, 2)

    # # Small dot at tangent point
    # ctx.arc(tx, cy, px(2.5), 0, 2 * math.pi)
    # ctx.fill()


@icon("frontend/src/assets/icons/constraint-midpoint.svg", angle=-15)  # double use: toolbar
def constraint_midpoint(ctx):
    # Parameters
    x0, y0 = 0.1, 0.5  # segment endpoints
    x1, y1 = 0.9, 0.5
    dot_r = px(3.2)  # radius of midpoint dot

    # Segment
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y1)
    stroke(ctx, 2)

    # # One tick mark per half, at the quarter and three-quarter points
    # for t in [0.28, 0.72]:
    #     tx = x0 + dx * t
    #     ty = y0 + dy * t
    #     ctx.move_to(tx - nx * tick_half, ty - ny * tick_half)
    #     ctx.line_to(tx + nx * tick_half, ty + ny * tick_half)
    #     stroke(ctx, 2)

    # Midpoint dot (drawn last so it sits on top)
    ctx.arc((x0 + x1) / 2, (y0 + y1) / 2, dot_r, 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/constraint-normal.svg")  # double use: toolbar
def constraint_normal(ctx):
    # Parameters
    x0, x1 = 0.1, 0.9  # x extent of the curved surface
    y_base = 0.78  # y at the endpoints of the surface arc
    marker = 0.2  # right-angle marker size

    # Calculate arc center and radius
    cx = 0.5
    cy = 1.7
    r = 1

    # Calculate start and end angles
    angle0 = math.atan2(y_base - cy, x0 - cx)
    angle1 = math.atan2(y_base - cy, x1 - cx)

    # Draw arc (surface)
    ctx.arc(cx, cy, r, angle0, angle1)
    stroke(ctx, 2)

    # Midpoint of the arc for the normal
    angle_mid = (angle0 + angle1) / 2
    mx = cx + r * math.cos(angle_mid)
    my = cy + r * math.sin(angle_mid)

    # Normal line (vertical, upward from midpoint of the surface)
    ctx.move_to(mx, my)
    ctx.line_to(mx, 0.08)
    stroke(ctx, 2)

    # Right-angle marker (upper-right quadrant of the junction)
    ctx.move_to(mx + marker, my)
    ctx.line_to(mx + marker, my - marker)
    ctx.line_to(mx, my - marker)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/constraint-concentric.svg")  # double use: toolbar
def constraint_concentric(ctx):
    # Parameters
    cx, cy = 0.5, 0.5   # shared center
    r_outer = 0.3        # outer ring radius
    # r_inner = 0.20        # inner ring radius

    ctx.arc(cx, cy, r_outer, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # ctx.arc(cx, cy, r_inner, 0, 2 * math.pi)
    # stroke(ctx, 2)

    # Center dot
    ctx.arc(cx, cy, px(2.5), 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/constraint-fixed.svg")  # double use: toolbar
def constraint_fixed(ctx):
    # Parameters
    x0, x1 = 0.2, 0.8        # endpoints of the fixed line
    x0d, x1d = 0.23, 0.83        # endpoints of the fixed line
    y_line = 0.5            # y of the fixed line
    y_base = 0.45            # y of the solid base
    dash_n = 3               # number of dashes for the base

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


@icon("frontend/src/assets/icons/constraint-parallel.svg", angle=20)  # double use: toolbar
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

    # # Arrow indicators (small arrows showing direction)
    # arrow_len = 0.06
    # arrow_h = 0.04

    # # Top arrow (pointing right)
    # ctx.move_to(x1 - arrow_len, y1 - arrow_h)
    # ctx.line_to(x1, y1)
    # ctx.line_to(x1 - arrow_len, y1 + arrow_h)
    # stroke(ctx, 1.5)

    # # Bottom arrow (pointing right)
    # ctx.move_to(x1 - arrow_len, y2 - arrow_h)
    # ctx.line_to(x1, y2)
    # ctx.line_to(x1 - arrow_len, y2 + arrow_h)
    # stroke(ctx, 1.5)


# Toolbar icons
@icon("frontend/src/assets/icons/toolbar-menu.svg")
def toolbar_menu(ctx):
    # Hamburger menu icon (three horizontal lines)
    y_positions = [0.25, 0.5, 0.75]
    x0, x1 = 0.2, 0.8
    for y in y_positions:
        ctx.move_to(x0, y)
        ctx.line_to(x1, y)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-line.svg")
def toolbar_line(ctx):
    # Simple diagonal line
    ctx.move_to(0.2, 0.8)
    ctx.line_to(0.8, 0.2)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-rectangle.svg")
def toolbar_rectangle(ctx):
    # Rectangle
    x0, x1 = 0.2, 0.8
    y0, y1 = 0.3, 0.7
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x0, y1)
    ctx.close_path()
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-circle.svg")
def toolbar_circle(ctx):
    # Circle
    cx, cy = 0.5, 0.5
    r = 0.3
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-arc.svg")
def toolbar_arc(ctx):
    # Arc
    cx, cy = 0.5, 0.5
    r = 0.3
    ctx.arc(cx, cy, r, math.pi, 2 * math.pi)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-point.svg")
def toolbar_point(ctx):
    # Point (circle)
    cx, cy = 0.5, 0.5
    r = px(3)
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/toolbar-help.svg")
def toolbar_help(ctx):
    # Question mark
    cx, cy = 0.5, 0.5
    r = 0.25

    # Circle outline
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Question mark
    # Dot at bottom
    ctx.arc(cx, cy + r * 0.4, px(2), 0, 2 * math.pi)
    ctx.fill()

    # Curve for top of question mark
    ctx.move_to(cx - r * 0.2, cy - r * 0.15)
    ctx.line_to(cx - r * 0.2, cy - r * 0.35)
    ctx.arc(cx, cy - r * 0.35, r * 0.2, math.pi, 0)
    ctx.line_to(cx + r * 0.2, cy - r * 0.05)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/toolbar-visualizer.svg")
def toolbar_visualizer(ctx):
    # Bug icon
    # Head (circle)
    ctx.arc(0.5, 0.3, 0.1, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Body
    ctx.move_to(0.5, 0.4)
    ctx.line_to(0.5, 0.7)
    stroke(ctx, 1.5)

    # Antennae
    ctx.move_to(0.45, 0.25)
    ctx.line_to(0.35, 0.1)
    ctx.move_to(0.55, 0.25)
    ctx.line_to(0.65, 0.1)
    stroke(ctx, 1.5)

    # Legs
    for x_offset in [-0.15, 0.15]:
        ctx.move_to(0.5 + x_offset, 0.5)
        ctx.line_to(0.5 + x_offset * 1.5, 0.65)
        ctx.move_to(0.5 + x_offset, 0.6)
        ctx.line_to(0.5 + x_offset * 1.5, 0.75)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/feature-extrude.svg")
def toolbar_extrude(ctx):
    # Extrude icon: a rectangle with an arrow pointing outward
    # Base rectangle
    x0, x1 = 0.15, 0.45
    y0, y1 = 0.25, 0.75

    ctx.move_to(x0, y0)
    ctx.line_to(x1, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x0, y1)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Arrow pointing out to the right
    arrow_start = x1 + 0.1
    arrow_end = 0.9
    arrow_y = (y0 + y1) / 2

    # Arrow shaft
    ctx.move_to(arrow_start, arrow_y)
    ctx.line_to(arrow_end, arrow_y)
    stroke(ctx, 1.5)

    # Arrow head
    arrow_size = 0.2
    ctx.move_to(arrow_end - arrow_size, arrow_y - arrow_size * 0.6)
    ctx.line_to(arrow_end, arrow_y)
    ctx.line_to(arrow_end - arrow_size, arrow_y + arrow_size * 0.6)
    # ctx.close_path()
    ctx.stroke()


@icon("frontend/src/assets/icons/feature-sketch.svg", angle=120)
def toolbar_sketch(ctx):
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


@icon("frontend/src/assets/icons/toolbar-play.svg")
def toolbar_play(ctx):
    # Play button icon: triangle pointing right
    cx, cy = 0.5, 0.5
    size = 0.3

    # Triangle pointing right
    ctx.move_to(cx - size, cy - size)
    ctx.line_to(cx - size, cy + size)
    ctx.line_to(cx + size, cy)
    ctx.close_path()
    ctx.fill()


@icon("frontend/src/assets/icons/feature-origin.svg")
def feature_origin(ctx):
    # Origin point icon: larger filled circle
    cx, cy = 0.5, 0.5
    R = px(4)  # 20% larger than toolbar-point
    ctx.arc(cx, cy, R, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Origin point icon: larger filled circle
    r = R / 3
    ctx.arc(cx, cy, r, 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/feature-plane.svg")
def feature_plane(ctx):
    # Plane icon: 3D tilted 3x2 grid
    # Define the tilted plane corners (isometric-like view)
    x0, y0 = 0.2, 0.7  # bottom-left
    x1, y1 = 0.8, 0.65  # bottom-right
    x2, y2 = 0.75, 0.2  # top-right
    x3, y3 = 0.15, 0.25  # top-left

    # Draw the plane perimeter
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x2, y2)
    ctx.line_to(x3, y3)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Draw vertical grid lines (2 internal lines for 3 columns)
    N = 2
    for i in range(1, N):
        t = i / N
        # Interpolate points along the edges
        left_x = x0 + (x3 - x0) * t
        left_y = y0 + (y3 - y0) * t
        right_x = x1 + (x2 - x1) * t
        right_y = y1 + (y2 - y1) * t
        ctx.move_to(left_x, left_y)
        ctx.line_to(right_x, right_y)
    stroke(ctx, 1.5)

    # Draw horizontal grid line (1 internal line for 2 rows)
    M = 2
    for i in range(1, M):
        t = i / M
        # Interpolate points along top and bottom edges
        bottom_x = x0 + (x1 - x0) * t
        bottom_y = y0 + (y1 - y0) * t
        top_x = x3 + (x2 - x3) * t
        top_y = y3 + (y2 - y3) * t
        ctx.move_to(bottom_x, bottom_y)
        ctx.line_to(top_x, top_y)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/viewport-reset.svg")
def viewport_reset(ctx):
    # Square outline
    m = 0.12
    ctx.move_to(m, m)
    ctx.line_to(1 - m, m)
    ctx.line_to(1 - m, 1 - m)
    ctx.line_to(m, 1 - m)
    ctx.close_path()
    stroke(ctx, 1.5)

    n = m + 0.05
    _draw_arrow(ctx, n, 0.5, 1 - n, 0.5, px(6))


@icon("frontend/src/assets/icons/feature-part.svg")
def feature_part(ctx):
    # Draw a cube using a hexagon outline (isometric projection)
    # Hexagon vertices (isometric cube corners)
    hex_points = [
        (0.5, 0.15),  # top
        (0.8, 0.3),   # top-right
        (0.8, 0.6),   # bottom-right
        (0.5, 0.75),  # bottom
        (0.2, 0.6),   # bottom-left
        (0.2, 0.3),   # top-left
    ]
    center_point = (0.5, 0.45)

    # Draw hexagon outline (cube outer edges)
    ctx.move_to(*hex_points[0])
    for pt in hex_points[1:]:
        ctx.line_to(*pt)
    ctx.close_path()
    stroke(ctx, 2)

    for pt in [hex_points[1], hex_points[3], hex_points[5]]:
        ctx.move_to(*center_point)
        ctx.line_to(*pt)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/icon-code.svg")
def feature_code(ctx):
    # Two curly braces { } — classic code symbol
    # Each brace: top hook, straight segment, middle point, straight segment, bottom hook

    def draw_brace(tip_x, outer_x, cy, half_h, r):
        """Draw one curly brace.
        tip_x: x of the middle point (the pointy bit)
        outer_x: x of the top/bottom hooks
        cy: vertical center
        half_h: half the total height
        r: corner radius for the hooks
        """
        top = cy - half_h
        bot = cy + half_h
        # direction: +1 if tip is to the left of outer, -1 otherwise
        d = 1 if outer_x > tip_x else -1

        # Top hook: starts at (outer_x, top), curves inward
        ctx.move_to(outer_x, top)
        ctx.curve_to(
            outer_x - r * 1.2 * d, top,
            outer_x - r * 1.2 * d, top + r * 1.5,
            outer_x - r * 1.2 * d, top + r * 1.5
        )

        # Upper straight segment down to middle
        ctx.line_to(outer_x - r * 1.2 * d, cy - r * 0.8)

        # Middle point curve
        ctx.curve_to(
            outer_x - r * 1.2 * d, cy - r * 0.3,
            tip_x, cy - r * 0.3,
            tip_x, cy
        )
        ctx.curve_to(
            tip_x, cy + r * 0.3,
            outer_x - r * 1.2 * d, cy + r * 0.3,
            outer_x - r * 1.2 * d, cy + r * 0.8
        )

        # Lower straight segment
        ctx.line_to(outer_x - r * 1.2 * d, bot - r * 1.5)

        # Bottom hook: curves back out to (outer_x, bot)
        ctx.curve_to(
            outer_x - r * 1.2 * d, bot,
            outer_x, bot,
            outer_x, bot
        )
        stroke(ctx, 1.5)

    half_h = 0.32
    cy = 0.5
    r = 0.12

    # Left brace {  — tip points left, hooks on right
    draw_brace(tip_x=0.15, outer_x=0.38, cy=cy, half_h=half_h, r=r)
    # Right brace }  — tip points right, hooks on left
    draw_brace(tip_x=0.85, outer_x=0.62, cy=cy, half_h=half_h, r=r)


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


if __name__ == "__main__":
    drawall()
