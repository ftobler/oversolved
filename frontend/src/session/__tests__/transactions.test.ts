// @vitest-environment node
// The transaction model: one stack of typed transactions replaces the hook's
// tagged open-work slot. The scopes (preview swallow/escape, suppressed-session
// swallow, brep arm and steal) and the boundary rules are transcribed from the
// frozen behaviour table; the full WP0 transcript rows run in
// sessionTranscript.test.ts.
import { describe, it, expect } from 'vitest'
import { createDocSession, type DocSession, type DocSessionDeps, type EditorFacts } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { createFakeSolveScheduler, type FakeSolveScheduler } from './fakeSolveScheduler'

const extrudeDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
})

const colorDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
})

const bareSketchDoc = (): PartDoc => makeDoc(makeSketch('sk1'))

const pointSketchDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [{ id: 'l1', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0] },
}))

const rename = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'extrude-1', label })

const renameSketch = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'sk1', label })

const setColor = (color: string): Mutation =>
  ({ type: 'set_part_color', bodyId: 'b1', color })

const projectedEdge = (entityId: string): Mutation =>
  ({ type: 'add_projected_entity', featureId: 'sk1', kind: 'line', source: '?a:1', entityId })

const lengthConstraint = (target: string): Mutation =>
  ({ type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: [target], value: 10 })

const addPoint = (entityId: string, params: [number, number]): Mutation =>
  ({ type: 'add_entity', featureId: 'sk1', kind: 'point', params, entityId })

const entitiesOf = (doc: PartDoc | null) =>
  (doc?.features?.[0] as { entities?: unknown[] } | undefined)?.entities ?? []

const constraintsOf = (doc: PartDoc | null) =>
  (doc?.features?.[0] as { constraints?: unknown[] } | undefined)?.constraints ?? []

const colorOf = (doc: PartDoc | null) =>
  (doc?.part_style?.b1 as { color?: string } | undefined)?.color

interface Harness {
  session: DocSession
  solve: FakeSolveScheduler<PartDoc>
  facts: EditorFacts
  dirty: DirtyFacts
  doc: { current: PartDoc | null }
  solveResults: { current: Record<string, SketchData> }
  mirrorDirty: () => void
}

function makeSession(doc: PartDoc = extrudeDoc(), overrides: Partial<DocSessionDeps> = {}): Harness {
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
    ...overrides,
  })
  return {
    session,
    solve,
    facts,
    dirty,
    doc: cell,
    solveResults,
    mirrorDirty: () => {
      const decision = session.takeDirtyDecision()
      if (decision !== null) dirty.dirty = decision
    },
  }
}

const openId = (result: { ok: boolean; id?: string }) => result.ok ? (result.id as string) : ''

describe('preview transactions', () => {
  it('P01/P02: scope mutations are swallowed; the commit pushes one composed entry', () => {
    const { session } = makeSession(colorDoc())
    const id = openId(session.begin('preview'))

    session.execute(setColor('#00ff00'))
    session.execute({ type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 })
    expect(session.inspect().history.undo).toEqual([])

    session.commit(id, { mutation: setColor('#00ff00') })

    expect(session.inspect().history.undo).toEqual(['edit b1: color, transparency'])
    expect(colorOf(session.getDoc())).toBe('#00ff00')
    expect(session.transactions()).toEqual([])
  })

  it('P03: committing an untouched preview pushes nothing and leaves the pin alone', () => {
    const { session } = makeSession(colorDoc())
    const id = openId(session.begin('preview'))

    session.commit(id, { mutation: setColor('#ff0000') })

    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
  })

  it('P04: a non-scope mutation escapes and auto-commits the preview first', () => {
    const { session } = makeSession(colorDoc())
    openId(session.begin('preview'))
    session.execute(setColor('#00ff00'))

    session.execute(rename('escaped'))

    expect(session.inspect().history.undo).toEqual([
      'edit b1: color',
      'rename extrude-1 to escaped',
    ])
    expect(colorOf(session.getDoc())).toBe('#00ff00')
    expect(session.transactions()).toEqual([])
  })

  it('P06: cancel rewinds to the baseline and restores the pin', () => {
    const h = makeSession(colorDoc())
    const before = structuredClone(h.session.getDoc())
    const id = openId(h.session.begin('preview'))

    h.session.execute(setColor('#00ff00'))
    h.mirrorDirty()
    h.session.cancel(id)

    expect(h.session.getDoc()).toEqual(before)
    expect(h.session.inspect().history.undo).toEqual([])
    expect(h.session.isDirty()).toBe(false)
  })

  it('P09: with no part_style diff the entry carries the mutation the caller handed', () => {
    const h = makeSession(colorDoc())
    const id = openId(h.session.begin('preview'))
    // An external write (a write-back-shaped doc swap) changes the doc without
    // touching part_style, so the symmetric diff wants an entry but the
    // part_style label diff is empty.
    h.doc.current = { ...(h.doc.current as PartDoc), version: 2 }

    h.session.commit(id, { mutation: setColor('#00ff00') })

    expect(h.session.inspect().history.undo).toEqual(['set b1 color to #00ff00'])
  })

  it('P08: a preview over an edit session is refused with an error Result', () => {
    const { session } = makeSession()
    session.begin('edit', { suppressed: true })

    expect(session.begin('preview')).toEqual({
      ok: false, code: 'preview-over-session', message: expect.any(String),
    })
    expect(session.transactions().map(t => t.kind)).toEqual(['edit'])
  })

  it('a nested preview is refused with an error Result', () => {
    const { session } = makeSession()
    session.begin('preview')

    expect(session.begin('preview')).toEqual({
      ok: false, code: 'preview-already-open', message: expect.any(String),
    })
  })
})

