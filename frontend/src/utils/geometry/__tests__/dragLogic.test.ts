import { describe, it, expect } from 'vitest'
import type { Sketch, SketchFeature, Mutation, PartConstraint } from '@/types/cad'
import { shouldActivateDrag, computeDragMove, computeDragMutation, dragSnapSkips, dragIsHeld } from '@/utils/geometry/dragLogic'
import { sketchToVertexCandidates, sketchToEntityCandidates } from '@/utils/geometry/snapDetection'
import { CLICK_THRESHOLD_PX } from '@/utils/pointerAbstraction'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { makeDoc, makeSketch as makeSketchFixture } from '@/utils/core/testFixture'

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

describe('dragIsHeld', () => {
  it('holds an edge drag on a held entity and any all-held group', () => {
    const held = new Set(['L1'])
    expect(dragIsHeld(makeDrag({ type: 'edge', entityId: 'L1' }), held)).toBe(true)
    expect(dragIsHeld(makeDrag({
      type: 'edge',
      group: [
        { entityId: 'L1', vertexKey: 'edge' },
        { entityId: 'L2', vertexKey: 'edge' },
      ],
    }), held)).toBe(false)
  })

  it('never drops a vertex drag from a held set (a fixed point can still pivot)', () => {
    // A `fixed` on one point holds the whole entity on the headless path, but the
    // live solver rotates the entity about it; dropping the vertex release would
    // snap the user's drag back.
    expect(dragIsHeld(makeDrag({ entityId: 'L1' }), new Set(['L1']))).toBe(false)
  })

  it('a group is held only when every member is held', () => {
    expect(dragIsHeld(makeDrag({
      type: 'edge',
      group: [
        { entityId: 'L1', vertexKey: 'edge' },
        { entityId: 'L2', vertexKey: 'edge' },
      ],
    }), new Set(['L1', 'L2']))).toBe(true)
  })
})

describe('computeDragMove', () => {
  const pixPerUnit = 0.01  // 100 pixels per unit

  const buildCandidates = (sketch: Sketch, featureId: string, skipEntityId?: string) => {
    const vertexCandidates = sketchToVertexCandidates(sketch, featureId, 'active_sketch')
    const entityCandidates = sketchToEntityCandidates(sketch, featureId, 'active_sketch')
    const skips = { vertexIds: new Set<string>(), entityIds: new Set<string>() }
    if (skipEntityId) skips.entityIds.add(`${featureId}:${skipEntityId}`)
    return { vertexCandidates, entityCandidates, skips }
  }

  it('returns null snap when cursor is far from all entities', () => {
    const { vertexCandidates, entityCandidates, skips } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [50, 50], vertexCandidates, entityCandidates, skips, makeDrag(), pixPerUnit,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.effectivePosition).toEqual([50, 50])
  })

  it('returns vertex snap when cursor is near another vertex', () => {
    // L2 start is at [10, 0]; cursor near [10, 0] with large threshold
    const drag = makeDrag({ entityId: 'L1' })  // dragging L1, so L2 vertices are candidates
    const { vertexCandidates, entityCandidates, skips } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10.01, 0], vertexCandidates, entityCandidates, skips, drag,
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
    const { vertexCandidates, entityCandidates, skips } = buildCandidates(makeSketch(), FEATURE, '__none__')
    const result = computeDragMove(
      [5, 0.05], vertexCandidates, entityCandidates, skips, drag,
      0.01,
    )
    expect(result.snapTarget?.kind).toBe('entity')
    expect(result.snapTarget?.entityRef).toBe('entity:S1:L1')
  })

  it('effectivePosition equals snap position when snap is active', () => {
    const drag = makeDrag({ entityId: 'L1' })
    const { vertexCandidates, entityCandidates, skips } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10.01, 0.01], vertexCandidates, entityCandidates, skips, drag,
      1,
    )
    if (result.snapTarget) {
      expect(result.effectivePosition).toEqual(result.snapTarget.position)
    }
  })

  it('edge drag returns no snap and uses raw position', () => {
    const drag = makeDrag({ type: 'edge', entityId: 'L1' })
    const { vertexCandidates, entityCandidates, skips } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [5, 5], vertexCandidates, entityCandidates, skips, drag, pixPerUnit,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.effectivePosition).toEqual([5, 5])
  })

  it('a group drag never snaps, even when pressed on a vertex', () => {
    // The cursor sits on another line's vertex, which a plain vertex drag
    // would latch onto and then author a constraint for. A group translation
    // has no single snap target.
    const drag = makeDrag({
      entityId: 'L1',
      group: [
        { entityId: 'L1', vertexKey: 'edge' },
        { entityId: 'L2', vertexKey: 'edge' },
      ],
    })
    const { vertexCandidates, entityCandidates, skips } = buildCandidates(makeSketch(), FEATURE, 'L1')
    const result = computeDragMove(
      [10, 0], vertexCandidates, entityCandidates, skips, drag, 1,
    )
    expect(result.snapTarget).toBeNull()
    expect(result.effectivePosition).toEqual([10, 0])
  })
})

