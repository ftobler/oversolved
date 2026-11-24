import math

from icon_cairo import icon, px, stroke

from .helpers import _arrowhead, _draw_arrow, _draw_x


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


@icon("frontend/src/assets/icons/dialog-ok.svg")
def dialog_ok(ctx):
    # Checkmark
    ctx.move_to(0.15, 0.5)
    ctx.line_to(0.4, 0.75)
    ctx.line_to(0.85, 0.25)
    stroke(ctx, 2)


@icon("frontend/src/assets/icons/dialog-cancel.svg")
def dialog_cancel(ctx):
    _draw_x(ctx)


@icon("frontend/src/assets/icons/bug-report.svg")
def bug_report(ctx):
    """Icon for Report a bug: a beetle silhouette, so the card's white tint
    reads the same as every feature icon beside it."""
    cx, cy, rx, ry = 0.5, 0.60, 0.17, 0.22
    k = 0.5523

    # Body: a vertical oval from head to tail, drawn as four bezier quarters.
    ctx.move_to(cx, cy - ry)
    ctx.curve_to(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy)
    ctx.curve_to(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry)
    ctx.curve_to(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy)
    ctx.curve_to(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry)
    ctx.close_path()
    stroke(ctx, 1.5)

    # The wing split keeps the oval from reading as a plain disc at 20px; a thin
    # line leaves the body's fill area open at icon size.
    ctx.move_to(cx, 0.42)
    ctx.line_to(cx, 0.78)
    stroke(ctx, 1.0)

    # Head, filled so it stays a separate lobe from the body, and big enough
    # that a 20px card still shows two shapes rather than one blob.
    ctx.arc(cx, 0.30, 0.07, 0, 2 * math.pi)
    ctx.fill()

    # Antennae.
    for x_end in (0.38, 0.62):
        ctx.move_to(cx + (x_end - cx) * 0.5, 0.24)
        ctx.line_to(x_end, 0.13)
    stroke(ctx, 1.5)

    # Three legs a side, splayed from the body's own edge.
    for start, end in (
        ((0.36, 0.49), (0.22, 0.42)),
        ((0.33, 0.60), (0.19, 0.60)),
        ((0.36, 0.71), (0.22, 0.79)),
        ((0.64, 0.49), (0.78, 0.42)),
        ((0.67, 0.60), (0.81, 0.60)),
        ((0.64, 0.71), (0.78, 0.79)),
    ):
        ctx.move_to(*start)
        ctx.line_to(*end)
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
    _draw_x(ctx)


@icon("frontend/src/assets/icons/dots.svg")
def icon_dots(ctx):
    """Icon for Dots: three vertical dots."""
    ctx.arc(0.5, 0.2, 0.1, 0, 2 * math.pi)
    ctx.fill()
    ctx.arc(0.5, 0.5, 0.1, 0, 2 * math.pi)
    ctx.fill()
    ctx.arc(0.5, 0.8, 0.1, 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/status-warning.svg")
def status_warning(ctx):
    """Warning triangle for a solver mark, in the status line's amber."""
    ctx.set_source_rgb(236 / 255, 173 / 255, 43 / 255)
    ctx.move_to(0.5, 0.14)
    ctx.line_to(0.94, 0.84)
    ctx.line_to(0.06, 0.84)
    ctx.close_path()
    stroke(ctx, 1.5)

    ctx.move_to(0.5, 0.38)
    ctx.line_to(0.5, 0.62)
    stroke(ctx, 2)

    ctx.arc(0.5, 0.73, px(2), 0, 2 * math.pi)
    ctx.fill()


@icon("frontend/src/assets/icons/status-error.svg")
def status_error(ctx):
    """Error disc for a solver mark, in the status line's red."""
    ctx.set_source_rgb(244 / 255, 67 / 255, 54 / 255)
    ctx.arc(0.5, 0.5, 0.4, 0, 2 * math.pi)
    stroke(ctx, 1.5)

    ctx.move_to(0.5, 0.28)
    ctx.line_to(0.5, 0.56)
    stroke(ctx, 2)

    ctx.arc(0.5, 0.69, px(2), 0, 2 * math.pi)
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
