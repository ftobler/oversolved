import { describe, it, expect } from 'vitest'
import type { Sketch } from '../../../types/cad'
import { shouldActivateDrag, computeDragMove, computeDragMutation } from '../dragLogic'
import { sketchToVertexCandidates, sketchToEntityCandidates } from '../snapDetection'
import { CLICK_THRESHOLD_PX } from '../pointerAbstraction'

const FEATURE = 'S1'

const makeSketch = (): Sketch => ({
  L1: { start: [0, 0], end: [10, 0] } as Sketch[string],
  L2: { start: [10, 0], end: [10, 10] } as Sketch[string],
})

const makeDrag = (overrides: Partial<import('../../../stores/sketchEditorStore').VertexOrEdgeDrag> = {}) => ({
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
  const emptyDynamic = new Set<string>()
  const emptyNormal = new Set<string>()
  const emptyPositions = new Map<string, [number, number]>()
  const emptyProximity = new Set<string>()
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
      [50, 50], vertexCandidates, entityCandidates, skipIds, makeDrag(),
      emptyDynamic, emptyNormal, emptyPositions, emptyProximity, pixPerUnit,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.alignmentSnap).toBeNull()
    expect(result.effectivePosition).toEqual([50, 50])
  })

  it('returns vertex snap when cursor is near another vertex', () => {
    // L2 start is at [10, 0]; cursor near [10, 0] with large threshold
    const drag = makeDrag({ entityId: 'L1' })  // dragging L1, so L2 vertices are candidates
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10.01, 0], vertexCandidates, entityCandidates, skipIds, drag,
      emptyDynamic, emptyNormal, emptyPositions, emptyProximity,
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
      emptyDynamic, emptyNormal, emptyPositions, emptyProximity,
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
      emptyDynamic, emptyNormal, emptyPositions, emptyProximity,
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
      [5, 5], vertexCandidates, entityCandidates, skipIds, drag,
      emptyDynamic, emptyNormal, emptyPositions, emptyProximity, pixPerUnit,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.alignmentSnap).toBeNull()
    expect(result.effectivePosition).toEqual([5, 5])
  })

  it('tracks new proximity IDs vs previous frame', () => {
    const drag = makeDrag({ entityId: 'L1' })
    const { vertexCandidates, entityCandidates, skipIds } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10, 0], vertexCandidates, entityCandidates, skipIds, drag,
      emptyDynamic, emptyNormal, emptyPositions, emptyProximity,
      1,  // 1 unit per pixel = 60px radius, very large
    )
    // L2 start [10,0] is at cursor -- should enter proximity
    expect(result.allProximityIds.size).toBeGreaterThan(0)
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

  it('returns move_vertex_with_constraint with h constraint for alignment snap', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 0.1] })
    const alignmentSnap = {
      point: [0, 0] as [number, number],
      kind: 'kinda_horizontal',
      vertexId: 'vertex:S1:L1:end',
    }
    const result = computeDragMutation([200, 200], drag, null, alignmentSnap)
    expect(result?.type).toBe('move_vertex_with_constraint')
    if (result?.type === 'move_vertex_with_constraint') {
      expect(result.constraintKind).toBe('horizontal')
      expect(result.snapVertexId).toBe('vertex:S1:L1:end')
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
})
