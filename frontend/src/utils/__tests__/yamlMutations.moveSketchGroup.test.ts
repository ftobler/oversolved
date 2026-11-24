// The group-drag commit: one mutation for the whole selection, so the move is
// one undo entry. With the live drag's solved frame it bakes that frame (the
// document lands where the preview showed); without one (the headless path) it
// translates the members by the delta and lets the next solve settle them.
import { describe, it, expect } from 'vitest'
import type { PartConstraint, PartDoc, SketchData } from '@/types/cad'
import { createDocSession, type DocSession, type EditorFacts } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { applyMoveEntity, applyMoveSketchGroup } from '@/utils/yamlMutations'
import { MutationRefusal } from '@/utils/yamlMutations/helpers'
import { sketchAt } from '@/testing/featureAccess'

function groupDoc(extra: { constraints?: PartConstraint[] } = {}): PartDoc {
  return makeDoc(makeSketch('sk', {
    entities: [
      { id: 'l1', kind: 'line' },
      { id: 'l2', kind: 'line' },
      { id: 'a1', kind: 'arc' },
      { id: 'p1', kind: 'point' },
    ],
    initial: {
      l1: [0, 0, 10, 0],
      l2: [20, 5, 30, 5],
      a1: [0, 0, 5, 0, 90],
      p1: [40, 0],
    },
    constraints: extra.constraints as never,
  }))
}

const sketch = (doc: PartDoc) => sketchAt(doc)

function engineFor(doc: PartDoc): { session: DocSession; cell: { current: PartDoc | null } } {
  const cell: { current: PartDoc | null } = { current: doc }
  const solve = createFakeSolveScheduler<PartDoc>()
  const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
  const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: source => structuredClone(source),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => facts,
    dirtyFacts: () => dirty,
  })
  return { session, cell }
}

describe('move_sketch_group applier', () => {
  it('translates every whole-entity member by the delta', () => {
    const doc = groupDoc()
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ], [3, -2])
    expect(sketch(doc).initial!.l1).toEqual([3, -2, 13, -2])
    expect(sketch(doc).initial!.l2).toEqual([23, 3, 33, 3])
  })

  it('moves only the named point of a point member', () => {
    const doc = groupDoc()
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'end' },
      { entityId: 'l2', vertexKey: 'edge' },
    ], [1, 4])
    // l1.end moved; l1.start stayed, so the line stretches as a single vertex
    // drag does.
    expect(sketch(doc).initial!.l1).toEqual([0, 0, 11, 4])
    expect(sketch(doc).initial!.l2).toEqual([21, 9, 31, 9])
  })

  it('translates a derived point member as its whole entity', () => {
    // An arc start is center + radius at an angle, so there is no pair to add a
    // delta to; the applier, the live preview and the fallback preview all move
    // the whole arc for this first version.
    const doc = groupDoc()
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'a1', vertexKey: 'start' },
      { entityId: 'l1', vertexKey: 'edge' },
    ], [2, 1])
    expect(sketch(doc).initial!.a1).toEqual([2, 1, 5, 0, 90])
  })

  it('moves an arc once when both of its derived endpoints are members', () => {
    const doc = groupDoc()
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'a1', vertexKey: 'start' },
      { entityId: 'a1', vertexKey: 'end' },
    ], [2, 1])
    expect(sketch(doc).initial!.a1).toEqual([2, 1, 5, 0, 90])
  })

  it('bakes the solved frame instead of applying the delta on top of it', () => {
    const doc = groupDoc()
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ], [3, -2], {
      l1: [2.5, -1.5, 12.5, -1.5],
      l2: [22.5, 3.5, 32.5, 3.5],
    })
    expect(sketch(doc).initial!.l1).toEqual([2.5, -1.5, 12.5, -1.5])
    expect(sketch(doc).initial!.l2).toEqual([22.5, 3.5, 32.5, 3.5])
  })

  it('refuses an unknown member by name', () => {
    const doc = groupDoc()
    const before = JSON.stringify(doc)
    expect(() => applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'ghost', vertexKey: 'edge' },
    ], [1, 1])).toThrow(MutationRefusal)
    // l1 must not be half-moved by the refused commit.
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('leaves a projected member where the solve pins it', () => {
    // The projected entity's params are held at x0 by the pin mask, so the
    // headline delta path must not translate it and let the next solve pull it
    // back. It is skipped, not refused.
    const doc = groupDoc({
      constraints: [{ id: 'proj1', kind: 'projection', target: '$p1', source: '?edge;x' }],
    })
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'p1', vertexKey: 'edge' },
    ], [3, 1])
    expect(sketch(doc).initial!.l1).toEqual([3, 1, 13, 1])
    expect(sketch(doc).initial!.p1).toEqual([40, 0])
  })

  it('leaves a fixed member where it is in a mixed group', () => {
    const doc = groupDoc({
      constraints: [{ id: 'fix1', kind: 'fixed', target: '$l1' }],
    })
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ], [3, -2])
    expect(sketch(doc).initial!.l1).toEqual([0, 0, 10, 0])
    expect(sketch(doc).initial!.l2).toEqual([23, 3, 33, 3])
  })

  it('moves a duplicate point member once', () => {
    const doc = groupDoc()
    applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'end' },
      { entityId: 'l1', vertexKey: 'end' },
    ], [1, 2])
    expect(sketch(doc).initial!.l1).toEqual([0, 0, 11, 2])
  })

  it('refuses a member the document no longer has before baking the frame', () => {
    // A mid-drag delete leaves the drag state's member list stale. The release
    // and a headless step must agree: both refuse, and no solved frame is baked
    // past the missing member.
    const doc = groupDoc()
    const feature = sketch(doc)
    feature.entities = feature.entities!.filter(e => e.id !== 'l2')
    delete feature.initial!.l2
    const before = JSON.stringify(doc)
    expect(() => applyMoveSketchGroup(doc, 'sk', [
      { entityId: 'l1', vertexKey: 'edge' },
      { entityId: 'l2', vertexKey: 'edge' },
    ], [1, 1], {
      l1: [1, 1, 11, 1],
      l2: [21, 6, 31, 6],
    })).toThrow(MutationRefusal)
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('ignores a non-finite delta without touching the document', () => {
    const doc = groupDoc()
    const before = JSON.stringify(doc)
    applyMoveSketchGroup(doc, 'sk', [{ entityId: 'l1', vertexKey: 'edge' }], [Number.NaN, 0])
    expect(JSON.stringify(doc)).toBe(before)
  })

  it('names the sketch feature it cannot find without throwing', () => {
    const doc = groupDoc()
    const before = JSON.stringify(doc)
    applyMoveSketchGroup(doc, 'nope', [{ entityId: 'l1', vertexKey: 'edge' }], [1, 1])
    expect(JSON.stringify(doc)).toBe(before)
  })
})