describe('computeDragMutation', () => {
  it('returns null for a pure click (no movement)', () => {
    const drag = makeDrag({ startClient: [100, 100] })
    const result = computeDragMutation([100, 100], drag, null)
    expect(result).toBeNull()
  })

  it('returns null for movement below click threshold', () => {
    const drag = makeDrag({ startClient: [100, 100] })
    const result = computeDragMutation([100 + CLICK_THRESHOLD_PX - 1, 100], drag, null)
    expect(result).toBeNull()
  })

  it('returns move_vertex with raw coordinates when no snap', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const result = computeDragMutation([200, 200], drag, null)
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
    const result = computeDragMutation([200, 200], drag, snapTarget)
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
    const result = computeDragMutation([200, 200], drag, snapTarget)
    expect(result?.type).toBe('move_vertex_with_constraint')
    if (result?.type === 'move_vertex_with_constraint') {
      expect(result.snapEntityRef).toBe('entity:S1:L1')
    }
  })

  it('returns move_entity with delta for edge drag', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const result = computeDragMutation([200, 200], drag, null)
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.delta).toEqual([3, 4])
    }
  })

  it('returns one move_sketch_group with every member for a group drag', () => {
    const group = [
      { entityId: 'L1', vertexKey: 'edge' },
      { entityId: 'L2', vertexKey: 'start' },
    ]
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [2, 3],
      currentWorld: [5, 7],
      group,
    })
    const geometry = { L1: [5, 7, 13, 7], L2: [5, 7, 10, 17] }
    const result = computeDragMutation(
      [200, 200], drag, { kind: 'vertex', position: [5, 7], constraintKind: 'coincident' },
      { featureId: FEATURE, geometry },
    )
    expect(result).toEqual({
      type: 'move_sketch_group', featureId: FEATURE, members: group, delta: [3, 4], solvedGeometry: geometry,
    })
  })

  it('a group drag that only clicked emits nothing', () => {
    const drag = makeDrag({
      type: 'vertex',
      startClient: [100, 100],
      currentWorld: [0.5, 0],
      group: [
        { entityId: 'L1', vertexKey: 'edge' },
        { entityId: 'L2', vertexKey: 'edge' },
      ],
    })
    expect(computeDragMutation([100, 100], drag, null)).toBeNull()
  })

  it('a locked group (every member fixed or projected) commits nothing', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
      group: [
        { entityId: 'L1', vertexKey: 'edge' },
        { entityId: 'L2', vertexKey: 'edge' },
      ],
    })
    // The activation probe latched 'locked': there is no motion to commit, so
    // no mutation and no junk undo entry.
    expect(computeDragMutation([200, 200], drag, null, { featureId: FEATURE, mode: 'locked' })).toBeNull()
  })

  // ─── solvedGeometry pass-through (commit the WASM drag frame) ───

  it('attaches solvedGeometry when the last drag solve belongs to this feature', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const geometry = { L1: [0, 0, 5, 5], L2: [5, 5, 5, 10] }
    const result = computeDragMutation([200, 200], drag, null, { featureId: FEATURE, geometry })
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
    const result = computeDragMutation([200, 200], drag, snapTarget, { featureId: FEATURE, geometry })
    expect(result?.type).toBe('move_vertex_with_constraint')
    if (result?.type === 'move_vertex_with_constraint') {
      expect(result.solvedGeometry).toEqual(geometry)
    }
  })

  it('ignores a last drag solve from a different feature (stale registry)', () => {
    const drag = makeDrag({ startClient: [100, 100], currentWorld: [5, 5] })
    const result = computeDragMutation([200, 200], drag, null, { featureId: 'otherFeature', geometry: { X: [1] } })
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
    const result = computeDragMutation([200, 200], drag, null, { featureId: FEATURE, geometry })
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
    const result = computeDragMutation([200, 200], drag, null, null)
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
    const result = computeDragMutation([200, 200], drag, null, { featureId: FEATURE, geometry, mode: 'radius' })
    expect(result?.type).toBe('resize_circle')
    if (result?.type === 'resize_circle') {
      expect(result.entityId).toBe('L1')
      expect(result.radius).toBeCloseTo(7.5)
      expect(result.solvedGeometry).toEqual(geometry)
    }
  })

  it('edge drag in radius mode with no solved geometry commits no mutation', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    // Radius mode reads the solved radius off the drag frame; with no geometry
    // published for this feature there is nothing to resize to, so emit nothing.
    const result = computeDragMutation([200, 200], drag, null, { featureId: FEATURE, mode: 'radius' })
    expect(result).toBeNull()
  })

  it('edge drag in locked mode commits no mutation', () => {
    const drag = makeDrag({
      type: 'edge',
      startClient: [100, 100],
      startWorld: [0, 0],
      currentWorld: [3, 4],
    })
    const result = computeDragMutation([200, 200], drag, null, { featureId: FEATURE, mode: 'locked' })
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
    const result = computeDragMutation([200, 200], drag, null, { featureId: FEATURE, geometry: { L1: [3, 4, 13, 4] } })
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
    const result = computeDragMutation([200, 200], drag, null, { featureId: 'otherFeature', geometry: { C1: [0, 0, 7.5] }, mode: 'radius' })
    expect(result?.type).toBe('move_entity')
    if (result?.type === 'move_entity') {
      expect(result.delta).toEqual([3, 4])
    }
  })
})

