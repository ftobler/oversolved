/**
 * Incremental highlight painting for a body's vertex-colour buffer.
 *
 * A hover or a click recolours ONE primitive, but the colour buffer that
 * primitive lives in covers the whole body. Rebuilding the buffer per pointer
 * move is what made hovering a heavy import unusable: an imported solid carries
 * hundreds of thousands of triangles, so every move rebuilt tens of megabytes on
 * the CPU and handed them to a fresh BufferAttribute -- which drops the old GL
 * buffer and re-uploads the entire new one.
 *
 * So the buffer is written in place, only where the highlight state actually
 * changed, and the touched float ranges are reported so the upload can be a
 * couple of `bufferSubData` calls instead of the whole buffer.
 *
 * Deliberately three.js-free: the primitive layout (which vertices a face or an
 * edge owns) and the diffing are the parts worth testing headlessly. `uploadPaint`
 * is the only seam that touches an attribute, and it takes the structural
 * interface rather than the class.
 */

/** Per-primitive paint state. Zero (the initial state of the tracking array)
 *  means "never painted", which is why the states below start at one. */
const BASE = 1
const SELECTED = 2
const HOVERED = 3

/**
 * Above this many ranges the per-range `bufferSubData` overhead beats one full
 * upload, so the result degrades to `full`. Reached only when a repainted
 * primitive's vertices are scattered through the buffer (a face whose triangles
 * are not contiguous), never on the ordinary one-face hover.
 */
const MAX_UPLOAD_RANGES = 64

export type RGB = readonly [number, number, number]

export interface HighlightPalette {
  base: RGB
  selected: RGB
  hovered: RGB
}

/**
 * Which vertices of the colour buffer each primitive owns.
 *
 * `eachRun` reports contiguous vertex runs (in vertices, not floats) so a face
 * whose triangles are consecutive -- the normal case, since a tessellator emits
 * a face's triangles together -- costs one upload range instead of one per
 * triangle.
 */
export interface PrimitiveRuns {
  count: number
  eachRun(index: number, visit: (vertexStart: number, vertexCount: number) => void): void
}

/** A float range of the colour buffer, in the units `addUpdateRange` expects. */
export interface PaintRange { start: number; count: number }

export interface PaintResult {
  // Ranges written. Meaningless when `full`; empty when nothing changed.
  ranges: PaintRange[]
  // The whole buffer must be uploaded (first paint, palette change, or too many ranges).
  full: boolean
  // Primitives whose colour was rewritten. Zero means the buffer is untouched.
  repainted: number
}

const NO_CHANGE: PaintResult = { ranges: [], full: false, repainted: 0 }

/** One primitive per triangle, three consecutive vertices each. The layout for a
 *  mesh carrying no usable per-face metadata. */
export function triangleRuns(triangleCount: number): PrimitiveRuns {
  return {
    count: triangleCount,
    eachRun: (index, visit) => visit(index * 3, 3),
  }
}

/**
 * One primitive per B-rep face, owning its triangles' vertices. `trianglesOf`
 * answers a face's triangle indices (see `lazyFaceTriangles`); consecutive
 * triangles are merged into a single run.
 */
export function faceRuns(
  faceCount: number,
  trianglesOf: (faceIndex: number) => readonly number[] | undefined,
): PrimitiveRuns {
  return {
    count: faceCount,
    eachRun: (index, visit) => {
      const tris = trianglesOf(index)
      if (!tris || tris.length === 0) return
      let start = -1
      let length = 0
      for (const tri of tris) {
        if (start >= 0 && tri === start + length) { length++; continue }
        if (start >= 0) visit(start * 3, length * 3)
        start = tri
        length = 1
      }
      if (start >= 0) visit(start * 3, length * 3)
    },
  }
}

/**
 * One primitive per edge, owning its line segments' vertices (two per segment).
 * `segmentCounts[i]` is edge i's segment count, in the same order the segment
 * positions were flattened, so each edge is one contiguous run.
 */
export function edgeRuns(segmentCounts: readonly number[]): PrimitiveRuns {
  const offsets = new Uint32Array(segmentCounts.length + 1)
  for (let i = 0; i < segmentCounts.length; i++) offsets[i + 1] = offsets[i] + segmentCounts[i]
  return {
    count: segmentCounts.length,
    eachRun: (index, visit) => {
      const segments = offsets[index + 1] - offsets[index]
      if (segments > 0) visit(offsets[index] * 2, segments * 2)
    },
  }
}

export class HighlightColorPainter {
  private readonly colors: Float32Array
  private readonly runs: PrimitiveRuns
  private readonly state: Uint8Array
  private palette: HighlightPalette | null = null

  constructor(colors: Float32Array, runs: PrimitiveRuns) {
    this.colors = colors
    this.runs = runs
    this.state = new Uint8Array(runs.count)
  }

