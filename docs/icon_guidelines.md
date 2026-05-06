# Icon Guidelines

Icons are defined programmatically in `oversolved/icons.py` using Cairo and the `@icon` decorator from `oversolved/icon_cairo.py`. Running `python oversolved/icons.py` regenerates all SVGs in `frontend/src/assets/icons/`.

## SVG Properties

| Property | Value |
|---|---|
| viewBox | `0 0 24 24` |
| Color | Hardcoded black via Cairo's `source_default()` |
| Stroke style | `fill="none"` on stroked paths |
| Stroke widths | `2` primary, `1.5` secondary, `1.0` accent |
| Stroke joins | `round` |
| Padding | ~2-3 px from edge |

Icons are loaded as `<img src={icon}>`, so SVG colors are hardcoded. No `currentColor` inheritance.

## Adding an Icon

```python
@icon("frontend/src/assets/icons/my-icon.svg")
def my_icon(ctx):
    ctx.move_to(0.2, 0.5)
    ctx.line_to(0.8, 0.5)
    stroke(ctx, 2)
    ctx.arc(0.5, 0.5, 0.1, 0, 2 * math.pi)
    ctx.fill()
```

### `@icon` decorator

```python
@icon(path, angle=0, offset_x=0, offset_y=0)
```

- `path` — output relative to repo root
- `angle` — rotation (degrees, around center)
- `offset_x`, `offset_y` — translation (normalized 0-1)

### Coordinates

Normalized 0-1 (not pixels). Use `px()` helper for pixel dimensions: `px(2)` = 2px on 24x24 canvas.

### Helpers

| Helper | Purpose |
|---|---|
| `_arrowhead(ctx, x, y, angle, size)` | Filled triangle at `(x,y)` pointing at `angle` (deg) |
| `_draw_arrow(ctx, x0, y0, x1, y1, arr)` | Arrow with heads at both ends |
| `draw_dotted_line(ctx, x0, y0, x1, y1, num_dots)` | Line rendered as dashes |
| `_pencil(ctx)` | Pencil icon shape (horizontal) |
| `_trashcan(ctx)` | Trash can icon |

## Frontend Usage

- **Toolbar buttons**: registry `toolbarIcon` field resolved via `iconUrl()` using `import.meta.glob` eager loading
- **Direct imports**: components import specific SVGs (e.g. `import icon from '../assets/icons/feature-extrude.svg'`)
- **Constraint symbols**: `SketchSvg.tsx` maps `RENDER_KIND_TO_ICON` via glob-loaded modules

## Do Not

- Hardcode colors in SVG output — use Cairo helpers producing consistent black
- Draw SVG files manually — use `icons.py`
- Mix stroke widths beyond 2/1.5/1.0 without documented reason
- Use `ctx.fill()` on open paths — use `stroke()` instead
- Forget to regenerate: `python oversolved/icons.py`
