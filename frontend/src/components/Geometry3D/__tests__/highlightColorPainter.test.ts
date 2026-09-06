import { describe, it, expect } from 'vitest'
import {
  HighlightColorPainter, uploadPaint, faceRuns, triangleRuns, edgeRuns,
  HIGHLIGHT_PAINTER_MAX_RANGES,
  type HighlightPalette, type PrimitiveRuns, type PaintResult, type UpdatableAttribute,
} from '@/components/Geometry3D/highlightColorPainter'

/**
 * Hovering a body used to rebuild its ENTIRE per-triangle colour buffer and hand
 * it to a new BufferAttribute -- O(triangles) of CPU work plus a full GL re-upload
 * on every pointer move. On an imported solid (hundreds of thousands of triangles)
 * that is tens of megabytes per move, and it is what pinned hover under 1 fps.
 *
 * These tests pin the property that replaces it: a hover that moves one primitive
 * touches only that primitive's vertices, and reports only their float ranges.
 * The parity test is the safety net -- whatever the diffing does, the buffer must
 * end up byte-identical to the full rebuild it replaced.
 */

const PALETTE: HighlightPalette = {
  base: [0.25, 0.5, 0.75],
  selected: [1, 0, 0],
  hovered: [0, 1, 0],
}

/** The colour buffer the old whole-buffer rebuild would have produced. */
function reference(
  runs: PrimitiveRuns,
  vertexCount: number,
  selected: readonly boolean[] | null,
  hovered: readonly boolean[] | null,
  palette: HighlightPalette,
): Float32Array {
  const colors = new Float32Array(vertexCount * 3)
  for (let f = 0; f < colors.length; f += 3) {
    colors[f] = palette.base[0]; colors[f + 1] = palette.base[1]; colors[f + 2] = palette.base[2]
  }
  for (let i = 0; i < runs.count; i++) {
    const rgb = selected?.[i] ? palette.selected : hovered?.[i] ? palette.hovered : palette.base
    runs.eachRun(i, (start, count) => {
      for (let v = start; v < start + count; v++) {
        colors[v * 3] = rgb[0]; colors[v * 3 + 1] = rgb[1]; colors[v * 3 + 2] = rgb[2]
      }
    })
  }
  return colors
}

function flags(count: number, ...on: number[]): boolean[] {
  const out = new Array<boolean>(count).fill(false)
  for (const i of on) out[i] = true
  return out
}

function paintedFloats(result: PaintResult): number {
  return result.ranges.reduce((sum, r) => sum + r.count, 0)
}

/** 8 faces x 25 triangles, the tessellator's contiguous layout. */
const FACES = 8
const TRIS_PER_FACE = 25
const TRI_COUNT = FACES * TRIS_PER_FACE
const CONTIGUOUS = faceRuns(FACES, (f) => Array.from(
  { length: TRIS_PER_FACE }, (_, i) => f * TRIS_PER_FACE + i))