// A release on another sketch's geometry used to record a constraint naming that
// sketch, which the solve drops as a stale reference. The drag still emits the
// one snap mutation; the applier projects the snapped element into the active
// sketch and constrains the projection, so the group is one undo entry.
describe('computeDragMutation released on another sketch', () => {
  const docWithTwoSketches = () => makeDoc(
    makeSketchFixture('S1', {
      entities: [{ id: 'L9', kind: 'line' }],
      initial: { L9: [0, 0, 10, 0] },
    }),
    makeSketchFixture('S2', { plane: '@builtin_plane_right', entities: [{ id: 'L1', kind: 'line' }], initial: { L1: [0, 5, 10, 5] } }),
  )

  // The same two sketches with the snap target AFTER the active one: a forward
  // reference the solve cannot resolve yet.
  const docWithLaterTarget = () => makeDoc(
    makeSketchFixture('S2', { plane: '@builtin_plane_right', entities: [{ id: 'L1', kind: 'line' }], initial: { L1: [0, 5, 10, 5] } }),
    makeSketchFixture('S1', { entities: [{ id: 'L9', kind: 'line' }], initial: { L9: [0, 0, 10, 0] } }),
  )

  it('yields the projection and a coincident against it in one mutation', () => {
    const drag = makeDrag({ featureId: 'S2', entityId: 'L1', vertexKey: 'start', currentWorld: [10, 0] })
    const mutation = computeDragMutation([200, 200], drag, {
      kind: 'entity', position: [5, 0], constraintKind: 'coincident', entityRef: 'entity:S1:L9',
    })
    expect(mutation?.type).toBe('move_vertex_with_constraint')
    const doc = docWithTwoSketches()
    mutationHandlers.move_vertex_with_constraint(doc, mutation as Extract<Mutation, { type: 'move_vertex_with_constraint' }>)
    const s2 = doc.features!.find(f => f.id === 'S2') as SketchFeature
    const projection = s2.constraints!.find(c => c.kind === 'projection')!
    expect(projection.source).toBe('@S1/L9')
    const projectedId = String(projection.target).replace(/^\$/, '')
    const coincident = s2.constraints!.find(c => c.kind === 'coincident')!
    expect(coincident.a).toBe('$L1start')
    expect(coincident.b).toBe(`$${projectedId}`)
  })

  it('a release on a later sketch keeps the position and authors nothing', () => {
    const drag = makeDrag({ featureId: 'S2', entityId: 'L1', vertexKey: 'start', currentWorld: [1, 1] })
    const mutation = computeDragMutation([200, 200], drag, {
      kind: 'vertex', position: [1, 1], constraintKind: 'coincident', vertexId: 'vertex:S1:L9:end',
    })
    const doc = docWithLaterTarget()
    mutationHandlers.move_vertex_with_constraint(doc, mutation as Extract<Mutation, { type: 'move_vertex_with_constraint' }>)
    const s2 = doc.features!.find(f => f.id === 'S2') as SketchFeature
    expect(s2.initial!.L1.slice(0, 2)).toEqual([1, 1])
    expect(s2.constraints ?? []).toHaveLength(0)
  })

  it('a body snap stays position only', () => {
    const drag = makeDrag({ featureId: 'S2', entityId: 'L1', vertexKey: 'start', currentWorld: [2, 2] })
    const mutation = computeDragMutation([200, 200], drag, {
      kind: 'vertex', position: [2, 2], constraintKind: 'coincident', vertexId: 'vertex:__body__b1:bv0:start',
    })
    expect(mutation?.type).toBe('move_vertex')
    if (mutation?.type === 'move_vertex') {
      expect(mutation.to).toEqual([2, 2])
    }
  })
})

