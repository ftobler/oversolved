from icon_cairo import icon, draw_all, px, stroke
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

    # # Small dot at tangent point
    # ctx.arc(tx, cy, px(2.5), 0, 2 * math.pi)
    # ctx.fill()


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


@icon("frontend/src/assets/icons/constraint-concentric.svg")  # double use: toolbar
def constraint_concentric(ctx):
    # Parameters
    cx, cy = 0.5, 0.5  # shared center
    r_outer = 0.3  # outer ring radius
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
@icon(
    "frontend/src/assets/icons/toolbar-select.svg", angle=-30
)  # double use: constraint-horizontal (normal)
def toolbar_select(ctx):
    """Select tool icon: simple cursor arrow pointing up-left."""
    # Arrow pointing up-left (like a mouse cursor)

    # Arrow shaft/line from bottom-right to top-left
    ctx.move_to(0.49, 0.8)
    ctx.line_to(0.49, 0.4)
    stroke(ctx, 3.5)

    # Arrowhead at the top-left
    _arrowhead(ctx, 0.5, 0.2, 270, px(10))


@icon(
    "frontend/src/assets/icons/toolbar-select.svg", angle=-30
)  # same as toolbar_select
def arrow(ctx):
    """Arrow icon for selection tool - alias for toolbar_select."""
    # Arrow shaft/line from bottom-right to top-left
    ctx.move_to(0.49, 0.8)
    ctx.line_to(0.49, 0.4)
    stroke(ctx, 3.5)

    # Arrowhead at the top-left
    _arrowhead(ctx, 0.5, 0.2, 270, px(10))


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


def _draw_rect_outline(ctx, x0, x1, y0, y1):
    """Draw a rectangle outline from (x0, y0) to (x1, y1)."""
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x0, y1)
    ctx.close_path()
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-rectangle.svg")
def toolbar_rectangle(ctx):
    # Rectangle
    x0, x1 = 0.2, 0.8
    y0, y1 = 0.3, 0.7
    _draw_rect_outline(ctx, x0, x1, y0, y1)


@icon("frontend/src/assets/icons/toolbar-center-rectangle.svg")
def toolbar_center_rectangle(ctx):
    # Center-point rectangle: rectangle outline with center point marked
    x0, x1 = 0.2, 0.8
    y0, y1 = 0.3, 0.7
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2

    _draw_rect_outline(ctx, x0, x1, y0, y1)

    # Center point (filled dot)
    ctx.arc(cx, cy, px(2.5), 0, 2 * math.pi)
    ctx.fill()


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


@icon("frontend/src/assets/icons/feature-revolve.svg")
def toolbar_revolve(ctx):
    # Revolve icon: a profile rectangle with a curved arrow indicating rotation
    # Base rectangle (profile)
    x0, x1 = 0.15, 0.40
    y0, y1 = 0.25, 0.75

    ctx.move_to(x0, y0)
    ctx.line_to(x1, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x0, y1)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Curved arrow around the right side of the rectangle
    arc_radius = 0.28
    start_angle = math.radians(-90)
    end_angle = math.radians(60)

    ctx.arc(0.5, 0.5, arc_radius, start_angle, end_angle)
    stroke(ctx, 1.5)

    end_x = 0.5 + arc_radius * math.cos(end_angle)
    end_y = 0.5 + arc_radius * math.sin(end_angle)
    _arrowhead(ctx, end_x - 0.13, end_y + 0.08, math.degrees(end_angle) + 80, px(8))


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


@icon("frontend/src/assets/icons/feature-sketch.svg", angle=120)
def toolbar_sketch(ctx):
    _pencil(ctx)


@icon("frontend/src/assets/icons/context-edit.svg", angle=120)
def context_edit(ctx):
    _pencil(ctx)


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

    # Origin point icon: smaller filled circle
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


