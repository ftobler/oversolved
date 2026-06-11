// @vitest-environment node
//
// Real-solver regression for the n-gon / offset sugar lowering. The sugar
// `ngon` and `offset` constraints are expanded (partDocToSketches) into
// primitive constraints, lowered (lowerSketch) and handed to the actual Rust
// solver. These assertions check the solved geometry is what the sugar promises:
// a regular polygon, and a true parallel / concentric offset.
//
// Skips when the Rust solver build is absent.

import { describe, it, expect } from 'vitest'
import type { PartDoc } from '@/types/cad'
import { loadSolver } from './loadSolver'
import { lowerSketch } from './lowerSketch'
import { encodeInput, decodeOutput } from './codec'
import { partDocToSketches } from './partDocToSketches'
import { applyAddNgon, applyAddOffset, applyAddEntity, applyDeleteElements } from '@/utils/yamlMutations'

const bytes = loadSolver()

function solveFeature(doc: PartDoc): Record<string, number[]> {
  const { sketches, skipped } = partDocToSketches(doc.features)
  expect(skipped).toHaveLength(0)
  expect(sketches).toHaveLength(1)
  const { input, layout } = lowerSketch(sketches[0].sketch as never)
  const out = decodeOutput(bytes!(encodeInput(input)))
  const solved: Record<string, number[]> = {}
  for (const l of layout) solved[l.id] = out.paramsSolved.slice(l.offset, l.offset + l.size)
  return solved
}

function emptySketch(): PartDoc {
  return { features: [{ id: 'sk', kind: 'sketch', plane: '@builtin_plane_front', entities: [], initial: {}, constraints: [] }] }
}

function lineLen(p: number[]): number {
  return Math.hypot(p[2] - p[0], p[3] - p[1])
}

// Signed perpendicular distance from line `a` to point `b.start`, matching the
// solver's line_distance residual. Gauge-invariant (independent of how the free
// source line drifted/rotated), so it is the honest thing to assert for offsets.
function perpDistance(a: number[], bStart: [number, number]): number {
  const dx = a[2] - a[0], dy = a[3] - a[1]
  const n = Math.hypot(dx, dy)
  const nx = -dy / n, ny = dx / n
  return (bStart[0] - a[0]) * nx + (bStart[1] - a[1]) * ny
}

function cross(a: number[], b: number[]): number {
  return (a[2] - a[0]) * (b[3] - b[1]) - (a[3] - a[1]) * (b[2] - b[0])
}