describe('HighlightColorPainter', () => {
  it('paints the whole buffer on the first apply, base colour included', () => {
    const colors = new Float32Array(TRI_COUNT * 9)
    const painter = new HighlightColorPainter(colors, CONTIGUOUS)

    const result = painter.apply(null, flags(FACES, 3), PALETTE)

    expect(result.full).toBe(true)
    expect(colors).toEqual(reference(CONTIGUOUS, TRI_COUNT * 3, null, flags(FACES, 3), PALETTE))
    expect(painter.stateAt(3)).toBe('hovered')
    expect(painter.stateAt(0)).toBe('base')
  })

  it('a hover moving from one face to the next repaints only those two faces', () => {
    const colors = new Float32Array(TRI_COUNT * 9)
    const painter = new HighlightColorPainter(colors, CONTIGUOUS)
    painter.apply(null, flags(FACES, 2), PALETTE)

    const result = painter.apply(null, flags(FACES, 3), PALETTE)

    expect(result.full).toBe(false)
    expect(result.repainted).toBe(2)
    // Contiguous triangles collapse into one range per face -- and these two
    // faces are neighbours, so the ranges merge again into one.
    expect(result.ranges.length).toBe(1)
    expect(paintedFloats(result)).toBe(2 * TRIS_PER_FACE * 9)
    // ...which is a small fraction of the buffer the old path re-uploaded.
    expect(paintedFloats(result)).toBeLessThan(colors.length / 3)
  })

  it('re-applying the same flags touches nothing', () => {
    const colors = new Float32Array(TRI_COUNT * 9)
    const painter = new HighlightColorPainter(colors, CONTIGUOUS)
    painter.apply(null, flags(FACES, 2), PALETTE)

    const result = painter.apply(null, flags(FACES, 2), PALETTE)

    expect(result).toEqual({ ranges: [], full: false, repainted: 0 })
  })

  it('stays byte-identical to the full rebuild across a hover walk and a growing selection', () => {
    const colors = new Float32Array(TRI_COUNT * 9)
    const painter = new HighlightColorPainter(colors, CONTIGUOUS)
    const selected = flags(FACES)

    for (const hoveredFace of [0, 5, 5, 7, 1, 3, 0]) {
      const hovered = flags(FACES, hoveredFace)
      painter.apply(selected, hovered, PALETTE)
      expect(colors).toEqual(reference(CONTIGUOUS, TRI_COUNT * 3, selected, hovered, PALETTE))
      // Selection wins over hover on the same face, exactly as the overlays rank it.
      selected[hoveredFace] = true
      painter.apply(selected, hovered, PALETTE)
      expect(colors).toEqual(reference(CONTIGUOUS, TRI_COUNT * 3, selected, hovered, PALETTE))
    }
  })

  it('repaints everything when the palette moves (the body itself got selected)', () => {
    const colors = new Float32Array(TRI_COUNT * 9)
    const painter = new HighlightColorPainter(colors, CONTIGUOUS)
    painter.apply(null, flags(FACES, 2), PALETTE)

    const bodySelected: HighlightPalette = { ...PALETTE, base: [0.5, 0.25, 1] }
    const result = painter.apply(null, flags(FACES, 2), bodySelected)

    expect(result.full).toBe(true)
    expect(colors).toEqual(reference(CONTIGUOUS, TRI_COUNT * 3, null, flags(FACES, 2), bodySelected))
  })

  it('covers vertices no primitive claims, so an unmapped triangle still gets the base colour', () => {
    // A mesh whose triangle_to_face leaves the tail unmapped: the runs describe
    // fewer triangles than the buffer holds.
    const runs = faceRuns(1, () => [0])
    const colors = new Float32Array(3 * 9)
    const painter = new HighlightColorPainter(colors, runs)

    painter.apply(null, null, PALETTE)

    expect([...colors.slice(-3)]).toEqual([...PALETTE.base])
  })

  it('falls back to a full upload when a primitive is scattered into too many ranges', () => {
    // One face owning every other triangle: no two of its triangles are adjacent,
    // so each becomes its own range.
    const scattered = faceRuns(2, (f) => Array.from(
      { length: HIGHLIGHT_PAINTER_MAX_RANGES + 4 }, (_, i) => i * 2 + f))
    const colors = new Float32Array((HIGHLIGHT_PAINTER_MAX_RANGES + 4) * 2 * 9)
    const painter = new HighlightColorPainter(colors, scattered)
    painter.apply(null, null, PALETTE)

    const result = painter.apply(null, flags(2, 0), PALETTE)

    expect(result.full).toBe(true)
    expect(result.ranges).toEqual([])
    // The buffer is still correct -- only the upload got coarser.
    expect(colors).toEqual(reference(scattered, colors.length / 3, null, flags(2, 0), PALETTE))
  })

  it('reports every painted float when a later primitive lies earlier in the buffer', () => {
    // Face 0 owns the LAST triangles and face 1 the first, so the second
    // primitive the apply loop repaints starts before the first one. The ranges
    // must still cover both: a range list that merged backwards would leave
    // face 1's floats written on the CPU but never uploaded, and the primitive
    // would keep its old colour on screen.
    const reversed = faceRuns(2, (f) => (f === 0 ? [2, 3] : [0, 1]))
    const colors = new Float32Array(4 * 9)
    const painter = new HighlightColorPainter(colors, reversed)
    painter.apply(null, null, PALETTE)  // first apply is `full`

    const result = painter.apply(flags(2, 0, 1), null, PALETTE)

    expect(result.full).toBe(false)
    expect(result.repainted).toBe(2)
    expect(paintedFloats(result)).toBe(colors.length)
    // Every float actually written lands inside a reported range.
    const covered = new Set<number>()
    for (const r of result.ranges) for (let f = r.start; f < r.start + r.count; f++) covered.add(f)
    for (let f = 0; f < colors.length; f++) expect(covered.has(f)).toBe(true)
  })
})

