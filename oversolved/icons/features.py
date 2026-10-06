import math

from icon_cairo import icon, px, stroke

from .helpers import (
    _arrowhead,
    _copy_icon_back_rect,
    _draw_plane_grid,
    _pencil,
    _trashcan,
    draw_dotted_line,
)


@icon("frontend/src/assets/icons/context-edit.svg", angle=120)
def context_edit(ctx):
    _pencil(ctx)


@icon("frontend/src/assets/icons/context-color.svg", angle=120)
def context_color(ctx):
    _pencil(ctx)


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
    # Plane icon: 3D tilted 3x2 grid (isometric-like view)
    _draw_plane_grid(ctx, 0.2, 0.7, 0.8, 0.65, 0.75, 0.2, 0.15, 0.25)


@icon("frontend/src/assets/icons/feature-variable.svg")
def feature_variable(ctx):
    # Variable icon: an italic "x" (left) and an "=" sign (right): x = ...
    # x: two crossing diagonal strokes
    ctx.move_to(0.14, 0.3)
    ctx.line_to(0.42, 0.66)
    ctx.move_to(0.42, 0.3)
    ctx.line_to(0.14, 0.66)
    stroke(ctx, 1.5)

    # = : two horizontal strokes
    ctx.move_to(0.55, 0.43)
    ctx.line_to(0.86, 0.43)
    ctx.move_to(0.55, 0.57)
    ctx.line_to(0.86, 0.57)
    stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/feature-add-plane.svg")
def feature_add_plane(ctx):
    # Plane icon scaled to left portion, plus sign in top-right
    _draw_plane_grid(ctx, 0.1, 0.75, 0.65, 0.7, 0.6, 0.35, 0.05, 0.4)

    # Plus sign in top-right corner
    cx, cy, arm = 0.8, 0.22, 0.12
    ctx.move_to(cx - arm, cy)
    ctx.line_to(cx + arm, cy)
    stroke(ctx, 1.5)
    ctx.move_to(cx, cy - arm)
    ctx.line_to(cx, cy + arm)
    stroke(ctx, 1.5)


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


@icon("frontend/src/assets/icons/context-duplicate.svg")
def context_duplicate(ctx):
    # The copy icon's two sheets, left bare: duplicating a part copies the thing
    # itself, so the front sheet carries no content glyph the way the toolbar's
    # copy-code and copy-result variants do.
    bx0, by0, bx1, by1 = 0.30, 0.12, 0.82, 0.68
    fx0, fy0, fx1, fy1 = 0.18, 0.32, 0.70, 0.88

    _copy_icon_back_rect(ctx, bx0, by0, bx1, by1, fx0, fy0, fx1, fy1)

    ctx.move_to(fx0, fy0)
    ctx.line_to(fx1, fy0)
    ctx.line_to(fx1, fy1)
    ctx.line_to(fx0, fy1)
    ctx.close_path()
    stroke(ctx, 1.5)


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
    _trashcan(ctx)


@icon("frontend/src/assets/icons/feature-delete-body.svg")
def feature_delete_body(ctx):
    """Icon for Delete Body: trashcan."""
    _trashcan(ctx)


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


@icon("frontend/src/assets/icons/feature-array.svg")
def feature_array(ctx):
    """Icon for Array: 3x2 grid of small rectangles."""
    border = 0.1
    cols, rows = 2, 2
    gap = 0.0
    cw = (1 - 2 * border - (cols - 1) * gap) / cols
    ch = (1 - 2 * border - (rows - 1) * gap) / rows

    for row in range(rows):
        for col in range(cols):
            if row == 0 and col == 1:
                continue  # skip one rectangle to avoid looking like a filled block
            x0 = border + col * (cw + gap)
            y0 = border + row * (ch + gap)
            ctx.move_to(x0, y0)
            ctx.line_to(x0 + cw, y0)
            ctx.line_to(x0 + cw, y0 + ch)
            ctx.line_to(x0, y0 + ch)
            ctx.close_path()
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


@icon("frontend/src/assets/icons/feature-boolean.svg")
def feature_boolean(ctx):
    """Icon for Boolean: two overlapping circles (Venn diagram style)."""
    r = 0.25
    d = 0.15  # distance between circle centers

    # left and right circle
    for i in [-1, 1]:
        ctx.arc(0.5 + d * i, 0.5, r, 0, 2 * math.pi)
        stroke(ctx, 1.5)


@icon("frontend/src/assets/icons/feature-hole.svg")
def feature_hole(ctx):
    """Icon for Hole: circle with center-mark cross."""
    r = 0.25
    d = 0.4
    ctx.arc(0.5, 0.5, r, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    for i in range(4):
        ctx.save()
        ctx.translate(0.5, 0.5)
        ctx.rotate(math.radians(90 * i))
        ctx.translate(-0.5, -0.5)

        gap = 0.08
        ctx.move_to(0.5, 0.5)
        ctx.line_to(0.5, 0.5 + r - gap)
        stroke(ctx, 1.5)
        ctx.move_to(0.5, 0.5 + r + gap)
        ctx.line_to(0.5, 0.5 + d)
        stroke(ctx, 1.5)

        ctx.restore()


@icon("frontend/src/assets/icons/feature-mirror.svg")
def feature_mirror(ctx):
    """Icon for Mirror: two congruent triangles mirrored across a dashed vertical centerline."""
    # Left triangle (dashed)
    ctx.move_to(0.5, 0.15)
    ctx.line_to(0.15, 0.5)
    ctx.line_to(0.5, 0.85)
    ctx.close_path()
    stroke(ctx, 1.5)

    # Right triangle (solid)
    ctx.move_to(0.5, 0.15)
    ctx.line_to(0.85, 0.5)
    ctx.line_to(0.5, 0.85)
    ctx.close_path()
    stroke(ctx, 2.0)

    # Vertical dashed centerline
    draw_dotted_line(ctx, 0.5, 0.12, 0.5, 0.88, 3)


@icon("frontend/src/assets/icons/feature-transform.svg")
def feature_transform(ctx):
    """Icon for Transform: ghost box shifted with translation arrows."""
    # Ghost box (thin, left+down)
    box_left, box_top, box_w, box_h = 0.15, 0.45, 0.4, 0.4
    ctx.rectangle(box_left, box_top, box_w, box_h)
    stroke(ctx, 1.5)

    # Solid destination box offset right+up
    ctx.rectangle(box_left + 0.3, box_top - 0.25, box_w, box_h)
    stroke(ctx, 2.0)

    def partial_line(x0, y0, x1, y1, t_start=0, t_end=1, stroke_width=1.5):
        """Draw a line from (x0,y0) to (x1,y1) but only the portion from t_start to t_end (0 ≤ t_start < t_end ≤ 1)."""
        sx = x0 + (x1 - x0) * t_start
        sy = y0 + (y1 - y0) * t_start
        ex = x0 + (x1 - x0) * t_end
        ey = y0 + (y1 - y0) * t_end
        ctx.move_to(sx, sy)
        ctx.line_to(ex, ey)
        stroke(ctx, stroke_width)

    # thin lines connecting corners of the two boxes
    # but only top-left and bottom-right corners to avoid clutter
    partial_line(box_left, box_top, box_left + 0.3, box_top - 0.25, 0.3, 0.7)
    partial_line(box_left + box_w, box_top + box_h, box_left + 0.3 + box_w, box_top - 0.25 + box_h, 0.3, 0.65)
