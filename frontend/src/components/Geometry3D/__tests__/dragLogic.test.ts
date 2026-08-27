import { describe, it, expect } from 'vitest'
import type { Sketch } from '@/types/cad'
import { shouldActivateDrag, computeDragMove, computeDragMutation } from '@/components/Geometry3D/dragLogic'
import { sketchToVertexCandidates, sketchToEntityCandidates } from '@/components/Geometry3D/snapDetection'
import { CLICK_THRESHOLD_PX } from '@/components/Geometry3D/pointerAbstraction'

const FEATURE = 'S1'

const makeSketch = (): Sketch => ({
  L1: { start: [0, 0], end: [10, 0] } as Sketch[string],
  L2: { start: [10, 0], end: [10, 10] } as Sketch[string],
})

const makeDrag = (overrides: Partial<import('@/stores/sketchEditorStore').VertexOrEdgeDrag> = {}) => ({
  type: 'vertex' as const,
  vertexId: 'vertex:S1:L1:start',
  featureId: FEATURE,
  entityId: 'L1',
  vertexKey: 'start',
  startWorld: [0, 0] as [number, number],
  currentWorld: [0, 0] as [number, number],
  startClient: [100, 100] as [number, number],
  ...overrides,
})

describe('shouldActivateDrag', () => {
  it('returns false when pointer has not moved', () => {
    expect(shouldActivateDrag([100, 100], [100, 100])).toBe(false)
  })

  it('returns false when movement is below threshold', () => {
    expect(shouldActivateDrag([100, 100], [100 + CLICK_THRESHOLD_PX - 1, 100])).toBe(false)
  })

  it('returns true when movement equals threshold', () => {
    expect(shouldActivateDrag([100, 100], [100 + CLICK_THRESHOLD_PX, 100])).toBe(true)
  })

  it('returns true when movement exceeds threshold', () => {
    expect(shouldActivateDrag([100, 100], [200, 200])).toBe(true)
  })
})

describe('computeDragMove', () => {
  const pixPerUnit = 0.01  // 100 pixels per unit

  const buildCandidates = (sketch: Sketch, featureId: string, skipEntityId?: string) => {
    const vertexCandidates = sketchToVertexCandidates(sketch, featureId, 'active_sketch')
    const entityCandidates = sketchToEntityCandidates(sketch, featureId, 'active_sketch')
    const skipIds = new Set<string>()
    if (skipEntityId) skipIds.add(skipEntityId)
    return { vertexCandidates, entityCandidates, skipIds }
  }

  it('returns null snap when cursor is far from all entities', () => {
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [50, 50], vertexCandidates, entityCandidates, skipIds, makeDrag(), pixPerUnit,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.effectivePosition).toEqual([50, 50])
  })

  it('returns vertex snap when cursor is near another vertex', () => {
    // L2 start is at [10, 0]; cursor near [10, 0] with large threshold
    const drag = makeDrag({ entityId: 'L1' })  // dragging L1, so L2 vertices are candidates
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10.01, 0], vertexCandidates, entityCandidates, skipIds, drag,
      1,  // 1 unit per pixel = large radius
    )
    expect(result.snapTarget?.kind).toBe('vertex')
    expect(result.snapTarget?.vertexId).toBe('vertex:S1:L2:start')
  })

  it('returns entity snap when cursor is on entity body but not near vertex', () => {
    const drag = makeDrag({ entityId: '__none__' })
    // pixPerUnit=0.01 -> vertex radius 0.2 wu, entity radius 0.08 wu.
    // Cursor at [5, 0.05] is 0.05 wu from L1 (< entity threshold) but ~5 wu from
    // every vertex (> vertex threshold), so entity snap fires.
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, '__none__')
    const result = computeDragMove(
      [5, 0.05], vertexCandidates, entityCandidates, skipIds, drag,
      0.01,
    )
    expect(result.snapTarget?.kind).toBe('entity')
    expect(result.snapTarget?.entityRef).toBe('entity:S1:L1')
  })

  it('effectivePosition equals snap position when snap is active', () => {
    const drag = makeDrag({ entityId: 'L1' })
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10.01, 0.01], vertexCandidates, entityCandidates, skipIds, drag,
      1,
    )
    if (result.snapTarget) {
      expect(result.effectivePosition).toEqual(result.snapTarget.position)
    }
  })

  it('edge drag returns no snap and uses raw position', () => {
    const drag = makeDrag({ type: 'edge', entityId: 'L1' })
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [5, 5], vertexCandidates, entityCandidates, skipIds, drag, pixPerUnit,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.effectivePosition).toEqual([5, 5])
  })
})

