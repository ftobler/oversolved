// A snap onto another sketch's geometry used to author a constraint naming that
// sketch's entity, which the solver reads as a stale reference and ignores (the
// constraint had no tile and no viewport paint either). The applier now projects
// the snapped element into the active sketch first, the shape the constraint
// command already uses for a B-rep pick, so the constraint names a local held
// entity and both land in one mutation, one undo entry.
import { describe, it, expect } from 'vitest'
import type { PartDoc, Mutation, SketchFeature, SketchData } from '@/types/cad'
import {
  applyAddConstraint, applyAddEntityWithConstraint,
} from '@/utils/yamlMutations/sketch'
import { mutationHandlers } from '@/hooks/mutationDispatch'
import { createDocSession } from '@/session/DocSession'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'

const rectDoc = (): PartDoc => makeDoc(
  makeSketch('sk1', {
    entities: [
      { id: 'L1', kind: 'line' },
      { id: 'L2', kind: 'line' },
    ],
    initial: { L1: [0, 0, 10, 0], L2: [10, 0, 10, 6] },
  }),
  makeSketch('sk2', {
    plane: '@builtin_plane_right',
    entities: [{ id: 'ax', kind: 'line' }],
    initial: { ax: [0, 0, 4, 0] },
  }),
)

const sketchOf = (doc: PartDoc, id: string): SketchFeature => {
  const feature = doc.features?.find(f => f.id === id)
  if (feature?.kind !== 'sketch') throw new Error(`no sketch ${id}`)
  return feature
}

describe('cross-sketch snaps project before they constrain', () => {
  it('a vertex snap onto an earlier sketch authors a point projection and a coincident to it', () => {
    const doc = rectDoc()
    applyAddEntityWithConstraint(doc, 'sk2', 'line', [0, 0, 5, 5], 'start', 'vertex:sk1:L1:end', 'coincident')
    const sk2 = sketchOf(doc, 'sk2')
    const line = sk2.entities!.find(e => e.id !== 'ax')!
    const projection = sk2.constraints!.find(c => c.kind === 'projection')!
    const projectedId = String(projection.target).replace(/^\$/, '')
    // The held entity exists, is a point (a vertex source), and records where it
    // came from in the registry's slash form.
    expect(sk2.entities!.find(e => e.id === projectedId)).toEqual({ id: projectedId, kind: 'point' })
    expect(projection.source).toBe('@sk1/L1/end')
    const coincident = sk2.constraints!.find(c => c.kind === 'coincident')!
    expect(coincident.a).toBe(`$${line.id}start`)
    expect(coincident.b).toBe(`$${projectedId}xy`)
    // The constraint itself names only local refs: the solver reads a foreign
    // one as stale and ignores it.
    expect(String(coincident.a).startsWith('$')).toBe(true)
    expect(String(coincident.b).startsWith('$')).toBe(true)
  })

  it('a whole-entity locus snap projects the source curve with its own kind', () => {
    // A curve snap on a circle: the projection must be a circle, not a point,
    // or the "point on this curve" reading would be lost.
    const doc = makeDoc(
      makeSketch('sk1', { entities: [{ id: 'C1', kind: 'circle' }], initial: { C1: [3, 4, 2] } }),
      makeSketch('sk2', { plane: '@builtin_plane_right', entities: [{ id: 'p1', kind: 'point' }], initial: { p1: [0, 0] } }),
    )
    applyAddEntityWithConstraint(doc, 'sk2', 'point', [1, 1], 'xy', undefined, 'coincident', 'entity:sk1:C1')
    const sk2 = sketchOf(doc, 'sk2')
    const projection = sk2.constraints!.find(c => c.kind === 'projection')!
    const projectedId = String(projection.target).replace(/^\$/, '')
    expect(sk2.entities!.find(e => e.id === projectedId)?.kind).toBe('circle')
    expect(projection.source).toBe('@sk1/C1')
    expect(sk2.constraints!.find(c => c.kind === 'coincident')!.b).toBe(`$${projectedId}`)
  })

  it('reuses a recorded projection of the same source instead of stacking a second', () => {
    const doc = rectDoc()
    const sk2 = sketchOf(doc, 'sk2')
    sk2.entities!.push({ id: 'held', kind: 'point' })
    sk2.constraints!.push({ id: 'proj_held', kind: 'projection', target: '$held', source: '@sk1/L1/end' })

    applyAddConstraint(doc, 'sk2', 'coincident', ['vertex:sk2:ax:end', 'vertex:sk1:L1:end'])
    expect(sk2.entities!.filter(e => e.kind === 'point')).toHaveLength(1)
    expect(sk2.constraints!.filter(c => c.kind === 'projection')).toHaveLength(1)
    expect(sk2.constraints!.find(c => c.kind === 'coincident')!.b).toBe('$heldxy')
  })

  it('a snap to a sketch that comes later in the tree is position only', () => {
    // sk2 comes first: a snap onto sk1 (later) cannot resolve yet, so the pick
    // keeps its position and authors nothing, exactly like a body snap.
    const doc = makeDoc(
      makeSketch('sk2', { plane: '@builtin_plane_right', entities: [{ id: 'ax', kind: 'line' }], initial: { ax: [0, 0, 4, 0] } }),
      makeSketch('sk1', { entities: [{ id: 'L1', kind: 'line' }], initial: { L1: [0, 0, 10, 0] } }),
    )
    applyAddEntityWithConstraint(doc, 'sk2', 'line', [0, 0, 5, 5], 'start', 'vertex:sk1:L1:end', 'coincident')
    const sk2 = sketchOf(doc, 'sk2')
    expect(sk2.entities).toHaveLength(2)
    expect(sk2.constraints ?? []).toHaveLength(0)
  })

  it('a snap naming a sketch the document does not hold authors no dead ref', () => {
    const doc = rectDoc()
    const snapshot = JSON.stringify(doc)
    applyAddConstraint(doc, 'sk2', 'coincident', ['vertex:sk2:ax:end', 'vertex:skGone:L1:end'])
    expect(JSON.stringify(doc)).toBe(snapshot)
  })

  it('a refused shape leaves no orphan projection behind', () => {
    // The shape check runs before the projections are materialized, so a pick
    // the applier refuses must not leave the held entity it planned.
    const doc = rectDoc()
    const snapshot = JSON.stringify(doc)
    applyAddConstraint(doc, 'sk2', 'coincident', ['entity:sk1:L1'])
    expect(JSON.stringify(doc)).toBe(snapshot)
    expect(sketchOf(doc, 'sk2').constraints ?? []).toHaveLength(0)
  })

  it('is one undo entry on the session: undo restores the constraint and the projection', () => {
    const doc = rectDoc()
    const cell: { current: PartDoc | null } = { current: doc }
    const solveResults: { current: Record<string, SketchData> } = { current: {} }
    const session = createDocSession({
      cloneDoc: source => structuredClone(source),
      doc: { get: () => cell.current, set: next => { cell.current = next } },
      solve: createFakeSolveScheduler<PartDoc>(),
      solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
      editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
      dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    })
    const mutation: Mutation = {
      type: 'add_entity_with_constraint', featureId: 'sk2', kind: 'line',
      params: [0, 0, 5, 5], vertexKey: 'start', snapVertexId: 'vertex:sk1:L1:end', constraintKind: 'coincident',
    }
    expect(session.execute(mutation).ok).toBe(true)
    const after = sketchOf(cell.current!, 'sk2')
    expect(after.constraints!.filter(c => c.kind === 'projection')).toHaveLength(1)

    expect(session.undo()).toBe(true)
    const undone = sketchOf(cell.current!, 'sk2')
    expect(undone.entities).toHaveLength(1)
    expect(undone.constraints ?? []).toHaveLength(0)
  })

  it('the dispatch handler routes a drag snap through the same projection', () => {
    const doc = rectDoc()
    mutationHandlers.move_vertex_with_constraint(doc, {
      type: 'move_vertex_with_constraint', featureId: 'sk2', entityId: 'ax', vertexKey: 'start',
      to: [1, 1], constraintKind: 'coincident', snapEntityRef: 'entity:sk1:L2',
    })
    const sk2 = sketchOf(doc, 'sk2')
    expect(sk2.initial!.ax.slice(0, 2)).toEqual([1, 1])
    const projection = sk2.constraints!.find(c => c.kind === 'projection')!
    const projectedId = String(projection.target).replace(/^\$/, '')
    expect(projection.source).toBe('@sk1/L2')
    expect(sk2.constraints!.find(c => c.kind === 'coincident')!.b).toBe(`$${projectedId}`)
  })
})