describe('primitive layouts', () => {
  it('triangleRuns gives each triangle its own three vertices', () => {
    const runs = triangleRuns(3)
    expect(collect(runs, 0)).toEqual([[0, 3]])
    expect(collect(runs, 2)).toEqual([[6, 3]])
  })

  it('faceRuns merges consecutive triangles and splits at a gap', () => {
    const runs = faceRuns(1, () => [4, 5, 6, 9])
    expect(collect(runs, 0)).toEqual([[12, 9], [27, 3]])
  })

  it('faceRuns emits nothing for a face with no triangles', () => {
    expect(collect(faceRuns(2, () => []), 0)).toEqual([])
    expect(collect(faceRuns(2, () => undefined), 1)).toEqual([])
  })

  it('edgeRuns maps each edge to its segments, two vertices per segment', () => {
    const runs = edgeRuns([2, 0, 3])
    expect(runs.count).toBe(3)
    expect(collect(runs, 0)).toEqual([[0, 4]])
    expect(collect(runs, 1)).toEqual([])
    expect(collect(runs, 2)).toEqual([[4, 6]])
  })

  it('edgeRuns offsets stay inside a buffer sized from the same counts', () => {
    const counts = [1, 0, 0, 64, 2]  // includes skipped (0) edges
    const runs = edgeRuns(counts)
    const totalSegments = counts.reduce((a, b) => a + b, 0)
    const bufferFloats = totalSegments * 6
    for (let i = 0; i < runs.count; i++) {
      runs.eachRun(i, (vertexStart, vertexCount) => {
        expect((vertexStart + vertexCount) * 3).toBeLessThanOrEqual(bufferFloats)
      })
    }
  })
})

describe('uploadPaint', () => {
  it('uploads only the painted ranges', () => {
    const attribute = fakeAttribute()
    uploadPaint(attribute, { ranges: [{ start: 9, count: 18 }], full: false, repainted: 1 })
    expect(attribute.added).toEqual([[9, 18]])
    expect(attribute.needsUpdate).toBe(true)
    expect(attribute.cleared).toBe(0)
  })

  it('queues one buffer-covering range on a full result so three.js re-uploads everything', () => {
    const attribute = fakeAttribute()
    uploadPaint(attribute, { ranges: [], full: true, repainted: 8 })
    expect(attribute.cleared).toBe(1)
    expect(attribute.added).toEqual([[0, 36]])
    expect(attribute.needsUpdate).toBe(true)
  })

  it('leaves the attribute alone when nothing was repainted', () => {
    const attribute = fakeAttribute()
    uploadPaint(attribute, { ranges: [], full: false, repainted: 0 })
    expect(attribute.needsUpdate).toBe(false)
    expect(attribute.cleared).toBe(0)
  })

  it('a full result then a partial one before the renderer reads keeps the full-buffer range', () => {
    const attribute = fakeAttribute()
    uploadPaint(attribute, { ranges: [], full: true, repainted: 8 })
    uploadPaint(attribute, { ranges: [{ start: 9, count: 9 }], full: false, repainted: 1 })
    // The full-buffer range is still queued alongside the partial one, so three.js
    // uploads the whole buffer, not just floats 9..17.
    const covered = new Set<number>()
    for (const [start, count] of attribute.added) for (let f = start; f < start + count; f++) covered.add(f)
    for (let f = 0; f < attribute.array.length; f++) expect(covered.has(f)).toBe(true)
    expect(attribute.needsUpdate).toBe(true)
  })
})

function collect(runs: PrimitiveRuns, index: number): number[][] {
  const out: number[][] = []
  runs.eachRun(index, (start, count) => out.push([start, count]))
  return out
}

interface FakeAttribute extends UpdatableAttribute {
  added: number[][]
  cleared: number
}

function fakeAttribute(): FakeAttribute {
  return {
    needsUpdate: false,
    array: { length: 36 },
    added: [],
    cleared: 0,
    clearUpdateRanges() { this.cleared++; this.added = [] },
    addUpdateRange(start: number, count: number) { this.added.push([start, count]) },
  }
}