describe('single-entity drag on a held entity', () => {
  it('leaves a fixed entity where it is', () => {
    // The live drag preview is frozen for a held entity, so a headless
    // move_entity must not offset the document and leave a dead undo entry.
    const doc = groupDoc({
      constraints: [{ id: 'fix1', kind: 'fixed', target: '$l1' }],
    })
    applyMoveEntity(doc, 'sk', 'l1', [3, 1])
    expect(sketch(doc).initial!.l1).toEqual([0, 0, 10, 0])
    applyMoveEntity(doc, 'sk', 'l2', [3, 1])
    expect(sketch(doc).initial!.l2).toEqual([23, 6, 33, 6])
  })

  it('leaves a projected entity where it is, even with a solved frame', () => {
    const doc = groupDoc({
      constraints: [{ id: 'proj1', kind: 'projection', target: '$p1', source: '?edge;x' }],
    })
    applyMoveEntity(doc, 'sk', 'p1', [3, 1], { p1: [43, 1], l1: [3, 1, 13, 1] })
    // Neither the delta nor the frame is written: the next solve pins it back.
    expect(sketch(doc).initial!.p1).toEqual([40, 0])
    expect(sketch(doc).initial!.l1).toEqual([0, 0, 10, 0])
  })
})

describe('move_sketch_group on the session', () => {
  it('is one undo entry and undo restores every member', () => {
    const doc = groupDoc()
    const { session, cell } = engineFor(doc)
    const result = session.execute({
      type: 'move_sketch_group',
      featureId: 'sk',
      members: [
        { entityId: 'l1', vertexKey: 'edge' },
        { entityId: 'l2', vertexKey: 'start' },
      ],
      delta: [5, 2],
    })
    expect(result.ok).toBe(true)
    expect(session.historyEntries().undo).toHaveLength(1)
    expect(sketch(cell.current!).initial!.l1).toEqual([5, 2, 15, 2])
    expect(sketch(cell.current!).initial!.l2).toEqual([25, 7, 30, 5])

    expect(session.undo()).toBe(true)
    expect(sketch(cell.current!).initial!.l1).toEqual([0, 0, 10, 0])
    expect(sketch(cell.current!).initial!.l2).toEqual([20, 5, 30, 5])
    expect(session.redo()).toBe(true)
    expect(sketch(cell.current!).initial!.l1).toEqual([5, 2, 15, 2])
  })

  it('an unknown member is a refused step that changes nothing', () => {
    const doc = groupDoc()
    const { session, cell } = engineFor(doc)
    // The applier throws a MutationRefusal, which usePartDoc turns into a
    // failure Result; the session clone and the history are left untouched.
    expect(() => session.execute({
      type: 'move_sketch_group',
      featureId: 'sk',
      members: [{ entityId: 'ghost', vertexKey: 'edge' }],
      delta: [1, 1],
    })).toThrow(MutationRefusal)
    expect(session.historyEntries().undo).toHaveLength(0)
    expect(sketch(cell.current!).initial!.l1).toEqual([0, 0, 10, 0])
  })
})