@icon("frontend/src/assets/icons/feature-add-plane.svg")
def feature_add_plane(ctx):
    # Plane icon scaled to left portion, plus sign in top-right
    x0, y0 = 0.1, 0.75
    x1, y1 = 0.65, 0.7
    x2, y2 = 0.6, 0.35
    x3, y3 = 0.05, 0.4

    ctx.move_to(x0, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x2, y2)
    ctx.line_to(x3, y3)
    ctx.close_path()
    stroke(ctx, 1.5)

    N = 2
    for i in range(1, N):
        t = i / N
        left_x = x0 + (x3 - x0) * t
        left_y = y0 + (y3 - y0) * t
        right_x = x1 + (x2 - x1) * t
        right_y = y1 + (y2 - y1) * t
        ctx.move_to(left_x, left_y)
        ctx.line_to(right_x, right_y)
    stroke(ctx, 1.5)

    M = 2
    for i in range(1, M):
        t = i / M
        bottom_x = x0 + (x1 - x0) * t
        bottom_y = y0 + (y1 - y0) * t
        top_x = x3 + (x2 - x3) * t
        top_y = y3 + (y2 - y3) * t
        ctx.move_to(bottom_x, bottom_y)
        ctx.line_to(top_x, top_y)
    stroke(ctx, 1.5)

    # Plus sign in top-right corner
    cx, cy, arm = 0.8, 0.22, 0.12
    ctx.move_to(cx - arm, cy)
    ctx.line_to(cx + arm, cy)
    stroke(ctx, 1.5)
    ctx.move_to(cx, cy - arm)
    ctx.line_to(cx, cy + arm)
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
        (0.8, 0.3),  # top-right
        (0.8, 0.6),  # bottom-right
        (0.5, 0.75),  # bottom
        (0.2, 0.6),  # bottom-left
        (0.2, 0.3),  # top-left
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
            outer_x - r * 1.2 * d,
            top,
            outer_x - r * 1.2 * d,
            top + r * 1.5,
            outer_x - r * 1.2 * d,
            top + r * 1.5,
        )

        # Upper straight segment down to middle
        ctx.line_to(outer_x - r * 1.2 * d, cy - r * 0.8)

        # Middle point curve
        ctx.curve_to(
            outer_x - r * 1.2 * d, cy - r * 0.3, tip_x, cy - r * 0.3, tip_x, cy
        )
        ctx.curve_to(
            tip_x,
            cy + r * 0.3,
            outer_x - r * 1.2 * d,
            cy + r * 0.3,
            outer_x - r * 1.2 * d,
            cy + r * 0.8,
        )

        # Lower straight segment
        ctx.line_to(outer_x - r * 1.2 * d, bot - r * 1.5)

        # Bottom hook: curves back out to (outer_x, bot)
        ctx.curve_to(outer_x - r * 1.2 * d, bot, outer_x, bot, outer_x, bot)
        stroke(ctx, 1.5)

    half_h = 0.32
    cy = 0.5
    r = 0.12

    # Left brace {  — tip points left, hooks on right
    draw_brace(tip_x=0.15, outer_x=0.38, cy=cy, half_h=half_h, r=r)
    # Right brace }  — tip points right, hooks on left
    draw_brace(tip_x=0.85, outer_x=0.62, cy=cy, half_h=half_h, r=r)


@icon("frontend/src/assets/icons/measurement.svg", angle=90)
def measurement(ctx):
    # Ruler icon with tick marks (centered)
    x_start, x_end = 0.12, 0.87

    # Ruler body (centered, rectangular outline)
    y_top, y_bottom = 0.35, 0.65
    ctx.move_to(x_start, y_top)
    ctx.line_to(x_end, y_top)
    ctx.line_to(x_end, y_bottom)
    ctx.line_to(x_start, y_bottom)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Tick marks (ruler scale) - 4 equal ticks
    tick_positions = [0.25, 0.4167, 0.5833, 0.75]
    tick_height = 0.18

    for x in tick_positions:
        ctx.move_to(x, y_top)
        ctx.line_to(x, y_top + tick_height)
        stroke(ctx, 1.5)


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


@icon("frontend/src/assets/icons/toolbar-copy-code.svg")
def toolbar_copy_code(ctx):
    # Classic copy icon (two overlapping rectangles) with code lines on the front sheet
    bx0, by0, bx1, by1 = 0.30, 0.12, 0.82, 0.68
    fx0, fy0, fx1, fy1 = 0.18, 0.32, 0.70, 0.88

    _copy_icon_back_rect(ctx, bx0, by0, bx1, by1, fx0, fy0, fx1, fy1)

    # Front rectangle
    ctx.move_to(fx0, fy0)
    ctx.line_to(fx1, fy0)
    ctx.line_to(fx1, fy1)
    ctx.line_to(fx0, fy1)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Code lines on front rectangle (3 short horizontal lines like text)
    margin = 0.09
    line_x0 = fx0 + margin
    line_x1 = fx1 - margin
    mid_x = (line_x0 + line_x1) / 2
    for y in [0.47, 0.60, 0.73]:
        x1 = line_x1 if y != 0.60 else mid_x
        ctx.move_to(line_x0, y)
        ctx.line_to(x1, y)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/toolbar-copy-result.svg")
def toolbar_copy_result(ctx):
    # Classic copy icon with a checkmark on the front sheet (result = success/output)
    bx0, by0, bx1, by1 = 0.30, 0.12, 0.82, 0.68
    fx0, fy0, fx1, fy1 = 0.18, 0.32, 0.70, 0.88

    _copy_icon_back_rect(ctx, bx0, by0, bx1, by1, fx0, fy0, fx1, fy1)

    # Front rectangle
    ctx.move_to(fx0, fy0)
    ctx.line_to(fx1, fy0)
    ctx.line_to(fx1, fy1)
    ctx.line_to(fx0, fy1)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Checkmark on the front rectangle
    cx = (fx0 + fx1) / 2 - 0.02
    cy = (fy0 + fy1) / 2 + 0.04
    ctx.move_to(cx - 0.14, cy)
    ctx.line_to(cx - 0.02, cy + 0.13)
    ctx.line_to(cx + 0.18, cy - 0.14)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/dialog-ok.svg")
