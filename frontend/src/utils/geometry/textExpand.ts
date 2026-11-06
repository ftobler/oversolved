// Sketch lettering: a string becomes closed glyph contours of line and cubic
// segments, placed on a baseline in sketch coordinates. The outlines come from
// the checked-in table `scripts/generateSketchGlyphs.mjs` writes, so the
// runtime carries no font parser and fetches nothing; the generator already
// resolved the TrueType rules and elevated every quadratic to its exact cubic,
// so this module only scales, rotates and translates.
//
// Pure and unrounded: the applier rounds each point once and chains the
// rounded pairs, so the one-stored-precision rule stays in one place.

// The attribute is not optional: the drive CLI and the MCP server run this
// source under plain Node ESM, which refuses a JSON import without it.
import glyphAsset from '@/assets/fonts/roboto-400-glyphs.json' with { type: 'json' }

/** The largest run one `add_text` step may expand into, in entities. A name
 *  tag is a few hundred; past this a typo (a pasted paragraph) is likelier
 *  than intent, and the sketch solver pays for every entity. */
export const MAX_TEXT_ENTITIES = 2000

/** Printable ASCII, the whole v1 character set. */
export const FIRST_TEXT_CODE = 32
export const LAST_TEXT_CODE = 126

export const TEXT_ALIGNS = ['left', 'center', 'right'] as const
export type TextAlign = typeof TEXT_ALIGNS[number]

export const DEFAULT_TEXT_SIZE = 10

type Pair = [number, number]

/** A segment after the contour start: a line `[x, y]` or a cubic
 *  `[c1x, c1y, c2x, c2y, x, y]`, in font units, y up. */
export type GlyphSegment = number[]

export interface GlyphContour {
  start: number[]
  segments: GlyphSegment[]
}

export interface GlyphTable {
  unitsPerEm: number
  ascender: number
  descender: number
  glyphs: Record<string, { advance: number; contours: GlyphContour[] }>
}

/** The bundled Roboto 400 table, held to the interface by assignment so a
 *  regenerated asset of the wrong shape fails the build. */
export const SKETCH_GLYPHS: GlyphTable = glyphAsset

export interface TextPlacement {
  // Baseline start of the run, in sketch coordinates.
  origin?: Pair
  // Em size in document units.
  size?: number
  // Baseline direction, degrees counter-clockwise from sketch +x.
  angle?: number
  // Which end (or the middle) of the run's advance width sits on `origin`.
  align?: TextAlign
}

/** One placed segment: `points` holds the points after the start (one for a
 *  line, three for a cubic), in sketch coordinates. */
export interface PlacedSegment {
  kind: 'line' | 'spline'
  points: Pair[]
}

export interface PlacedContour {
  start: Pair
  segments: PlacedSegment[]
}