describe('computeDragMutation', () => {
  it('returns null for a pure click (no movement)', () => {
    const drag = makeDrag({ startClient: [100, 100] })
    const result = computeDragMutation([100, 100], drag, null, null)
    expect(result).toBeNull()
  })

  it('returns null for movement below click threshold', () => {
    const drag = makeDrag({ startClient: [100, 100] })
    const result = computeDragMutation([100 + CLICK_THRESHOLD_PX - 1, 100], drag, null, null)
    expect(result).toBeNull()
  })

  it('returns move_vertex with raw coordinates when no snap', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const result = computeDragMutation([200, 200], drag, null, null)
    expect(result?.type).toBe('move_vertex')
    if (result?.type === 'move_vertex') {
      expect(result.to).toEqual([5, 5])
      expect(result.featureId).toBe(FEATURE)
    }
  })

  it('returns move_vertex_with_constraint for vertex snap', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [10, 0] })
    const snapTarget = {
      kind: 'vertex' as const,
      position: [10, 0] as [number, number],
      constraintKind: 'coincident',
      vertexId: 'vertex:S1:L2:start',
    }
    const result = computeDragMutation([200, 200], drag, snapTarget, null)
    expect(result?.type).toBe('move_vertex_with_constraint')
    if (result?.type === 'move_vertex_with_constraint') {
      expect(result.snapVertexId).toBe('vertex:S1:L2:start')
      expect(result.constraintKind).toBe('coincident')
    }
  })

  it('returns move_vertex_with_constraint with entityRef for entity snap', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 0] })
    const snapTarget = {
      kind: 'entity' as const,
      position: [5, 0] as [number, number],
      constraintKind: 'coincident',
      entityRef: 'entity:S1:L1',
    }
    const result = computeDragMutation([200, 200], drag, snapTarget, null)
    expect(result?.type).toBe('move_vertex_with_constraint')
    if (result?.type === 'move_vertex_with_constraint') {
      expect(result.snapEntityRef).toBe('entity:S1:L1')
    }
  })

  it('returns move_vertex for alignment snap (no constraint)', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 0.1] })
    const alignmentSnap = {
      point: [0, 0] as [number, number],
      kind: 'kinda_horizontal',
      vertexId: 'vertex:S1:L1:end',
    }
    const result = computeDragMutation([200, 200], drag, null, alignmentSnap)
    // Alignment snap moves vertex to currentWorld position without creating a constraint.
    // The alignment-snapped position is already baked into currentWorld by computeDragMove.
    expect(result?.type).toBe('move_vertex')
    if (result?.type === 'move_vertex') {
      expect(result.to).toEqual([5, 0.1])
    }
  })

  it('returns move_entity with delta for edge drag', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const result = computeDragMutation([200, 200], drag, null, null)
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.delta).toEqual([3, 4])
    }
  })

  // ─── solvedGeometry pass-through (commit the WASM drag frame) ───

  it('attaches solvedGeometry when the last drag solve belongs to this feature', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const geometry = { L1: [0, 0, 5, 5], L2: [5, 5, 5, 10] }
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: FEATURE, geometry })
    expect(result?.type).toBe('move_vertex')
    if (result?.type === 'move_vertex') {
      expect(result.solvedGeometry).toEqual(geometry)
    }
  })

  it('attaches solvedGeometry on the snap-constraint mutation too', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [10, 0] })
    const snapTarget = {
      kind: 'vertex' as const,
      position: [10, 0] as [number, number],
      constraintKind: 'coincident',
      vertexId: 'vertex:S1:L2:start',
    }
    const geometry = { L1: [0, 0, 10, 0] }
    const result = computeDragMutation([200, 200], drag, snapTarget, null, { featureId: FEATURE, geometry })
    expect(result?.type).toBe('move_vertex_with_constraint')
    if (result?.type === 'move_vertex_with_constraint') {
      expect(result.solvedGeometry).toEqual(geometry)
    }
  })

  it('ignores a last drag solve from a different feature (stale registry)', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: 'otherFeature', geometry: { X: [1] } })
    expect(result?.type).toBe('move_vertex')
    if (result?.type === 'move_vertex') {
      expect(result.solvedGeometry).toBeUndefined()
    }
  })

  it('edge drag carries solvedGeometry when WASM solve is engaged', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const geometry = { L1: [3, 4, 13, 4], L2: [10, 0, 10, 10] }
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: FEATURE, geometry })
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.solvedGeometry).toEqual(geometry)
    }
  })

  it('edge drag without WASM solve carries no solvedGeometry', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const result = computeDragMutation([200, 200], drag, null, null, null)
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.solvedGeometry).toBeUndefined()
    }
  })

  it('edge drag in radius mode commits resize_circle carrying the solved radius', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const geometry = { L1: [0, 0, 7.5, 0] }
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: FEATURE, geometry, mode: 'radius' })
    expect(result?.type).toBe('resize_circle')
    if (result?.type === 'resize_circle') {
      expect(result.entityId).toBe('L1')
      expect(result.radius).toBeCloseTo(7.5)
      expect(result.solvedGeometry).toEqual(geometry)
    }
  })

  it('edge drag in locked mode commits no mutation', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: FEATURE, mode: 'locked' })
    expect(result).toBeNull()
  })

  it('edge drag with no mode falls back to move_entity', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    // No mode field at all: lines/arcs/ellipses and the non-engaged solver path.
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: FEATURE, geometry: { L1: [3, 4, 13, 4] } })
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.delta).toEqual([3, 4])
    }
  })

  it('a mode published for a different featureId is ignored', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    // The registry still carries a mode, but for a different feature: must fall
    // back to move_entity, not resize_circle/locked.
    const result = computeDragMutation([200, 200], drag, null, null, { featureId: 'otherFeature', geometry: { C1: [0, 0, 7.5] }, mode: 'radius' })
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.delta).toEqual([3, 4])
    }
  })
})