def dialog_ok(ctx):
    # Checkmark
    ctx.move_to(0.15, 0.5)
    ctx.line_to(0.4, 0.75)
    ctx.line_to(0.85, 0.25)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/dialog-cancel.svg")
def dialog_cancel(ctx):
    # X mark
    ctx.move_to(0.2, 0.2)
    ctx.line_to(0.8, 0.8)
    stroke(ctx, 2)
    ctx.move_to(0.8, 0.2)
    ctx.line_to(0.2, 0.8)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/toolbar-project.svg")
def toolbar_project(ctx):
    """Icon for Project tool"""
    r = 0.3

    # dashed lines on top and bottom
    draw_dotted_line(ctx, 0.5 - r, 0.5 - r, 0.5 + r, 0.5 - r, 3)
    draw_dotted_line(ctx, 0.5 - r, 0.5 + r, 0.5 + r, 0.5 + r, 3)

    # Solid projected line on right side
    ctx.move_to(0.5 + r, 0.5 - (r + 0.03))
    ctx.line_to(0.5 + r, 0.5 + (r + 0.03))
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/context-rebuild.svg")
def context_rebuild(ctx):
    """Icon for Rebuild context menu entry: refresh/circular arrow."""
    arc_radius = 0.3
    start_angle = math.radians(60)
    end_angle = math.radians(350)

    ctx.arc(0.5, 0.5, arc_radius, start_angle, end_angle)
    stroke(ctx, 2)

    end_x = 0.5 + arc_radius * math.cos(end_angle)
    end_y = 0.5 + arc_radius * math.sin(end_angle)
    _arrowhead(ctx, end_x + 0.05, end_y + 0.15, math.degrees(end_angle) + 80, px(8))


@icon("frontend/src/assets/icons/context-exit.svg")
def context_exit(ctx):
    """Icon for Exit Sketch context menu entry: door + arrow."""
    # Door frame (left rectangle)
    ctx.move_to(0.2, 0.2)
    ctx.line_to(0.4, 0.2)
    ctx.line_to(0.4, 0.8)
    ctx.line_to(0.2, 0.8)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Arrow pointing right out of door
    ctx.move_to(0.5, 0.5)
    ctx.line_to(0.8, 0.5)
    stroke(ctx, 1.5)
    _arrowhead(ctx, 0.8, 0.5, 0, px(4))


