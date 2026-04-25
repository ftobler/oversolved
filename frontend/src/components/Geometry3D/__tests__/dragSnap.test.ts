import { describe, it, expect } from 'vitest'
import type { Sketch } from '../../../types/cad'
import { findSnapTarget, collectVertexTargets } from '../snapDetection'

// Use different vertex vs entity thresholds matching the actual pull zones.
const V_THRESH = 2.0
const E_THRESH = 0.8

// Dragging a vertex handle
const DRAG_TYPE = 'vertex'

const FEATURE = 'S1'

const makeSketch = (): Sketch => ({
  L1: { start: [0, 0], end: [10, 0] } as Sketch[string],
  L2: { start: [10, 0], end: [10, 10] } as Sketch[string],
  C1: { center: [5, 5], radius: 3 } as Sketch[string],
  PT1: { x: 2, y: 3 } as Sketch[string],
  A1: { center: [0, 5], radius: 4, start: [-4, 5], end: [0, 9], angle_start: 180, angle_end: 90 } as Sketch[string],
  projL: { start: [20, 20], end: [30, 30], projected: true, source: '@S2/L1' } as Sketch[string],
})

describe('collectVertexTargets', () => {
  it('collects line start and end with vertex snap kind', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const start = targets.find(t => t.vertexId === 'vertex:S1:L1:start')
    expect(start?.snapKind).toBe('vertex')
    expect(start?.position).toEqual([0, 0])
  })

  it('collects circle center with vertex snap kind (broad category)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const c = targets.find(t => t.vertexId === 'vertex:S1:C1:center')
    expect(c?.snapKind).toBe('vertex')
  })

  it('collects arc center with vertex snap kind (broad category)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const c = targets.find(t => t.vertexId === 'vertex:S1:A1:center')
    expect(c?.snapKind).toBe('vertex')
  })

  it('collects point with vertex snap kind', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const pt = targets.find(t => t.vertexId === 'vertex:S1:PT1:xy')
    expect(pt?.snapKind).toBe('vertex')
  })

  it('includes projected entities (they are valid snap targets)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.some(t => t.vertexId?.includes('projL'))).toBe(true)
  })

  it('skips the dragged entity', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, 'L1')
    expect(targets.some(t => t.vertexId?.includes(':L1:'))).toBe(false)
  })

  it('includes vertices from otherSketches with their own featureId prefix', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [100, 100], end: [200, 100] } as Sketch[string] },
    }
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__', other)
    expect(targets.some(t => t.vertexId === 'vertex:S2:OL1:start')).toBe(true)
    expect(targets.some(t => t.vertexId === 'vertex:S2:OL1:end')).toBe(true)
  })

  it('does not apply skipEntityId to other sketches', () => {
    const other: Record<string, Sketch> = {
      S2: { L1: { start: [100, 100], end: [200, 100] } as Sketch[string] },
    }
    // skipEntityId 'L1' only filters the active sketch; S2:L1 must still appear
    const targets = collectVertexTargets(makeSketch(), FEATURE, 'L1', other)
    expect(targets.some(t => t.vertexId === 'vertex:S2:L1:start')).toBe(true)
  })
})

describe('findSnapTarget — vertex snap', () => {
  it('returns null when no vertex or entity within threshold', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 100, 100, 0.1, 0.04)
    expect(result).toBeNull()
  })

  it('returns nearest vertex with constraintKind from registry', () => {
    // line.start snapping to another line vertex → coincident
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 0.5, 0.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:L1:start')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('circle.center dragged near another circle.center → coincident', () => {
    // drag circle center near C1.center [5,5]
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 5.1, 5.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('skips the dragged entity own vertices', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, 'L1', DRAG_TYPE, 0, 0, 0.5, 0.2)
    expect(result).toBeNull()
  })

  it('returns closest vertex when multiple within threshold', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 10, 0.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(['vertex:S1:L1:end', 'vertex:S1:L2:start']).toContain(result?.vertexId)
  })
})

describe('findSnapTarget — projected entities and other sketches', () => {
  it('snaps to projected entity vertex in the active sketch', () => {
    // projL has start: [20, 20] — cursor placed right on top of it
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 20, 20, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:projL:start')
  })

  it('snaps to vertex in another sketch with correct cross-sketch vertexId', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [50, 50], end: [60, 50] } as Sketch[string] },
    }
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 50, 50, V_THRESH, E_THRESH, other)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S2:OL1:start')
  })

  it('prefers nearer candidate across sketch boundary', () => {
    // Active sketch: L1.start at [0, 0]; other sketch: vertex at [0.3, 0]
    // Cursor at [0.4, 0] — other sketch vertex is closer
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [0.3, 0], end: [10, 0] } as Sketch[string] },
    }
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 0.4, 0, V_THRESH, E_THRESH, other)
    expect(result?.vertexId).toBe('vertex:S2:OL1:start')
  })

  it('entity snap works for entity bodies in other sketches', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [40, 40], end: [50, 40] } as Sketch[string] },
    }
    // Cursor at [45, 40.3]: within E_THRESH of OL1 body, no vertices within V_THRESH
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 45, 40.3, V_THRESH, E_THRESH, other)
    expect(result?.kind).toBe('entity')
    expect(result?.entityRef).toBe('entity:S2:OL1')
  })
})

describe('findSnapTarget — entity snap (path fallback)', () => {
  it('returns entity snap with constraintKind from registry', () => {
    // line.start near middle of L1 body → coincident from registry for path snap
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 5, 0.5, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('entity')
    expect(result?.entityRef).toBe('entity:S1:L1')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('vertex snap wins over entity snap when near an endpoint', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 0.5, 0.3, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
  })

  it('entity snap position is nearest point on entity body', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 5, 0.5, V_THRESH, E_THRESH)
    expect(result?.position[0]).toBeCloseTo(5)
    expect(result?.position[1]).toBeCloseTo(0)
  })

  it('returns null when cursor is off all entities and no vertex nearby', () => {
    const result = findSnapTarget(makeSketch(), FEATURE, '__none__', DRAG_TYPE, 50, 50, V_THRESH, E_THRESH)
    expect(result).toBeNull()
  })
})