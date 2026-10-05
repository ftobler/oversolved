import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { findSnapTarget, sketchToVertexCandidates, sketchToEntityCandidates, collectVertexTargetsFlat, collectEntityCandidatesFlat } from '@/components/Geometry3D/snapDetection'

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
  SP1: { p1: [500, 500], p2: [510, 500], p3: [520, 510], p4: [530, 500] } as Sketch[string],
})

// Local fixtures: the retired snapDetection wrappers, kept here because these
// findSnapTarget cases only ever used them to build candidate lists.
function vertexFixture(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): ReturnType<typeof sketchToVertexCandidates> {
  const skip = skipEntityId === '__none__'
    ? new Set<string>() : new Set([`${featureId}:${skipEntityId}`])
  const out = collectVertexTargetsFlat(
    sketchToVertexCandidates(sketch, featureId, 'active_sketch'), skip)
  for (const [f, s] of Object.entries(otherSketches ?? {})) {
    out.push(...sketchToVertexCandidates(s, f, 'other_sketch'))
  }
  return out
}

function entityFixture(
  sketch: Sketch,
  featureId: string,
  skipEntityId: string,
  otherSketches?: Record<string, Sketch>,
): ReturnType<typeof sketchToEntityCandidates> {
  const skip = skipEntityId === '__none__'
    ? new Set<string>() : new Set([`${featureId}:${skipEntityId}`])
  const out = collectEntityCandidatesFlat(
    sketchToEntityCandidates(sketch, featureId, 'active_sketch'), skip)
  for (const [f, s] of Object.entries(otherSketches ?? {})) {
    out.push(...sketchToEntityCandidates(s, f, 'other_sketch'))
  }
  return out
}

describe('sketchToVertexCandidates and collectVertexTargetsFlat', () => {
  it('sketchToVertexCandidates collects vertices from sketch', () => {
    const candidates = sketchToVertexCandidates(makeSketch(), FEATURE, 'active_sketch')
    expect(candidates.some(t => t.id === 'vertex:S1:L1:start')).toBe(true)
    expect(candidates.some(t => t.id === 'vertex:S1:C1:center')).toBe(true)
  })

  it('emits the spline endpoints and control points at their solved positions', () => {
    const candidates = sketchToVertexCandidates(makeSketch(), FEATURE, 'active_sketch')
    const at = (id: string) => candidates.find(t => t.id === id)?.position
    expect(at('vertex:S1:SP1:start')).toEqual([500, 500])
    expect(at('vertex:S1:SP1:c1')).toEqual([510, 500])
    expect(at('vertex:S1:SP1:c2')).toEqual([520, 510])
    expect(at('vertex:S1:SP1:end')).toEqual([530, 500])
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

describe('findSnapTarget -- vertex snap', () => {
  it('returns null when no vertex or entity within threshold', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 100, 100, 0.1, 0.04)
    expect(result).toBeNull()
  })

  it('returns nearest vertex with constraintKind from registry', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0.5, 0.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:L1:start')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('circle.center dragged near another circle.center → coincident', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 5.1, 5.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('skips the dragged entity own vertices', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, 'L1')
    const entityCands = entityFixture(sketch, FEATURE, 'L1')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0, 0, 0.5, 0.2)
    expect(result).toBeNull()
  })

  it('returns closest vertex when multiple within threshold', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 10, 0.1, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(['vertex:S1:L1:end', 'vertex:S1:L2:start']).toContain(result?.vertexId)
  })

  it('snaps onto a spline end vertex', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 530, 500, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:SP1:end')
  })
})

describe('findSnapTarget -- projected entities and other sketches', () => {
  it('snaps to projected entity vertex in the active sketch', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 20, 20, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S1:projL:start')
  })

  it('snaps to vertex in another sketch with correct cross-sketch vertexId', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [50, 50], end: [60, 50] } as Sketch[string] },
    }
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__', other)
    const entityCands = entityFixture(sketch, FEATURE, '__none__', other)
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 50, 50, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
    expect(result?.vertexId).toBe('vertex:S2:OL1:start')
  })

  it('prefers nearer candidate across sketch boundary', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [0.3, 0], end: [10, 0] } as Sketch[string] },
    }
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__', other)
    const entityCands = entityFixture(sketch, FEATURE, '__none__', other)
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0.4, 0, V_THRESH, E_THRESH)
    expect(result?.vertexId).toBe('vertex:S2:OL1:start')
  })

  it('entity snap works for entity bodies in other sketches', () => {
    const other: Record<string, Sketch> = {
      S2: { OL1: { start: [40, 40], end: [50, 40] } as Sketch[string] },
    }
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__', other)
    const entityCands = entityFixture(sketch, FEATURE, '__none__', other)
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 45, 40.3, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('entity')
    expect(result?.entityRef).toBe('entity:S2:OL1')
  })
})

describe('findSnapTarget -- entity snap (path fallback)', () => {
  it('returns entity snap with constraintKind from registry', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 5, 0.5, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('entity')
    expect(result?.entityRef).toBe('entity:S1:L1')
    expect(result?.constraintKind).toBe('coincident')
  })

  it('vertex snap wins over entity snap when near an endpoint', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 0.5, 0.3, V_THRESH, E_THRESH)
    expect(result?.kind).toBe('vertex')
  })

  it('entity snap position is nearest point on entity body', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 5, 0.5, V_THRESH, E_THRESH)
    expect(result?.position[0]).toBeCloseTo(5)
    expect(result?.position[1]).toBeCloseTo(0)
  })

  it('returns null when cursor is off all entities and no vertex nearby', () => {
    const sketch = makeSketch()
    const vertexCands = vertexFixture(sketch, FEATURE, '__none__')
    const entityCands = entityFixture(sketch, FEATURE, '__none__')
    const result = findSnapTarget(vertexCands, entityCands, DRAG_TYPE, 50, 50, V_THRESH, E_THRESH)
    expect(result).toBeNull()
  })
})