describe('edit sessions', () => {
  it('P07/T18: a preview open at session start resolves with its own entry before the baseline', () => {
    const { session, facts } = makeSession(colorDoc())
    session.begin('preview')
    session.execute(setColor('#00ff00'))
    facts.editingFeatureId = 'extrude-1'

    session.begin('edit', { suppressed: true })
    session.execute(rename('in-session'))
    const editId = session.transactions()[0].id
    session.cancel(editId)

    expect(session.inspect().history.undo).toEqual(['edit b1: color'])
    expect(colorOf(session.getDoc())).toBe('#00ff00')
    expect((session.getDoc()?.features?.[0] as { label?: string }).label).toBe('first')
  })

  it('S03/T10: a suppressed session folds every edit into one aggregate entry', () => {
    const { session, facts } = makeSession()
    facts.editingFeatureId = 'extrude-1'
    session.begin('edit', { suppressed: true })
    session.execute(rename('a'))
    session.execute(rename('b'))
    session.commit(session.transactions()[0].id)

    expect(session.inspect().history.undo).toEqual(['edit extrude-1'])
    expect((session.getDoc()?.features?.[0] as { label?: string }).label).toBe('b')
  })

  it('S05/T11: a sketch session keeps one entry per action and no aggregate', () => {
    const { session } = makeSession()
    session.begin('edit', { suppressed: false })
    session.execute(rename('a'))
    session.execute(rename('b'))
    session.commit(session.transactions()[0].id)

    expect(session.inspect().history.undo).toEqual([
      'rename extrude-1 to a',
      'rename extrude-1 to b',
    ])
  })

  it('S06/T12: cancelling restores the parked redo branch and drops the per-action entries', () => {
    const { session } = makeSession()
    session.execute(rename('a'))
    session.undo()
    session.begin('edit', { suppressed: false })
    session.execute(rename('b'))
    session.cancel(session.transactions()[0].id)

    expect((session.getDoc()?.features?.[0] as { label?: string }).label).toBe('first')
    expect(session.inspect().history).toEqual({ undo: [], redo: ['rename extrude-1 to a'] })
  })

  it('S02: cancel restores the pre-session stacks as one unit with the rewind', () => {
    const { session, facts } = makeSession()
    facts.editingFeatureId = 'extrude-1'
    session.execute(rename('kept'))
    session.begin('edit', { suppressed: true })
    session.execute(rename('discarded'))
    session.cancel(session.transactions()[0].id)

    expect((session.getDoc()?.features?.[0] as { label?: string }).label).toBe('kept')
    expect(session.inspect().history.undo).toEqual(['rename extrude-1 to kept'])
  })

  it('T09: commit clears the snapshot so a later cancel cannot rewind', () => {
    const { session, facts } = makeSession()
    facts.editingFeatureId = 'extrude-1'
    session.begin('edit', { suppressed: true })
    session.execute(rename('committed'))
    session.commit(session.transactions()[0].id)

    // No session is open; cancelling a stale id is an error, not a rewind.
    expect(session.cancel('txn-missing')).toEqual({
      ok: false, code: 'unknown-transaction', message: expect.any(String),
    })
    expect((session.getDoc()?.features?.[0] as { label?: string }).label).toBe('committed')
    expect(session.inspect().history.undo).toEqual(['edit extrude-1'])
  })

  it('S01/S07: the snapshot is taken at session start and consumed by cancel', () => {
    const { session } = makeSession()
    session.execute(rename('before'))
    session.begin('edit', { suppressed: true })
    session.execute(rename('inside'))
    // Swallowed: the aggregate only exists at commit; the snapshot is parked
    // behind the pre-session entry until a cancel restores it.
    expect(session.inspect().history.undo).toEqual(['rename extrude-1 to before'])

    session.cancel(session.transactions()[0].id)

    expect(session.inspect().history.undo).toEqual(['rename extrude-1 to before'])
    expect((session.getDoc()?.features?.[0] as { label?: string }).label).toBe('before')
  })

  it('an edit cancel restores the baseline even when the live doc is null', () => {
    // The old engine's JSON compare read a null live doc as rewound and then
    // installed the baseline anyway; a load failure mid-session must still
    // rewind to the doc the session promised to restore.
    const h = makeSession()
    const opened = h.session.begin('edit', { suppressed: true })
    h.doc.current = null

    if (opened.ok) h.session.cancel(opened.id)

    expect(h.doc.current).toEqual(extrudeDoc())
    expect(h.session.transactions()).toEqual([])
    expect(h.solve.calls.at(-1)?.doc).toEqual(extrudeDoc())
  })

  it('nested edit sessions are refused with an error Result', () => {
    const { session } = makeSession()
    session.begin('edit', { suppressed: true })

    expect(session.begin('edit', { suppressed: false })).toEqual({
      ok: false, code: 'edit-already-open', message: expect.any(String),
    })
    expect(session.transactions()).toHaveLength(1)
  })

  it('closing a session that changed nothing leaves no entry and stays clean', () => {
    const { session } = makeSession()
    session.begin('edit', { suppressed: true })
    session.commit(session.transactions()[0].id)

    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
  })
})

