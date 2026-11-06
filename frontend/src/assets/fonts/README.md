# Sketch glyph table

`roboto-400-glyphs.json` is the outline table the `add_text` mutation expands
a string from (`src/utils/geometry/textExpand.ts`). It is generated, not
hand-edited:

- Source: `frontend/public/fonts/roboto-latin-400-normal.woff`, the same file
  the viewport labels self-host. The font version string is the asset's
  `version` field.
- Generator: `node scripts/generateSketchGlyphs.mjs` from `frontend/`, through
  the Typr and woff2otf builds `troika-three-text` already installs.
  `--check` exits non-zero when the checked-in table differs from a fresh
  generation, and `textExpand.test.ts` runs it.
- Shape: font units, y up. Each glyph has an `advance` and closed `contours`;
  a contour is a `start` point and `segments`, each a line `[x, y]` or a cubic
  `[c1x, c1y, c2x, c2y, x, y]` (quadratics are degree-elevated exactly), and
  the last segment ends on `start`.
- Licence: Roboto is Apache-2.0; `roboto-LICENSE.txt` beside this file is the
  notice that travels with the derived outlines.
