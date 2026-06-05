// Always-on unit tests for the pure loop-classification helpers added for the
// extrude leaf (phase 2f): loopSignedArea, pointInLoop, classifyLoops. No OCC.

import { describe, it, expect } from 'vitest'
import { loopSignedArea, pointInLoop, classifyLoops, type LoopEdge } from './profileLoops'

const square = (s: number): LoopEdge[] => [
  { kind: 'line', start: [0, 0], end: [s, 0] },
  { kind: 'line', start: [s, 0], end: [s, s] },
  { kind: 'line', start: [s, s], end: [0, s] },
  { kind: 'line', start: [0, s], end: [0, 0] },
]

// A small square centered at (cx, cy) with half-size h.
const box = (cx: number, cy: number, h: number): LoopEdge[] => [
  { kind: 'line', start: [cx - h, cy - h], end: [cx + h, cy - h] },
  { kind: 'line', start: [cx + h, cy - h], end: [cx + h, cy + h] },
  { kind: 'line', start: [cx + h, cy + h], end: [cx - h, cy + h] },
  { kind: 'line', start: [cx - h, cy + h], end: [cx - h, cy - h] },
]

describe('loopSignedArea', () => {
  it('is positive (CCW) and equals the area for a square', () => {
    expect(loopSignedArea(square(10))).toBeCloseTo(100, 9)
  })
  it('flips sign for a reversed (CW) loop', () => {
    expect(loopSignedArea([...square(10)].reverse().map((e) => ({
      kind: 'line',
      start: e.end,
      end: e.start,
    })))).toBeCloseTo(-100, 9)
  })
})

describe('pointInLoop', () => {
  it('detects interior and exterior points', () => {
    const s = square(10)
    expect(pointInLoop([5, 5], s)).toBe(true)
    expect(pointInLoop([15, 5], s)).toBe(false)
    expect(pointInLoop([-1, 5], s)).toBe(false)
  })
})

describe('classifyLoops', () => {
  it('returns a single outer with no holes', () => {
    const groups = classifyLoops([square(10)])
    expect(groups).toHaveLength(1)
    expect(groups[0][1]).toHaveLength(0)
  })

  it('nests a contained loop as a hole of the smallest enclosing outer', () => {
    const outer = square(20)
    const hole = box(10, 10, 2)
    const groups = classifyLoops([outer, hole])
    expect(groups).toHaveLength(1)
    const [o, holes] = groups[0]
    expect(o).toBe(outer)
    expect(holes).toEqual([hole])
  })

  it('keeps disjoint loops as independent outers', () => {
    const a = box(5, 5, 2)
    const b = box(50, 50, 2)
    const groups = classifyLoops([a, b])
    expect(groups).toHaveLength(2)
    expect(groups.every(([, holes]) => holes.length === 0)).toBe(true)
  })
})
