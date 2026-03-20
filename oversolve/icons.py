from icon_cairo import icon, drawall, px, stroke
import math


# ctx is from pycairo


def draw_dotted_line(ctx, x0, y0, x1, y1, num_dots):
    for i in range(num_dots):
        t0 = i / num_dots
        t1 = (i + 0.5) / num_dots
        ctx.move_to(x0 + (x1 - x0) * t0, y0 + (y1 - y0) * t0)
        ctx.line_to(x0 + (x1 - x0) * t1, y0 + (y1 - y0) * t1)
    stroke(ctx, 1.5)


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


@icon("frontend/src/assets/icons/constraint-coincident.svg", angle=-10)
def constraint_coincident(ctx):
    # a line with a point on it and a dotted line coming off that point

    # Draw main line
    ctx.move_to(0.2, 0.7)
    ctx.line_to(0.8, 0.7)
    stroke(ctx, 1.5)

    # Draw point on the line (center)
    ctx.arc(0.5, 0.7, px(2.2), 0, 2 * math.pi)
    ctx.fill()

    # Draw dotted line coming off the point (can be diagonal)
    x0, y0 = 0.5, 0.7
    x1, y1 = 0.35, 0.2
    num_dots = 3
    draw_dotted_line(ctx, x0, y0, x1, y1, num_dots)


@icon("frontend/src/assets/icons/constraint-colinear.svg", angle=15)
def constraint_colinear(ctx):
    # two parallel lines, one dotted. shifted at an angle.

    # normal line
    ctx.move_to(0.25, 0.6)
    ctx.line_to(0.85, 0.6)
    stroke(ctx, 1.5)

    # dotted line (above, parallel)
    x0, y0 = 0.15, 0.4
    x1, y1 = 0.8, 0.4
    num_dots = 4
    draw_dotted_line(ctx, x0, y0, x1, y1, num_dots)


if __name__ == "__main__":
    drawall()
