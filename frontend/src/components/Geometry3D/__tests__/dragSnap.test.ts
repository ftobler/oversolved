import { describe, it, expect } from 'vitest'
import type { Sketch } from '../../../types/cad'
import { findSnapTarget, collectSnapTargets } from '../Dragging'

const FEATURE = 'S1'

const makeSketch = (): Sketch => ({
  L1: { start: [0, 0], end: [10, 0] } as Sketch[string],
  L2: { start: [10, 0], end: [10, 10] } as Sketch[string],
  C1: { center: [5, 5], radius: 3 } as Sketch[string],
  PT1: { x: 2, y: 3 } as Sketch[string],
  // Arc: has start, end, center, radius, angle_start, angle_end
  A1: { center: [0, 5], radius: 4, start: [-4, 5], end: [0, 9], angle_start: 180, angle_end: 90 } as Sketch[string],
  'projL': { start: [20, 20], end: [30, 30], projected: true, source: '@S2/L1' } as Sketch[string],  // projected — skip
})

describe('collectSnapTargets', () => {
  it('collects line start and end', () => {
    const sketch = makeSketch()
    const targets = collectSnapTargets(sketch, FEATURE, '__none__')
    const ids = targets.map(t => t.vertexId)
    expect(ids).toContain('vertex:S1:L1:start')
    expect(ids).toContain('vertex:S1:L1:end')
  })

  it('collects circle center', () => {
    const targets = collectSnapTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.map(t => t.vertexId)).toContain('vertex:S1:C1:center')
  })

  it('collects point xy', () => {
    const targets = collectSnapTargets(makeSketch(), FEATURE, '__none__')
    const pt = targets.find(t => t.vertexId === 'vertex:S1:PT1:xy')
    expect(pt).toBeDefined()
    expect(pt!.position).toEqual([2, 3])
  })

  it('collects arc start, end, and center', () => {
    const targets = collectSnapTargets(makeSketch(), FEATURE, '__none__')
    const ids = targets.map(t => t.vertexId)
    expect(ids).toContain('vertex:S1:A1:start')
    expect(ids).toContain('vertex:S1:A1:end')
    expect(ids).toContain('vertex:S1:A1:center')
  })

  it('skips projected entities (projected: true)', () => {
    const targets = collectSnapTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.some(t => t.vertexId.includes('projL'))).toBe(false)
  })

  it('skips the dragged entity', () => {
    const targets = collectSnapTargets(makeSketch(), FEATURE, 'L1')
    expect(targets.some(t => t.vertexId.includes(':L1:'))).toBe(false)
  })
})

describe('findSnapTarget', () => {
  it('returns null when no vertex is within threshold', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 100, 100, 1)
    expect(result).toBeNull()
  })

  it('returns nearest vertex within threshold', () => {
    // L1 start is at [0, 0]; search near it
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 0.5, 0.1, 2)
    expect(result).not.toBeNull()
    expect(result!.vertexId).toBe('vertex:S1:L1:start')
  })

  it('skips the dragged entity own vertices', () => {
    // L1 start is at [0,0], we are dragging L1 and searching near [0,0]
    const result = findSnapTarget(makeSketch(), FEATURE, 'L1', 0, 0, 2)
    // Should not snap to L1:start or L1:end; nearest other vertex is L2:start at [10,0]
    expect(result).toBeNull()  // no other vertex is within threshold=2 of [0,0]
  })

  it('returns closest vertex when multiple are within threshold', () => {
    // L1 end is at [10, 0]; L2 start is also at [10, 0] — both are identical position
    // Search from [10, 0.1] — both within threshold, should return one of them
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 10, 0.1, 2)
    expect(result).not.toBeNull()
    expect(['vertex:S1:L1:end', 'vertex:S1:L2:start']).toContain(result!.vertexId)
  })

  it('returns null when only the dragged entity vertex matches', () => {
    // Search near L2 end [10, 10], but skip L2
    const result = findSnapTarget(makeSketch(), FEATURE, 'L2', 10, 10, 0.5)
    expect(result).toBeNull()
  })

  it('handles point entity', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 2.1, 3.1, 0.5)
    expect(result).not.toBeNull()
    expect(result!.vertexId).toBe('vertex:S1:PT1:xy')
    expect(result!.position).toEqual([2, 3])
  })

  it('handles circle center', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 5.1, 5.1, 0.5)
    expect(result).not.toBeNull()
    expect(result!.vertexId).toBe('vertex:S1:C1:center')
  })
})