  /**
   * Bring the buffer in line with `selected` / `hovered` (indexed by primitive;
   * null means "none"). Selection outranks hover, matching the overlay
   * precedence. Returns what needs uploading.
   */
  apply(
    selected: readonly boolean[] | null,
    hovered: readonly boolean[] | null,
    palette: HighlightPalette,
  ): PaintResult {
    const repaintAll = this.palette === null || !samePalette(this.palette, palette)
    this.palette = palette
    const { count } = this.runs

    if (repaintAll) {
      // A palette change (the body itself got selected, or its colour prop
      // changed) moves every primitive, so fill the base colour across the whole
      // buffer -- including any vertex no primitive claims -- and then stamp the
      // highlighted ones on top.
      this.fill(palette.base)
      for (let i = 0; i < count; i++) {
        const next = stateOf(i, selected, hovered)
        this.state[i] = next
        if (next !== BASE) this.paint(i, colorFor(next, palette), null)
      }
      return { ranges: [], full: true, repainted: count }
    }

    const ranges: PaintRange[] = []
    let repainted = 0
    let overflow = false
    for (let i = 0; i < count; i++) {
      const next = stateOf(i, selected, hovered)
      if (this.state[i] === next) continue
      this.state[i] = next
      this.paint(i, colorFor(next, palette), overflow ? null : ranges)
      repainted++
      if (ranges.length > MAX_UPLOAD_RANGES) overflow = true
    }
    if (repainted === 0) return NO_CHANGE
    return overflow ? { ranges: [], full: true, repainted } : { ranges, full: false, repainted }
  }

  // Test/diagnostic accessor: the paint state of one primitive.
  stateAt(index: number): 'unpainted' | 'base' | 'selected' | 'hovered' {
    const state = this.state[index]
    if (state === SELECTED) return 'selected'
    if (state === HOVERED) return 'hovered'
    if (state === BASE) return 'base'
    return 'unpainted'
  }

  private paint(index: number, rgb: RGB, ranges: PaintRange[] | null): void {
    this.runs.eachRun(index, (vertexStart, vertexCount) => {
      const end = (vertexStart + vertexCount) * 3
      for (let f = vertexStart * 3; f < end; f += 3) {
        this.colors[f] = rgb[0]
        this.colors[f + 1] = rgb[1]
        this.colors[f + 2] = rgb[2]
      }
      if (ranges) addRange(ranges, vertexStart * 3, vertexCount * 3)
    })
  }

  private fill(rgb: RGB): void {
    for (let f = 0; f < this.colors.length; f += 3) {
      this.colors[f] = rgb[0]
      this.colors[f + 1] = rgb[1]
      this.colors[f + 2] = rgb[2]
    }
  }
}

/**
 * Push a float range, extending the previous one when they touch. Keeps the
 * ordinary case (one primitive, contiguous vertices) at a single range.
 *
 * Merging is only valid FORWARD, and the guard says so rather than assuming it:
 * `runs` hands out whatever layout its owner has, and `faceRuns` takes an
 * arbitrary `trianglesOf` callback, so a run starting BEFORE the previous one is
 * a layout away, not a language guarantee. Extending by `Math.max` on such a run
 * would leave `last` unchanged and the earlier floats in no range at all --
 * written on the CPU, never uploaded, so the primitive keeps its old colour on
 * screen. Out-of-order runs simply get their own entry; coverage stays exact and
 * the only cost is a range the `MAX_UPLOAD_RANGES` ceiling already accounts for.
 */
function addRange(ranges: PaintRange[], start: number, count: number): void {
  const last = ranges[ranges.length - 1]
  if (last && start >= last.start && start <= last.start + last.count) {
    last.count = Math.max(last.count, start + count - last.start)
    return
  }
  ranges.push({ start, count })
}

function stateOf(
  index: number,
  selected: readonly boolean[] | null,
  hovered: readonly boolean[] | null,
): number {
  if (selected?.[index]) return SELECTED
  if (hovered?.[index]) return HOVERED
  return BASE
}

function colorFor(state: number, palette: HighlightPalette): RGB {
  if (state === SELECTED) return palette.selected
  if (state === HOVERED) return palette.hovered
  return palette.base
}

function sameRGB(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2]
}

function samePalette(a: HighlightPalette, b: HighlightPalette): boolean {
  return sameRGB(a.base, b.base) && sameRGB(a.selected, b.selected) && sameRGB(a.hovered, b.hovered)
}

/**
 * The subset of `THREE.BufferAttribute` an upload needs. Structural so the
 * painter's tests need no GL context and no three.js scene.
 */
export interface UpdatableAttribute {
  needsUpdate: boolean
  // Float length of the colour buffer, so a `full` result can be expressed as
  // one buffer-covering update range rather than as an empty range list (which
  // a later partial apply would silently override before the renderer reads it).
  readonly array: { readonly length: number }
  clearUpdateRanges(): void
  addUpdateRange(start: number, count: number): void
}

/**
 * Flush a paint result to the attribute. A partial result uploads only its
 * ranges; `full` queues one buffer-covering range so three.js re-uploads the
 * whole buffer; an unchanged buffer leaves `needsUpdate` alone, which is what
 * keeps a pointer move over an already-highlighted primitive free.
 */
export function uploadPaint(attribute: UpdatableAttribute, result: PaintResult): void {
  if (result.repainted === 0) return
  if (result.full) {
    // One buffer-covering range, NOT an empty list: an empty list means "full"
    // to three.js only until the next addUpdateRange, and a partial apply landing
    // in the same frame would then drop the full upload entirely. three.js
    // sorts+merges ranges, so a later partial range just merges into this one.
    attribute.clearUpdateRanges()
    attribute.addUpdateRange(0, attribute.array.length)
  } else {
    for (const range of result.ranges) attribute.addUpdateRange(range.start, range.count)
  }
  attribute.needsUpdate = true
}

export const HIGHLIGHT_PAINTER_MAX_RANGES = MAX_UPLOAD_RANGES
