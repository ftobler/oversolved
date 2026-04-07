import { describe, it, expect } from 'vitest'
import type { Sketch } from '../../../types/cad'
import { findSnapTarget, collectVertexTargets } from '../Dragging'

const FEATURE = 'S1'

const makeSketch = (): Sketch => ({
  L1: { start: [0, 0], end: [10, 0] } as Sketch[string],
  L2: { start: [10, 0], end: [10, 10] } as Sketch[string],
  C1: { center: [5, 5], radius: 3 } as Sketch[string],
  PT1: { x: 2, y: 3 } as Sketch[string],
  // Arc: has start, end, center, radius, angle_start, angle_end
  A1: { center: [0, 5], radius: 4, start: [-4, 5], end: [0, 9], angle_start: 180, angle_end: 90 } as Sketch[string],
  projL: { start: [20, 20], end: [30, 30], projected: true, source: '@S2/L1' } as Sketch[string],  // projected — skip
})

describe('collectVertexTargets', () => {
  it('collects line start and end', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const ids = targets.map(t => t.vertexId)
    expect(ids).toContain('vertex:S1:L1:start')
    expect(ids).toContain('vertex:S1:L1:end')
  })

  it('collects circle center', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.map(t => t.vertexId)).toContain('vertex:S1:C1:center')
  })

  it('collects point xy', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const pt = targets.find(t => t.vertexId === 'vertex:S1:PT1:xy')
    expect(pt).toBeDefined()
    expect(pt!.position).toEqual([2, 3])
  })

  it('collects arc start, end, and center', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const ids = targets.map(t => t.vertexId)
    expect(ids).toContain('vertex:S1:A1:start')
    expect(ids).toContain('vertex:S1:A1:end')
    expect(ids).toContain('vertex:S1:A1:center')
  })

  it('skips projected entities (projected: true)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.some(t => t.vertexId?.includes('projL'))).toBe(false)
  })

  it('skips the dragged entity', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, 'L1')
    expect(targets.some(t => t.vertexId?.includes(':L1:'))).toBe(false)
  })

  it('all targets have kind vertex', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.every(t => t.kind === 'vertex')).toBe(true)
  })
})

describe('findSnapTarget — vertex snap', () => {
  it('returns null when no vertex is within threshold', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 100, 100, 0.1)
    expect(result).toBeNull()
  })

  it('returns nearest vertex within threshold with kind=vertex', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 0.5, 0.1, 2)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('vertex')
    expect(result!.vertexId).toBe('vertex:S1:L1:start')
  })

  it('skips the dragged entity own vertices', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, 'L1', 0, 0, 0.5)
    expect(result).toBeNull()
  })

  it('returns closest vertex when multiple are within threshold', () => {
    // L1 end and L2 start are both at [10, 0]
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 10, 0.1, 2)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('vertex')
    expect(['vertex:S1:L1:end', 'vertex:S1:L2:start']).toContain(result!.vertexId)
  })

  it('handles point entity', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 2.1, 3.1, 0.5)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('vertex')
    expect(result!.vertexId).toBe('vertex:S1:PT1:xy')
  })

  it('handles circle center', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 5.1, 5.1, 0.5)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('vertex')
    expect(result!.vertexId).toBe('vertex:S1:C1:center')
  })
})

describe('findSnapTarget — entity snap (path fallback)', () => {
  it('returns entity snap when cursor is on entity body but no vertex nearby', () => {
    // Midpoint of L1 is at [5, 0], no vertex is within threshold=0.5
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 5, 0, 0.5)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('entity')
    expect(result!.entityRef).toBe('entity:S1:L1')
    expect(result!.vertexId).toBeUndefined()
  })

  it('vertex snap takes priority over entity snap at same distance', () => {
    // L1 start is at [0, 0] — near it, vertex snap should win over entity snap
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 0.2, 0.1, 2)
    expect(result!.kind).toBe('vertex')
  })

  it('entity snap position is nearest point on entity, not cursor position', () => {
    // Cursor at [5, 1], nearest point on L1 (y=0 line) is [5, 0]
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 5, 0.3, 0.5)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe('entity')
    expect(result!.position[0]).toBeCloseTo(5)
    expect(result!.position[1]).toBeCloseTo(0)
  })

  it('returns null when cursor is off all entities and no vertex nearby', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 50, 50, 0.1)
    expect(result).toBeNull()
  })

  it('skips projected entities for entity snap', () => {
    // projL is at [20,20]–[30,30]; cursor near its midpoint [25, 25]
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', 25, 25, 1)
    // should not snap to projected entity; result is null or has a different ref
    if (result) {
      expect(result.entityRef ?? '').not.toContain('projL')
    }
  })
})
