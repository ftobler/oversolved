import { describe, it, expect } from 'vitest'
import { computeDragMutation, collectCoincidentVertexIds } from '@/components/Geometry3D/dragLogic'
import { BODY_SNAP_FEAT_PREFIX } from '@/components/Geometry3D/bodySnapProjection'

// Branches the main dragLogic suite leaves uncovered: body-snap targets (which
// are position-only, no constraint), and parseLocalVertexRef's reject paths
// (a `$` ref with no recognized vertex key, or an empty entity id).

const FEATURE = 'S1'

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

describe('computeDragMutation body-snap targets are position-only', () => {
  it('a body-vertex snap produces a plain move_vertex (no constraint)', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const snapTarget = {
      kind: 'vertex' as const,
      position: [5, 5] as [number, number],
      constraintKind: 'coincident',
      vertexId: `vertex:${BODY_SNAP_FEAT_PREFIX}xyz:v0`,
    }
    const result = computeDragMutation([200, 200], drag, snapTarget, null)
    expect(result?.type).toBe('move_vertex')
    if (result?.type === 'move_vertex') {
      expect(result.to).toEqual([5, 5])
      // a real constraint mutation would be move_vertex_with_constraint
      expect('constraintKind' in result).toBe(false)
    }
  })

  it('a body-edge snap produces a plain move_vertex (no constraint)', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [3, 0] })
    const snapTarget = {
      kind: 'entity' as const,
      position: [3, 0] as [number, number],
      constraintKind: 'coincident',
      entityRef: `entity:${BODY_SNAP_FEAT_PREFIX}xyz:e1`,
    }
    const result = computeDragMutation([200, 200], drag, snapTarget, null)
    expect(result?.type).toBe('move_vertex')
    if (result?.type === 'move_vertex') {
      expect(result.to).toEqual([3, 0])
    }
  })

  it('a real sketch vertex snap still creates a constraint (contrast)', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const snapTarget = {
      kind: 'vertex' as const,
      position: [5, 5] as [number, number],
      constraintKind: 'coincident',
      vertexId: 'vertex:S1:L2:start',
    }
    const result = computeDragMutation([200, 200], drag, snapTarget, null)
    expect(result?.type).toBe('move_vertex_with_constraint')
  })
})

describe('collectCoincidentVertexIds rejects malformed local refs', () => {
  it('ignores a partner ref that ends in no known vertex key', () => {
    const constraints = [
      { kind: 'coincident', a: '$L1start', b: '$bogusRef' },  // "bogusRef" has no key suffix
    ]
    const ids = collectCoincidentVertexIds(constraints, FEATURE, 'L1', 'start')
    expect([...ids]).toEqual(['vertex:S1:L1:start'])
  })

  it('ignores a partner ref whose entity id would be empty', () => {
    const constraints = [
      { kind: 'coincident', a: '$L1start', b: '$start' },  // key matches but entity id is ''
    ]
    const ids = collectCoincidentVertexIds(constraints, FEATURE, 'L1', 'start')
    expect([...ids]).toEqual(['vertex:S1:L1:start'])
  })
})