// The twist-state report (bugreports/20261120_1925_twist_state.md): L2's start
// is coincident with L1's end, and three identical point-on-line rows also hold
// L2's start on L1. Dragging the corner near L1's body used to snap onto L1 and
// add another identical row on every release.
const TWIST = 'ZBNaee7JHHPKM_uidYh_3G9K'
const T_L0 = 'LNHDhTHIvb0r2uj_'
const T_L1 = 'in5ztTwqd1IVAMbt'
const T_L2 = 'AQHP4hgUmx9v34-A'
const T_L3 = 'PO7GJ1C5blvIKeQ3'

const twistSketch = (): Sketch => ({
  [T_L0]: { start: [0, 0], end: [-3.61953, 3.65477] } as Sketch[string],
  [T_L1]: { start: [-3.61953, 3.65477], end: [14.298334, 7.967438] } as Sketch[string],
  [T_L2]: { start: [14.298334, 7.967438], end: [13.094651, 12.968387] } as Sketch[string],
  [T_L3]: { start: [13.094651, 12.968387], end: [0, 0] } as Sketch[string],
})

const twistConstraints = (): PartConstraint[] => [
  { id: 'c1', kind: 'coincident', a: `$${T_L0}start`, b: '@builtin_origin' },
  { id: 'c2', kind: 'coincident', a: `$${T_L1}start`, b: `$${T_L0}end` },
  { id: 'c3', kind: 'coincident', a: `$${T_L2}start`, b: `$${T_L1}end` },
  { id: 'c4', kind: 'coincident', a: `$${T_L3}start`, b: `$${T_L2}end` },
  { id: 'c5', kind: 'coincident', a: `$${T_L3}end`, b: `$${T_L0}start` },
  { id: 'c6', kind: 'equal_length', a: `$${T_L1}`, b: `$${T_L3}` },
  { id: 'c7', kind: 'equal_length', a: `$${T_L2}`, b: `$${T_L0}` },
  { id: 'c8', kind: 'coincident', a: `$${T_L2}start`, b: `$${T_L1}` },
  { id: 'c9', kind: 'normal', a: `$${T_L2}`, b: `$${T_L1}` },
  { id: 'c10', kind: 'coincident', a: `$${T_L2}start`, b: `$${T_L1}` },
  { id: 'c11', kind: 'coincident', a: `$${T_L2}start`, b: `$${T_L1}` },
]