// The document an older build already wrote keeps its dead ref (no migration):
// the cleanup command is how it goes away, in one undoable mutation.
describe('the cleanup command clears a dropped constraint', () => {
  const docWithDeadRef = (): PartDoc => makeDoc(
    makeSketch('sk1', { entities: [{ id: 'L1', kind: 'line' }], initial: { L1: [0, 0, 10, 0] } }),
    makeSketch('sk2', {
      plane: '@builtin_plane_right',
      entities: [{ id: 'ax', kind: 'line' }],
      initial: { ax: [0, 0, 4, 0] },
      constraints: [{ id: 'c_dead', kind: 'coincident', a: '$axstart', b: '@sk1/L1' }],
    }),
  )

  it('removes the row and undo puts it back', () => {
    const doc = docWithDeadRef()
    const cell: { current: PartDoc | null } = { current: doc }
    const solveResults: { current: Record<string, SketchData> } = { current: {} }
    const session = createDocSession({
      cloneDoc: source => structuredClone(source),
      doc: { get: () => cell.current, set: next => { cell.current = next } },
      solve: createFakeSolveScheduler<PartDoc>(),
      solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
      editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
      dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
    })
    expect(session.execute({
      type: 'remove_dangling_content',
      features: { sk2: { projections: [], constraints: ['c_dead'] } },
    }).ok).toBe(true)
    expect(sketchOf(cell.current!, 'sk2').constraints ?? []).toHaveLength(0)
    expect(session.undo()).toBe(true)
    expect(sketchOf(cell.current!, 'sk2').constraints!.map(c => c.id)).toEqual(['c_dead'])
  })
})
