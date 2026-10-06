import math

from icon_cairo import icon, px, stroke

from .helpers import _arrowhead, _draw_rect_outline, _pencil, draw_dotted_line


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
    stroke(ctx, 1.5)


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


@icon("frontend/src/assets/icons/feature-sweep.svg")
def toolbar_sweep(ctx):
    # Sweep icon: a profile rectangle swept along a curved path arrow
    # Profile rectangle at the start of the path
    x0, x1 = 0.12, 0.34
    y0, y1 = 0.18, 0.50
    ctx.move_to(x0, y0)
    ctx.line_to(x1, y0)
    ctx.line_to(x1, y1)
    ctx.line_to(x0, y1)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Curved path the profile follows, from the rectangle down and to the right
    ctx.move_to(0.23, 0.50)
    ctx.curve_to(0.23, 0.80, 0.55, 0.85, 0.82, 0.70)
    stroke(ctx, 1.5)
    _arrowhead(ctx, 0.82, 0.70, -25, px(8))


@icon("frontend/src/assets/icons/feature-sketch.svg", angle=120)
def toolbar_sketch(ctx):
    _pencil(ctx)


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