const twistDrag = () => makeDrag({
  vertexId: `vertex:${TWIST}:${T_L2}:start`,
  featureId: TWIST,
  entityId: T_L2,
  vertexKey: 'start',
  startWorld: [14.298334, 7.967438],
  currentWorld: [14.298334, 7.967438],
})

const twistMove = (skips: ReturnType<typeof dragSnapSkips>, cursor: [number, number]) => {
  const vertices = sketchToVertexCandidates(twistSketch(), TWIST, 'active_sketch')
  const entities = sketchToEntityCandidates(twistSketch(), TWIST, 'active_sketch')
  return computeDragMove(cursor, vertices, entities, skips, twistDrag(), 0.01)
}

describe('dragSnapSkips', () => {
  it('skips the bonded partner vertex and every entity that owns one', () => {
    const skips = dragSnapSkips(twistConstraints(), TWIST, twistDrag())
    expect(skips.vertexIds.has(`vertex:${TWIST}:${T_L1}:end`)).toBe(true)
    expect(skips.entityIds.has(`${TWIST}:${T_L1}`)).toBe(true)
    expect(skips.entityIds.has(`${TWIST}:${T_L2}`)).toBe(true)
  })

  it('does not snap the dragged corner onto the bonded partner line body', () => {
    const skips = dragSnapSkips(twistConstraints(), TWIST, twistDrag())
    // A hair off L1's body, 2.7 units from the corner and far from every vertex:
    // only L1's body is close enough for an entity snap.
    const result = twistMove(skips, [11.6106544, 7.3305378])
    expect(result.snapTarget).toBeNull()
  })

  it('still snaps to a line that is not bonded to the dragged vertex', () => {
    const skips = dragSnapSkips(twistConstraints(), TWIST, twistDrag())
    // Midpoint of L3's body, which holds no vertex in the dragged vertex's
    // coincident cluster.
    const result = twistMove(skips, [6.5473, 6.4842])
    expect(result.snapTarget?.kind).toBe('entity')
    expect(result.snapTarget?.entityRef).toBe(`entity:${TWIST}:${T_L3}`)
  })

  it('still snaps to a vertex that is not bonded to the dragged vertex', () => {
    const skips = dragSnapSkips(twistConstraints(), TWIST, twistDrag())
    // L0's end and L1's start share this point but are two bridges away from the
    // dragged corner, so one of them stays a vertex candidate.
    const result = twistMove(skips, [-3.61953, 3.65477])
    expect(result.snapTarget?.kind).toBe('vertex')
    expect(result.snapTarget?.vertexId).not.toBe(`vertex:${TWIST}:${T_L1}:end`)
  })

  it('skips an entity that already holds the dragged vertex point-on-line', () => {
    const holding: PartConstraint[] = [
      { id: 'c_hold', kind: 'coincident', a: `$L1start`, b: '$L2' },
      { id: 'c_hold_rev', kind: 'coincident', a: '$L3', b: `$L1start` },
    ]
    const skips = dragSnapSkips(holding, FEATURE, makeDrag())
    expect(skips.entityIds.has(`${FEATURE}:L2`)).toBe(true)
    expect(skips.entityIds.has(`${FEATURE}:L3`)).toBe(true)
  })

  it('skips the line a colinear or a midpoint holds the dragged vertex on', () => {
    const holding: PartConstraint[] = [
      { id: 'c_col', kind: 'colinear', a: `$L1start`, b: '$L2' },
      { id: 'c_mid', kind: 'midpoint', line: '$L3', point: `$L1start` },
    ]
    const skips = dragSnapSkips(holding, FEATURE, makeDrag())
    expect(skips.entityIds.has(`${FEATURE}:L2`)).toBe(true)
    expect(skips.entityIds.has(`${FEATURE}:L3`)).toBe(true)
  })

  it('a line-on-line colinear names no point to hold', () => {
    const lines: PartConstraint[] = [{ id: 'c_col', kind: 'colinear', a: '$L2', b: '$L3' }]
    const skips = dragSnapSkips(lines, FEATURE, makeDrag())
    expect(skips.entityIds.has(`${FEATURE}:L2`)).toBe(false)
    expect(skips.entityIds.has(`${FEATURE}:L3`)).toBe(false)
  })

  it('an edge drag has nothing to skip', () => {
    const skips = dragSnapSkips(twistConstraints(), TWIST, twistDrag())
    const edge = dragSnapSkips(twistConstraints(), TWIST, makeDrag({ type: 'edge', featureId: TWIST }))
    expect(edge.vertexIds.size).toBe(0)
    expect(edge.entityIds.size).toBe(0)
    expect(skips.vertexIds.size).toBeGreaterThan(0)
  })
})