describe('brep withhold', () => {
  it('B01/B02/T20: a pick plus its dimension is one entry and leaves no orphan projection', () => {
    const { session } = makeSession(bareSketchDoc())
    session.begin('brep')
    session.execute(projectedEdge('p1'))
    expect(session.inspect().history.undo).toEqual([])

    session.execute(lengthConstraint('entity:sk1:p1'))
    expect(session.inspect().history.undo).toEqual(['add length constraint in sk1'])
    expect(session.transactions()).toEqual([])

    session.undo()
    expect(entitiesOf(session.getDoc())).toHaveLength(0)
    expect(constraintsOf(session.getDoc())).toHaveLength(0)
  })

  it('B03/T21: a mid-gesture steal owns the projection and later undos stay per step', () => {
    const { session } = makeSession(bareSketchDoc())
    session.begin('brep')
    session.execute(projectedEdge('p1'))
    session.execute(renameSketch('steal'))
    session.execute(lengthConstraint('entity:sk1:p1'))
    session.undo()
    session.undo()

    expect(entitiesOf(session.getDoc())).toHaveLength(1)
    expect(constraintsOf(session.getDoc())).toHaveLength(0)
    expect(session.inspect().history.redo).toEqual([
      'add length constraint in sk1',
      'rename sk1 to steal',
    ])
  })

  it('B04: a non-dimension add_constraint mid-gesture pushes its own entry and clears the withhold', () => {
    const { session } = makeSession(bareSketchDoc())
    session.begin('brep')
    session.execute(projectedEdge('p1'))
    session.execute({ type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:p1'] })

    expect(session.inspect().history.undo).toEqual(['add horizontal constraint in sk1'])
    expect(session.transactions()).toEqual([])
  })

  it('B05/T22: a mid-gesture no-op consumes the arm so the next real edit pushes', () => {
    const { session } = makeSession()
    session.begin('brep')
    session.execute(rename('first'))
    session.execute(rename('second'))

    expect(session.inspect().history.undo).toEqual(['rename extrude-1 to second'])
  })

  it('B06/T23: undo mid-gesture banks only the pending projection', () => {
    const { session } = makeSession(pointSketchDoc())
    session.execute(addPoint('pt1', [1, 2]))
    session.begin('brep')
    session.execute(projectedEdge('p1'))

    session.undo()

    expect(entitiesOf(session.getDoc())).toHaveLength(2)
    expect(session.inspect().history.undo).toEqual(['add point in sk1'])
    expect(session.inspect().history.redo).toEqual(['add projected edge'])
  })

  it('B07/T24: cancelling the arm drops the withhold so later edits push normally', () => {
    const { session } = makeSession()
    const id = openId(session.begin('brep'))
    session.cancel(id)
    session.execute(rename('after'))

    expect(session.inspect().history.undo).toEqual(['rename extrude-1 to after'])
  })

  it('B07: a compensating delete lands without an entry and cancel stays inert', () => {
    const { session } = makeSession(bareSketchDoc())
    session.begin('brep')
    session.execute(projectedEdge('p1'))
    // The cancelled pick's projection is removed by a compensating delete; the
    // page re-arms first so the delete is covered by the arm and records
    // nothing. The earliest captured doc survives the re-arm.
    session.begin('brep')
    session.execute({ type: 'delete', targets: ['entity:sk1:p1'] })
    session.cancel(session.transactions()[0].id)

    expect(entitiesOf(session.getDoc())).toHaveLength(0)
    expect(session.inspect().history.undo).toEqual([])
    expect(session.transactions()).toEqual([])
  })

  it('B08: a grouped projection consumes the arm; the later dimension commit is one entry', () => {
    const { session } = makeSession(bareSketchDoc())
    session.begin('brep')
    session.executeGroup([projectedEdge('p1'), projectedEdge('p2')])
    session.execute(lengthConstraint('entity:sk1:p1'))

    expect(entitiesOf(session.getDoc())).toHaveLength(2)
    expect(session.inspect().history.undo).toEqual(['add length constraint in sk1'])
  })

  it('re-arming a later pick keeps the earliest captured doc', () => {
    const { session } = makeSession(bareSketchDoc())
    session.begin('brep')
    session.execute(projectedEdge('p1'))
    // The second pick in the same gesture re-arms; the commit must still
    // restore the doc from before the FIRST projection.
    session.begin('brep')
    session.execute(projectedEdge('p2'))
    session.execute(lengthConstraint('entity:sk1:p1'))
    session.undo()

    expect(entitiesOf(session.getDoc())).toHaveLength(0)
  })
})

describe('gesture transactions', () => {
  it('folds frames into one entry keyed to the baseline', () => {
    const { session } = makeSession(pointSketchDoc())
    const before = structuredClone(session.getDoc())
    session.begin('gesture')
    session.execute(addPoint('pt1', [5, 5]))
    expect(session.inspect().history.undo).toEqual([])

    session.commit(session.transactions()[0].id)

    expect(session.inspect().history.undo).toEqual(['add point in sk1'])
    session.undo()
    expect(session.getDoc()).toEqual(before)
  })

  it('a cancelled gesture rewinds to the baseline with no entry', () => {
    const { session } = makeSession(pointSketchDoc())
    const before = structuredClone(session.getDoc())
    session.begin('gesture')
    session.execute(addPoint('pt1', [5, 5]))
    session.cancel(session.transactions()[0].id)

    expect(session.getDoc()).toEqual(before)
    expect(session.inspect().history.undo).toEqual([])
  })

  it('a gesture is refused while another transaction is open', () => {
    const { session } = makeSession()
    session.begin('preview')

    expect(session.begin('gesture')).toEqual({
      ok: false, code: 'gesture-already-open', message: expect.any(String),
    })
  })
})

describe('solve-result retention', () => {
  const filletDoc = (): PartDoc => makeDoc(makeSketch('sk1'), {
    id: 'f1', kind: 'fillet', fillet: { edges: ['?e1'], radius: 1 },
  })

  it('prunes a removed feature and hands the snapshot to its own re-solve', () => {
    const h = makeSession(filletDoc())
    const snapshot: SketchData = { solved: {}, projection_errors: ['x'] }
    h.solveResults.current = { f1: snapshot }

    h.session.execute({ type: 'delete_feature', featureId: 'f1' })

    expect(h.solveResults.current).toEqual({})
    expect(h.solve.calls.at(-1)?.opts?._restoreSolveResults).toEqual({ f1: snapshot })
  })

  it('H11: an undo re-solves with the retained snapshot filtered to the entry doc', () => {
    const h = makeSession(filletDoc())
    const snapshot: SketchData = { solved: {}, projection_errors: ['x'] }
    h.solveResults.current = { f1: snapshot }
    h.session.execute({ type: 'delete_feature', featureId: 'f1' })

    h.session.undo()

    expect(h.solve.calls.at(-1)?.opts?._restoreSolveResults).toEqual({ f1: snapshot })
  })

  it('drops the retained snapshot once a solve produced a fresh result for it', () => {
    const h = makeSession(filletDoc())
    h.solveResults.current = { f1: { solved: {}, projection_errors: ['x'] } }
    h.session.execute({ type: 'delete_feature', featureId: 'f1' })

    h.session.clearStashForSolved(['f1'])
    h.session.undo()

    expect(h.solve.calls.at(-1)?.opts?._restoreSolveResults).toBeUndefined()
  })
})
