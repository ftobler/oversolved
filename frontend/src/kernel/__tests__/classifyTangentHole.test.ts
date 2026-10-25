// classifyLoops on a hole whose boundary touches its container (bug-arc-profile
// D1). An r2 circle in the corner of a 20x20 square is tangent to both sides,
// so the area builder splits square and circle at the two tangent points and
// publishes three adjacent areas: the corner pocket, the rest of the square,
// and the disc. No loop contains another, and the disc must still be the hole
// it is when the circle sits clear of the sides. No OCC.

import { describe, it, expect } from 'vitest'
import { classifyLoops, loopSignedArea, type LoopEdge } from '../profileLoops'

/** A line side between two named builder vertices. */
function side(id: string, start: number[], end: number[], v0: string, v1: string): LoopEdge {
  return { kind: 'line', id, start, end, start_vertex: v0, end_vertex: v1 }
}

/** A piece of the r2 circle at (2,2), between two named builder vertices. */
function piece(a0: number, a1: number, ccw: boolean, v0: string, v1: string): LoopEdge {
  const at = (deg: number) => [2 + 2 * Math.cos((deg * Math.PI) / 180), 2 + 2 * Math.sin((deg * Math.PI) / 180)]
  return {
    kind: 'arc', id: 'hole', center: [2, 2], radius: 2,
    angle_start_deg: a0, angle_end_deg: a1, ccw,
    start: at(a0), end: at(a1), start_vertex: v0, end_vertex: v1,
  }
}

// _v4 = (2,0) and _v5 = (0,2) are the two tangent points.
const pocket: LoopEdge[] = [
  side('a', [0, 0], [2, 0], '_v0', '_v4'),
  piece(270, 180, false, '_v4', '_v5'),
  side('d', [0, 2], [0, 0], '_v5', '_v0'),
]
const rest: LoopEdge[] = [
  side('a', [2, 0], [20, 0], '_v4', '_v1'),
  side('b', [20, 0], [20, 20], '_v1', '_v2'),
  side('c', [20, 20], [0, 20], '_v2', '_v3'),
  side('d', [0, 20], [0, 2], '_v3', '_v5'),
  piece(180, 270, false, '_v5', '_v4'),
]
const disc: LoopEdge[] = [
  piece(180, 270, true, '_v5', '_v4'),
  piece(270, 180, true, '_v4', '_v5'),
]

const filled = (groups: [LoopEdge[], LoopEdge[][]][]): number =>
  groups.reduce((sum, [outer, holes]) =>
    sum + Math.abs(loopSignedArea(outer, 64)) - holes.reduce((h, l) => h + Math.abs(loopSignedArea(l, 64)), 0), 0)

describe('classifyLoops with a hole tangent to its container', () => {
  it('drops the disc whose every side is shared with a filled area', () => {
    const groups = classifyLoops([pocket, rest, disc])
    expect(groups.map(([outer]) => outer)).toEqual([pocket, rest])
    // The 64-sample chord polygon under-reads the arcs by about 0.01.
    expect(filled(groups)).toBeCloseTo(400 - 4 * Math.PI, 1)
  })

  it('drops the disc whatever the loop order', () => {
    // The rule reads the shared sides, not which loop came first.
    const groups = classifyLoops([disc, rest, pocket])
    expect(groups.map(([outer]) => outer)).toEqual([rest, pocket])
  })

  it('keeps the disc when a side of it borders no filled area', () => {
    // The pocket alone: the disc's long arc faces the open plane, so the disc
    // is an area of its own (the three-tangent-circles case), not a hole.
    const groups = classifyLoops([pocket, disc])
    expect(groups.map(([outer]) => outer)).toEqual([pocket, disc])
  })

  it('keeps a loop bounded by two entities, a union region', () => {
    // The pocket shares its arc with the disc but is bounded by the square's
    // sides too: a crossing or a lens is part of the union, never a hole.
    const groups = classifyLoops([pocket, rest, disc])
    expect(groups.some(([outer]) => outer === pocket)).toBe(true)
  })
})