describe.skipIf(!bytes)('n-gon sugar solves to a regular polygon', () => {
  for (const sides of [3, 4, 6, 8]) {
    it(`sides=${sides}: equal side lengths and vertices equidistant from centroid`, () => {
      const doc = emptySketch()
      // Draw centered at origin with the first vertex at (10, 0).
      applyAddNgon(doc, 'sk', [0, 0], [10, 0], sides)

      const lineIds = doc.features![0].entities!.map((e) => e.id)
      expect(lineIds).toHaveLength(sides)

      const solved = solveFeature(doc)
      const params = lineIds.map((id) => solved[id])

      // All sides equal length.
      const lens = params.map(lineLen)
      const len0 = lens[0]
      expect(len0).toBeGreaterThan(1)
      for (const l of lens) expect(Math.abs(l - len0)).toBeLessThan(1e-2)

      // Vertices (line starts) equidistant from their centroid -> regular.
      const verts = params.map((p) => [p[0], p[1]] as [number, number])
      const cx = verts.reduce((s, v) => s + v[0], 0) / sides
      const cy = verts.reduce((s, v) => s + v[1], 0) / sides
      const radii = verts.map((v) => Math.hypot(v[0] - cx, v[1] - cy))
      const r0 = radii[0]
      expect(r0).toBeGreaterThan(1)
      for (const r of radii) expect(Math.abs(r - r0)).toBeLessThan(1e-2)

      // Closed chain: each line's end coincides with the next line's start.
      for (let i = 0; i < sides; i++) {
        const end = [params[i][2], params[i][3]]
        const nextStart = [params[(i + 1) % sides][0], params[(i + 1) % sides][1]]
        expect(Math.hypot(end[0] - nextStart[0], end[1] - nextStart[1])).toBeLessThan(1e-2)
      }
    })
  }

  it('breaking the n-gon (deleting the ngon constraint) leaves the line chain intact', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 5)
    const feat = doc.features![0]
    const ngon = feat.constraints!.find((c) => c.kind === 'ngon')!
    expect(ngon).toBeTruthy()

    applyDeleteElements(doc, [`constraint:sk:${ngon.id}`])
    expect(feat.constraints!.some((c) => c.kind === 'ngon')).toBe(false)
    // 5 lines + 5 coincident constraints remain; the polygon is now irregular-editable.
    expect(feat.entities!.filter((e) => e.kind === 'line')).toHaveLength(5)
    expect(feat.constraints!.filter((c) => c.kind === 'coincident')).toHaveLength(5)
  })

  it('deleting one member line garbage-collects the ngon constraint', () => {
    const doc = emptySketch()
    applyAddNgon(doc, 'sk', [0, 0], [10, 0], 6)
    const feat = doc.features![0]
    const victim = feat.entities![0].id
    applyDeleteElements(doc, [`entity:sk:${victim}`])
    expect(feat.constraints!.some((c) => c.kind === 'ngon')).toBe(false)
  })
})

describe.skipIf(!bytes)('offset sugar solves to a true offset', () => {
  // The source line is unpinned here, so the offset's translation gauge is free
  // (source drifts down, copy up); the meaningful quantity is the perpendicular
  // separation between the two solved lines, on the correct side.
  it('line offset is parallel at the signed perpendicular distance', () => {
    const doc = emptySketch()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], 5)
    const dstId = doc.features![0].entities!.find((e) => e.id !== 'src')!.id

    const solved = solveFeature(doc)
    const src = solved['src']
    const dst = solved[dstId]
    expect(Math.abs(cross(src, dst))).toBeLessThan(1e-1)         // parallel
    expect(perpDistance(src, [dst[0], dst[1]])).toBeCloseTo(5, 2)  // +5 on the +normal side
  })

  it('negative line offset lands on the other side', () => {
    const doc = emptySketch()
    applyAddEntity(doc, 'sk', 'line', [0, 0, 10, 0], 'src')
    applyAddOffset(doc, 'sk', ['src'], -4)
    const dstId = doc.features![0].entities!.find((e) => e.id !== 'src')!.id
    const solved = solveFeature(doc)
    expect(perpDistance(solved['src'], [solved[dstId][0], solved[dstId][1]])).toBeCloseTo(-4, 2)
  })

  it('circle offset is concentric with the offset radius', () => {
    const doc = emptySketch()
    applyAddEntity(doc, 'sk', 'circle', [0, 0, 5], 'src')
    applyAddOffset(doc, 'sk', ['src'], 3)
    const dstId = doc.features![0].entities!.find((e) => e.id !== 'src')!.id
    const dst = solveFeature(doc)[dstId]
    expect(Math.hypot(dst[0], dst[1])).toBeLessThan(1e-2)  // concentric at origin
    expect(Math.abs(dst[2] - 8)).toBeLessThan(1e-2)        // r = 5 + 3
  })

  it('arc offset is concentric with the offset radius', () => {
    const doc = emptySketch()
    applyAddEntity(doc, 'sk', 'arc', [0, 0, 5, 0, Math.PI], 'src')
    applyAddOffset(doc, 'sk', ['src'], 2)
    const dstId = doc.features![0].entities!.find((e) => e.id !== 'src')!.id
    const dst = solveFeature(doc)[dstId]
    expect(Math.abs(dst[2] - 7)).toBeLessThan(1e-2)
  })
})