describe('the reported line drag path', () => {
  const coincidentLines = () => makeDoc(makeSketchFixture('S1', {
    entities: [{ id: 'L1', kind: 'line' }, { id: 'L2', kind: 'line' }],
    constraints: [{ id: 'c_corner', kind: 'coincident', a: '$L1end', b: '$L2start' }],
    initial: { L1: [0, 0, 10, 0], L2: [10, 0, 10, 10] },
  }))

  // The second report's extra row cannot come from a line body drag: that
  // gesture emits `move_entity`, which authors no constraint. Even a latched
  // snap target is ignored on the edge branch.
  it('a line body drag emits move_entity and authors nothing', () => {
    const doc = coincidentLines()
    const drag = makeDrag({
      type: 'edge', startClient: [100, 100], startWorld: [10, 5], currentWorld: [12, 5],
    })
    const mutation = computeDragMutation([200, 200], drag, {
      kind: 'vertex', position: [10, 0], constraintKind: 'coincident', vertexId: 'vertex:S1:L2:start',
    })
    expect(mutation?.type).toBe('move_entity')
    mutationHandlers.move_entity(doc, mutation as Extract<Mutation, { type: 'move_entity' }>)
    expect((doc.features![0] as SketchFeature).constraints).toHaveLength(1)
  })

  // What the user perceives as dragging the line is the press on its endpoint
  // dot; release then commits `move_vertex_with_constraint` carrying the other
  // line as an entity snap. That is the event that used to add the extra row.
  it('the endpoint dot drag emits move_vertex_with_constraint with the partner line', () => {
    const drag = makeDrag({
      vertexId: 'vertex:S1:L1:end', entityId: 'L1', vertexKey: 'end',
      startClient: [100, 100], currentWorld: [10, 0],
    })
    const mutation = computeDragMutation([200, 200], drag, {
      kind: 'entity', position: [10, 0], constraintKind: 'coincident', entityRef: 'entity:S1:L2',
    })
    expect(mutation?.type).toBe('move_vertex_with_constraint')
    if (mutation?.type === 'move_vertex_with_constraint') {
      expect(mutation.snapEntityRef).toBe('entity:S1:L2')
    }
  })
})
