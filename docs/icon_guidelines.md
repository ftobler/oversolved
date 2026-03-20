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

Each icon is a **standalone SVG file** under `src/assets/icons/`. Do not use `<symbol>` wrappers — they are invisible in browsers, Inkscape and image previewers unless referenced via `<use>`.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <!-- primary line -->
  <line x1="4" y1="12" x2="20" y2="12"
        stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
  <!-- filled dot / arrowhead -->
  <circle cx="12" cy="12" r="2.5" fill="currentColor"/>
</svg>
```

### Naming

- File: `src/assets/icons/<group>-<name>.svg`

## Geometry tips

- **Lines** → `<line>` with `stroke="currentColor"`
- **Circles / rings** → `<circle fill="none" stroke="currentColor">` for outlines, `fill="currentColor"` for filled dots
- **Arcs** → `<path d="M ... A ..." fill="none" stroke="currentColor">`
- **Diagonal lines** → use `<line>` with computed endpoints, not `<rect transform="rotate(…)">`
- **Arrowheads** → open `<path>` chevrons (`M x1 y1 L tip L x2 y2`) at `stroke-width="1.5"`, or small filled `<polygon>` triangles
- **Right-angle markers** → `<polyline>` forming the corner square notch inside the angle
- For tick marks perpendicular to a line with direction `(dx, dy)`: the perpendicular unit vector is `(dy, -dx) / length`. Extend 2–3 px each way from the midpoint.

## Do not

- Hardcode colors (`fill="#333"`, `stroke="black"`, etc.)
- Use `stroke="none"` implicitly — set it explicitly where needed to prevent double-painting
- Use `<rect transform="rotate(…)">` for diagonal lines (prefer `<line>`)
- Mix multiple stroke widths beyond 2 / 1.5
- Use fills on open paths (they close unexpectedly)
