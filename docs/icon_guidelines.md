# Icon Guidelines

Icons in this project follow the **Material Icons Outlined** style.

## Rules

| Property | Value |
|---|---|
| viewBox | `0 0 24 24` |
| Size | 24 × 24 px |
| Color | `currentColor` (inherits from CSS `color`) |
| Fill style | `fill="none"` on paths/lines, `fill="currentColor"` on solid shapes (dots, arrowheads) |
| Stroke width | `2` for primary lines, `1.5` for secondary/detail lines |
| Stroke caps | `stroke-linecap="round"` |
| Stroke joins | `stroke-linejoin="round"` |
| Padding | ~2-3 px from edge |
| Monochrome | Yes — no hardcoded colors, never use `#hex` or `rgb()` |

## How to add icons

Icons are defined **programmatically in `oversolved/icons.py`** using Python and Cairo. The `@icon` decorator generates the SVG file automatically at build time.

Add a function decorated with `@icon`:

```python
@icon("frontend/src/assets/icons/my-icon.svg")
def my_icon(ctx):
    # Draw using Cairo primitives
    ctx.move_to(0.2, 0.5)
    ctx.line_to(0.8, 0.5)
    stroke(ctx, 2)

    # Filled shapes use ctx.fill()
    ctx.arc(0.5, 0.5, 0.1, 0, 2 * math.pi)
    ctx.fill()
```

Then run:
```bash
python oversolved/icons.py
```

This generates the SVG file at the specified path.

### Coordinates

- Coordinates are **normalized to 0–1** (not pixels)
- Use `px()` helper to convert pixel dimensions: `px(2)` = 2 pixels on a 24×24 canvas
- For example, `px(2.5)` creates a dot radius of 2.5 pixels

### Naming

- Path: `frontend/src/assets/icons/<group>-<name>.svg`

## Cairo drawing primitives

Use these when defining icons in `icons.py`:

- **Lines** → `ctx.move_to(x0, y0)` + `ctx.line_to(x1, y1)` + `stroke(ctx, width)`
- **Circles / rings** → `ctx.arc(cx, cy, radius, 0, 2*math.pi)` + `stroke()` (outline) or `ctx.fill()` (solid)
- **Arcs** → `ctx.arc(cx, cy, radius, angle0, angle1)` + `stroke()`
- **Paths** → `ctx.move_to()`, `ctx.line_to()`, `ctx.curve_to()` for Bézier curves
- **Filled shapes** → `ctx.close_path()` + `ctx.fill()` (triangles, polygons, arrowheads)
- **Dots** → `ctx.arc()` with `ctx.fill()`, use `px(radius)` for pixel-based sizes
- For tick marks perpendicular to a line with direction `(dx, dy)`: the perpendicular unit vector is `(dy, -dx) / length`. Extend 2–3 px each way from the midpoint.

### Common helpers

- `stroke(ctx, width)` — stroke with current color
- `px(n)` — convert pixels to normalized coordinates (e.g., `px(2.5)` for a 2.5-pixel dimension)
- `math.atan2()`, `math.cos()`, `math.sin()` — for angle calculations

## Do not

- Hardcode colors — always use the stroke/fill helpers which respect `currentColor`
- Set `stroke()` implicitly — be explicit about which operations should stroke/fill
- Draw SVG files manually (use `icons.py` instead for programmatic generation)
- Mix multiple stroke widths beyond 2 / 1.5 (consistency with guidelines)
- Use `ctx.fill()` on open paths — they will close unexpectedly; use `stroke()` instead
- Forget to call `drawall()` at the end of `icons.py` to regenerate SVG files