@icon("frontend/src/assets/icons/context-hide.svg")
def context_hide(ctx):
    """Icon for Hide context menu entry: eye with strikethrough."""
    # Eye outline
    ctx.arc(0.5, 0.5, 0.2, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    # Pupil (small filled circle)
    ctx.arc(0.5, 0.5, px(2), 0, 2 * math.pi)
    ctx.fill()

    # Diagonal strikethrough
    ctx.move_to(0.25, 0.25)
    ctx.line_to(0.75, 0.75)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/context-delete.svg")
def context_delete(ctx):
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


@icon("frontend/src/assets/icons/icon-eye.svg")
def icon_eye(ctx):
    """Icon for Eye symbol: visible state."""
    x = 0.5
    y = 0.3
    r = 0.4
    angle = 0.15

    # Eye outline bottom half
    ctx.arc(x, y, r, math.pi * angle, math.pi * (1 - angle))
    stroke(ctx, 1.5)

    # Eye outline top half
    ctx.arc(x, 1 - y, r, math.pi * (1 + angle), math.pi * (1 - (1 + angle)))
    stroke(ctx, 1.5)

    # Pupil (small filled circle)
    pup_r = 0.1
    ctx.arc(0.5, 0.5, pup_r, 0, 2 * math.pi)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/icon-eye-off.svg")
def icon_eye_off(ctx):
    """Icon for Eye with strikethrough: hidden state, with eyelids."""
    x = 0.5
    y = 0.3
    r = 0.4
    angle = 0.15
    eyelid_angle = 0.25
    eyelid_len = 0.15

    # Eye outline bottom half
    ctx.arc(x, y, r, math.pi * angle, math.pi * (1 - angle))
    stroke(ctx, 1.5)

    # Strikethrough line
    strike = 0.25
    ctx.move_to(strike, strike)
    ctx.line_to(1 - strike, 1 - strike)
    stroke(ctx, 1.0)

    # Eyelids: small lines at the arc, parametric
    n_lids = 5
    arc_start = math.pi * eyelid_angle
    arc_end = math.pi * (1 - eyelid_angle)
    for i in range(n_lids):
        t = i / (n_lids - 1) if n_lids > 1 else 0.5
        theta = arc_start + (arc_end - arc_start) * t
        # Start point on arc
        px0 = x + r * math.cos(theta)
        py0 = y + r * math.sin(theta)
        # Outward normal direction
        nx = math.cos(theta)
        ny = math.sin(theta)
        # End point (short line outward)
        px1 = px0 + eyelid_len * nx
        py1 = py0 + eyelid_len * ny
        ctx.move_to(px0, py0)
        ctx.line_to(px1, py1)
        stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/icon-upload.svg")
def icon_upload(ctx):
    """Icon for Upload: upward arrow from a bracket."""
    # Left bracket
    box_top = 0.65
    box_bottom = 0.8
    box_left = 0.25
    box_right = 1 - box_left
    ctx.move_to(box_left, box_top)
    ctx.line_to(box_left, box_bottom)
    ctx.line_to(box_right, box_bottom)
    ctx.line_to(box_right, box_top)
    stroke(ctx, 1.5)

    # Upward arrow
    ctx.move_to(0.5, 0.35)
    ctx.line_to(0.5, 0.6)
    stroke(ctx, 1.5)
    _arrowhead(ctx, 0.5, 0.20, -90, px(6))


@icon("frontend/src/assets/icons/icon-download.svg", angle=180)
def icon_download(ctx):
    """Icon for Download: downward arrow from a bracket (flipped upload)."""
    icon_upload(ctx)


@icon("frontend/src/assets/icons/exit-sketch.svg")
def exit_sketch(ctx):
    """Icon for Exit sketch context menu entry: simple X cross."""
    # Draw an X shape (two crossing diagonal lines)
    ctx.move_to(0.2, 0.2)
    ctx.line_to(0.8, 0.8)
    stroke(ctx, 2)

    ctx.move_to(0.8, 0.2)
    ctx.line_to(0.2, 0.8)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/dots.svg")
def icon_dots(ctx):
    """Icon for Dots: three vertical dots."""
    ctx.arc(0.5, 0.2, 0.1, 0, 2 * math.pi)
    ctx.fill()
    ctx.arc(0.5, 0.5, 0.1, 0, 2 * math.pi)
    ctx.fill()
    ctx.arc(0.5, 0.8, 0.1, 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/rename.svg")
def icon_rename(ctx):
    """Icon for Rename: a text cursor"""
    top = 0.2  # y coordinate of top of cursor
    serif_len = 0.15
    serif_short = 0.027
    serif_offset = 0.02

    bot = 1 - top
    ctx.move_to(0.5, top + serif_offset)
    ctx.line_to(0.5, bot - serif_offset)
    stroke(ctx, 1.5)
    # serif at top and bottom
    for a in [-1, 1]:
        ctx.move_to(0.5 + a * serif_len,   top)
        ctx.line_to(0.5 + a * serif_short, top)
        ctx.move_to(0.5 + a * serif_len,   bot)
        ctx.line_to(0.5 + a * serif_short, bot)
        stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/feature-fillet.svg")
def feature_fillet(ctx):
    """Icon for Fillet: an L-shape with a rounded corner."""
    offset = 0.05
    radius = 0.3
    border = 0.2

    # rounded corner arc
    ctx.arc(border + radius, border + radius, radius, math.pi, math.pi * 1.5)
    stroke(ctx, 2.0)

    # arc center point (small filled circle)
    R = px(4)  # 20% larger than toolbar-point
    r = R / 3
    ctx.arc(border + radius, border + radius, r, 0, 2 * math.pi)
    ctx.fill()

    # straight line left down
    ctx.move_to(border, border + radius + offset)
    ctx.line_to(border, 1 - border)
    stroke(ctx, 1.5)

    # straight line top right
    ctx.move_to(border + radius + offset, border)
    ctx.line_to(1 - border, border)
    stroke(ctx, 1.5)




@icon("frontend/src/assets/icons/feature-chamfer.svg")
def feature_chamfer(ctx):
    """Icon for Chamfer: an L-shape with a beveled corner."""
    offset = 0.05
    radius = 0.3
    border = 0.2

    # straight corner chamfer line
    ctx.move_to(border + radius, border)
    ctx.line_to(border, border + radius)
    stroke(ctx, 2.0)

    # straight line left down
    ctx.move_to(border, border + radius + offset)
    ctx.line_to(border, 1 - border)
    stroke(ctx, 1.5)

    # straight line top right
    ctx.move_to(border + radius + offset, border)
    ctx.line_to(1 - border, border)
    stroke(ctx, 1.5)


if __name__ == "__main__":
    draw_all()