function hex(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, '0')}`
}

/** The first character of `text` the table cannot draw, named by code point,
 *  or null. Iterates code points, so an astral character is one refusal, not
 *  two lone surrogates. */
export function unsupportedCharacterProblem(text: string, table: GlyphTable = SKETCH_GLYPHS): string | null {
  for (const ch of text) {
    const code = ch.codePointAt(0) as number
    if (code < FIRST_TEXT_CODE || code > LAST_TEXT_CODE || table.glyphs[String(code)] === undefined) {
      return `character ${JSON.stringify(ch)} (${hex(code)}) is outside the supported printable ASCII range `
        + `${hex(FIRST_TEXT_CODE)}..${hex(LAST_TEXT_CODE)}; unknown characters are refused, not dropped`
    }
  }
  return null
}

/** How many entities the run expands into before zero-length segments are
 *  dropped, so the cap is a property of the string alone. */
export function textEntityCount(text: string, table: GlyphTable = SKETCH_GLYPHS): number {
  let count = 0
  for (const ch of text) {
    const glyph = table.glyphs[String(ch.codePointAt(0))]
    if (glyph === undefined) continue
    for (const contour of glyph.contours) count += contour.segments.length
  }
  return count
}

function isFinitePair(value: unknown): value is Pair {
  return Array.isArray(value) && value.length === 2 && value.every(v => typeof v === 'number' && Number.isFinite(v))
}

/** Why an `add_text` field set cannot expand, or null. One check for the drive
 *  value rule and the applier, so a direct dispatch refuses exactly what the
 *  drive refuses. Every field but `text` is optional. */
export function textFieldsProblem(fields: {
  text?: unknown
  origin?: unknown
  size?: unknown
  angle?: unknown
  align?: unknown
}, table: GlyphTable = SKETCH_GLYPHS): string | null {
  const { text, origin, size, angle, align } = fields
  if (typeof text !== 'string' || text.length === 0) {
    return `text must be a non-empty string, got ${JSON.stringify(text ?? null)}`
  }
  if (size !== undefined && (typeof size !== 'number' || !Number.isFinite(size) || size <= 0)) {
    return `size must be a positive finite em size in document units, got ${JSON.stringify(size)}`
  }
  if (origin !== undefined && !isFinitePair(origin)) {
    return `origin must be a finite [x, y] baseline start, got ${JSON.stringify(origin)}`
  }
  if (angle !== undefined && (typeof angle !== 'number' || !Number.isFinite(angle))) {
    return `angle must be a finite number of degrees, got ${JSON.stringify(angle)}`
  }
  if (align !== undefined && !(TEXT_ALIGNS as readonly unknown[]).includes(align)) {
    return `align must be one of ${TEXT_ALIGNS.join(', ')}, got ${JSON.stringify(align)}`
  }
  const characterProblem = unsupportedCharacterProblem(text, table)
  if (characterProblem !== null) return characterProblem
  const count = textEntityCount(text, table)
  if (count > MAX_TEXT_ENTITIES) {
    return `text expands into ${count} entities, more than MAX_TEXT_ENTITIES (${MAX_TEXT_ENTITIES}) `
      + 'one add_text step may create; split it over several steps or sketches'
  }
  return null
}

/** The run's total advance in font units. Kerning is not applied: the pen
 *  moves by each glyph's own advance. */
function runAdvance(text: string, table: GlyphTable): number {
  let width = 0
  for (const ch of text) width += table.glyphs[String(ch.codePointAt(0))]?.advance ?? 0
  return width
}

/**
 * Place `text` as closed contours in sketch coordinates. The caller has
 * already refused unsupported characters; an unknown one here is skipped so
 * the function stays total. Contours keep the font's order and winding: the
 * profile builder fills even-odd, so a counter ("o", "B") is a hole however it
 * winds.
 */
export function expandText(
  text: string,
  placement: TextPlacement = {},
  table: GlyphTable = SKETCH_GLYPHS,
): PlacedContour[] {
  const [ox, oy] = placement.origin ?? [0, 0]
  const scale = (placement.size ?? DEFAULT_TEXT_SIZE) / table.unitsPerEm
  const rad = ((placement.angle ?? 0) * Math.PI) / 180
  const cos = Math.cos(rad)
  const sin = Math.sin(rad)
  const align = placement.align ?? 'left'
  const width = runAdvance(text, table)
  let pen = align === 'center' ? -width / 2 : align === 'right' ? -width : 0

  const place = (fx: number, fy: number): Pair => {
    const u = (pen + fx) * scale
    const v = fy * scale
    return [ox + cos * u - sin * v, oy + sin * u + cos * v]
  }

  const contours: PlacedContour[] = []
  for (const ch of text) {
    const glyph = table.glyphs[String(ch.codePointAt(0))]
    if (glyph === undefined) continue
    for (const contour of glyph.contours) {
      const segments: PlacedSegment[] = contour.segments.map(seg => seg.length === 2
        ? { kind: 'line', points: [place(seg[0], seg[1])] }
        : { kind: 'spline', points: [place(seg[0], seg[1]), place(seg[2], seg[3]), place(seg[4], seg[5])] })
      contours.push({ start: place(contour.start[0], contour.start[1]), segments })
    }
    pen += glyph.advance
  }
  return contours
}
