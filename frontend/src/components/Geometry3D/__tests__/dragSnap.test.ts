import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { findSnapTarget, collectVertexTargets, collectEntityCandidates, sketchToVertexCandidates, sketchToEntityCandidates, collectVertexTargetsFlat, collectEntityCandidatesFlat } from '@/components/Geometry3D/snapDetection'

const V_THRESH = 2.0
const E_THRESH = 0.8

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
    const start = targets.find(t => t.id === 'vertex:S1:L1:start')
    expect(start?.kind).toBe('vertex')
    expect(start?.position).toEqual([0, 0])
  })

  it('collects circle center with vertex snap kind (broad category)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const c = targets.find(t => t.id === 'vertex:S1:C1:center')
    expect(c?.kind).toBe('vertex')
  })

  it('collects arc center with vertex snap kind (broad category)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const c = targets.find(t => t.id === 'vertex:S1:A1:center')
    expect(c?.kind).toBe('vertex')
  })

  it('collects point with vertex snap kind', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    const pt = targets.find(t => t.id === 'vertex:S1:PT1:xy')
    expect(pt?.kind).toBe('vertex')
  })

  it('includes projected entities (they are valid snap targets)', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__')
    expect(targets.some(t => t.id.includes('projL'))).toBe(true)
  })

  it('skips the dragged entity', () => {
    const targets = collectVertexTargets(makeSketch(), FEATURE, 'L1')
    expect(targets.some(t => t.id.includes(':L1:'))).toBe(false)
  })

  it('includes vertices from otherSketches with their own featureId prefix', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [100, 100], end: [200, 100] } as Sketch[string] },
    }
    const targets = collectVertexTargets(makeSketch(), FEATURE, '__none__', other)
    expect(targets.some(t => t.id === 'vertex:S2:OL1:start')).toBe(true)
    expect(targets.some(t => t.id === 'vertex:S2:OL1:end')).toBe(true)
  })

  it('does not apply skipEntityId to other sketches', () => {
    const other: Record<string, Sketch> = {
      S2: { L1: { start: [100, 100], end: [200, 100] } as Sketch[string] },
    }
    const targets = collectVertexTargets(makeSketch(), FEATURE, 'L1', other)
    expect(targets.some(t => t.id === 'vertex:S2:L1:start')).toBe(true)
  })
})

describe('sketchToVertexCandidates and collectVertexTargetsFlat', () => {
  it('sketchToVertexCandidates collects vertices from sketch', () => {
    const candidates = sketchToVertexCandidates(makeSketch(), FEATURE, 'active_sketch')
    expect(candidates.some(t => t.id === 'vertex:S1:L1:start')).toBe(true)
    expect(candidates.some(t => t.id === 'vertex:S1:C1:center')).toBe(true)
  })

  it('collectVertexTargetsFlat skips entities in skipIds', () => {
    const candidates = sketchToVertexCandidates(makeSketch(), FEATURE, 'active_sketch')
    const skipIds = new Set(['L1'])
    const filtered = collectVertexTargetsFlat(candidates, skipIds)
    expect(filtered.some(t => t.id.includes(':L1:'))).toBe(false)
    expect(filtered.some(t => t.id.includes(':L2:'))).toBe(true)
  })

  it('collectVertexTargetsFlat returns all when skipIds is empty', () => {
    const candidates = sketchToVertexCandidates(makeSketch(), FEATURE, 'active_sketch')
    const skipIds = new Set<string>()
    const filtered = collectVertexTargetsFlat(candidates, skipIds)
    expect(filtered.length).toBe(candidates.length)
  })
})

describe('sketchToEntityCandidates and collectEntityCandidatesFlat', () => {
  it('sketchToEntityCandidates collects entities from sketch', () => {
    const candidates = sketchToEntityCandidates(makeSketch(), FEATURE, 'active_sketch')
    expect(candidates.some(t => t.id === 'entity:S1:L1')).toBe(true)
    expect(candidates.some(t => t.id === 'entity:S1:C1')).toBe(true)
  })

  it('collectEntityCandidatesFlat skips entities in skipIds', () => {
    const candidates = sketchToEntityCandidates(makeSketch(), FEATURE, 'active_sketch')
    const skipIds = new Set([`${FEATURE}:L1`])
    const filtered = collectEntityCandidatesFlat(candidates, skipIds)
    expect(filtered.some(t => t.id === 'entity:S1:L1')).toBe(false)
    expect(filtered.some(t => t.id === 'entity:S1:L2')).toBe(true)
  })
})

describe('findSnapTarget  -  vertex snap', () => {
  it('returns null when no vertex or entity within threshold', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 100, 100, 0.1, 0.04)
    expect(result).toBeNull()
  })

  it('returns nearest vertex with constraintKind from registry', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0.5, 0.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:L1:start')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('circle.center dragged near another circle.center → coincident', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 5.1, 5.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('skips the dragged entity own vertices', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, 'L1')
    const entityCands = collectEntityCandidates(sketch, FEATURE, 'L1')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0, 0, 0.5, 0.2)
    expect(result).toBeNull()
  })

  it('returns closest vertex when multiple within threshold', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 10, 0.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(['vertex:S1:L1:end', 'vertex:S1:L2:start']).toContain(result?.vertexId)
  })
})

describe('findSnapTarget  -  projected entities and other sketches', () => {
  it('snaps to projected entity vertex in the active sketch', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 20, 20, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:projL:start')
  })

  it('snaps to vertex in another sketch with correct cross-sketch vertexId', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [50, 50], end: [60, 50] } as Sketch[string] },
    }
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__', other)
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__', other)
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 50, 50, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S2:OL1:start')
  })

  it('prefers nearer candidate across sketch boundary', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [0.3, 0], end: [10, 0] } as Sketch[string] },
    }
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__', other)
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__', other)
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0.4, 0, V_THRESH, E_THRESH)
    expect(result?.vertexId).toBe('vertex:S2:OL1:start')
  })

  it('entity snap works for entity bodies in other sketches', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [40, 40], end: [50, 40] } as Sketch[string] },
    }
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__', other)
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__', other)
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 45, 40.3, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('entity')
    expect(result?.entityRef).toBe('entity:S2:OL1')
  })
})

describe('findSnapTarget  -  entity snap (path fallback)', () => {
  it('returns entity snap with constraintKind from registry', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 5, 0.5, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('entity')
    expect(result?.entityRef).toBe('entity:S1:L1')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('vertex snap wins over entity snap when near an endpoint', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0.5, 0.3, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
  })

  it('entity snap position is nearest point on entity body', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 5, 0.5, V_THRESH, E_THRESH)
    expect(result?.position[0]).toBeCloseTo(5)
    expect(result?.position[1]).toBeCloseTo(0)
  })

  it('returns null when cursor is off all entities and no vertex nearby', () => {
    const sketch = makeSketch()
    const vertexCands = collectVertexTargets(sketch, FEATURE, '__none__')
    const entityCands = collectEntityCandidates(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 50, 50, V_THRESH, E_THRESH)
    expect(result).toBeNull()
  })
})