// @vitest-environment node
// The DocSession core, headless: no React, no stores, no workers. The frozen
// history-behaviour rows the session owns are transcribed here; the full
// transcript tables run in sessionTranscript.test.ts and the transaction
// scopes in transactions.test.ts.
import { describe, it, expect, vi } from 'vitest'
import { stringify as stringifyYaml } from 'yaml'
import {
  clampRollbackPosition,
  createDocSession,
  insertFeatureAt,
  type DocSession,
  type DocSessionDeps,
  type EditorFacts,
  type SessionEvent,
} from '@/session/DocSession'
import { hashSavedText, type DirtyFacts } from '@/session/dirty'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { createFakeSolveScheduler, type FakeSolveScheduler } from './fakeSolveScheduler'
import { sketchAt } from '@/testing/featureAccess'

const baseDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first', extrude: { sketch: [], distance: 1 } }],
})

const pointSketchDoc = (): PartDoc => makeDoc(makeSketch('sk1', {
  entities: [{ id: 'l1', kind: 'line' }],
  initial: { l1: [0, 0, 10, 0] },
}))

const rollbackDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  rollback: 2,
  features: [
    { id: 'f1', kind: 'sketch' },
    { id: 'f2', kind: 'extrude', extrude: { sketch: [], distance: 1 } },
    { id: 'f3', kind: 'fillet', fillet: { edges: [], radius: 1 } },
  ],
})

const rename = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'extrude-1', label })

const renameF1 = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'f1', label })

const labelOf = (doc: PartDoc | null) =>
  (doc?.features?.[0] as { label?: string } | undefined)?.label

interface Harness {
  session: DocSession
  solve: FakeSolveScheduler<PartDoc>
  facts: EditorFacts
  dirty: DirtyFacts
  doc: { current: PartDoc | null }
  // Mirrors the adapter's dirty mirror: after a session call, the UI-facing
  // facts carry the session's resolved flag.
  mirrorDirty: () => void
}

function makeSession(doc: PartDoc | null = baseDoc(), overrides: Partial<DocSessionDeps> = {}): Harness {
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
    mirrorDirty: () => {
      const decision = session.takeDirtyDecision()
      if (decision !== null) dirty.dirty = decision
    },
  }
}

describe('insertFeatureAt', () => {
  const docWithBuiltins = () => makeDoc(
    { id: 'Origin', kind: 'origin' },
    { id: 'Top', kind: 'plane' },
    { id: 'f1', kind: 'sketch' },
    { id: 'new', kind: 'sketch' },
  )

  it('never places a user feature above the built-ins', () => {
    const doc = docWithBuiltins()
    insertFeatureAt(doc, 'new', 0)
    expect(doc.features!.map(f => f.id)).toEqual(['Origin', 'Top', 'new', 'f1'])
  })

  it('clamps an index past the end to the last slot', () => {
    const doc = docWithBuiltins()
    insertFeatureAt(doc, 'new', 99)
    expect(doc.features!.map(f => f.id)).toEqual(['Origin', 'Top', 'f1', 'new'])
  })

  it('ignores a non-integer or missing feature instead of splicing', () => {
    const doc = docWithBuiltins()
    insertFeatureAt(doc, 'new', 1.5)
    insertFeatureAt(doc, 'missing', 0)
    expect(doc.features!.map(f => f.id)).toEqual(['Origin', 'Top', 'f1', 'new'])
  })
})

describe('execute', () => {
  it('lands a real mutation as one labelled entry, dirty, with an edit re-solve', () => {
    const { session, solve } = makeSession()
    const result = session.execute(rename('a'))

    expect(result).toEqual({ ok: true, createdIds: [] })
    expect(labelOf(session.getDoc())).toBe('a')
    expect(session.inspect().history).toEqual({ undo: ['rename extrude-1 to a'], redo: [] })
    expect(session.isDirty()).toBe(true)
    expect(solve.calls).toHaveLength(1)
    expect(solve.calls[0].doc).toEqual(session.getDoc())
    expect(solve.calls[0].opts).toEqual({ bypassCache: false, _suppressFirstSolve: true })
  })

  it('inserts a feature add at the slot it names instead of appending', () => {
    const { session } = makeSession(rollbackDoc())

    session.execute({
      type: 'add_fillet', featureId: 'new', label: 'Fillet 2', insertAt: 1,
    })

    expect(session.getDoc()!.features!.map(f => f.id)).toEqual(['f1', 'new', 'f2', 'f3'])
  })

  it('appends a feature add that names no slot', () => {
    const { session } = makeSession(rollbackDoc())

    session.execute({ type: 'add_fillet', featureId: 'new', label: 'Fillet 2' })

    expect(session.getDoc()!.features!.map(f => f.id)).toEqual(['f1', 'f2', 'f3', 'new'])
  })

  it('inserts a plane add through the same slot rule', () => {
    const { session } = makeSession(rollbackDoc())

    session.execute({ type: 'add_plane', featureId: 'plane1', insertAt: 2 })

    expect(session.getDoc()!.features!.map(f => f.id)).toEqual(['f1', 'f2', 'plane1', 'f3'])
  })

  it('a refused insertion leaves the parked bar alone', () => {
    const { session, facts } = makeSession(rollbackDoc())
    facts.rollbackPosition = 3  // staged by the page for a row that never lands

    session.execute({
      type: 'add_extrude', featureId: 'bad', label: 'Bad', sketchQuery: '', distance: NaN, insertAt: 2,
    })

    expect(session.getDoc()!.features!.map(f => f.id)).toEqual(['f1', 'f2', 'f3'])
    expect(session.getDoc()!.rollback).toBe(2)
  })

  it('bars a group just past its inserts after a later mutation deletes an earlier feature', () => {
    // The selection-delete group inserts at the bar and can also delete a
    // feature above it; the bar follows the inserted row, not its old index.
    const { session } = makeSession(rollbackDoc())

    session.executeGroup([
      { type: 'add_fillet', featureId: 'new', insertAt: 2 },
      { type: 'delete_feature', featureId: 'f1' },
    ])

    expect(session.getDoc()!.features!.map(f => f.id)).toEqual(['f2', 'new', 'f3'])
    expect(session.getDoc()!.rollback).toBe(2)
  })

  it('keeps a group of inserts in the order its slots name', () => {
    // The delete-selection path emits one add per target at consecutive slots;
    // the session runs them in array order, so each lands after the last.
    const { session } = makeSession(rollbackDoc())

    session.executeGroup([
      { type: 'add_sketch', featureId: 'a', insertAt: 1 },
      { type: 'add_sketch', featureId: 'b', insertAt: 2 },
    ])

    expect(session.getDoc()!.features!.map(f => f.id)).toEqual(['f1', 'a', 'b', 'f2', 'f3'])
    expect(session.getDoc()!.rollback).toBe(3)
  })

  it('reports the ids a dispatch created', () => {
    const { session } = makeSession(pointSketchDoc())

    expect(session.execute({
      type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, 5], entityId: 'pt1',
    })).toEqual({ ok: true, createdIds: ['pt1'] })

    expect(session.execute({
      type: 'add_extrude', featureId: 'ex1', label: 'Ext', sketchQuery: '@sk1', distance: 10,
    })).toEqual({ ok: true, createdIds: ['ex1'] })
  })

  it('reports the minted id of a created constraint', () => {
    const { session } = makeSession(pointSketchDoc())
    const result = session.execute({
      type: 'add_constraint', featureId: 'sk1', kind: 'horizontal', targets: ['entity:sk1:l1'],
    })

    const minted = sketchAt(session.getDoc()!).constraints?.[0]?.id
    expect(minted).toBeDefined()
    expect(result).toEqual({ ok: true, createdIds: [minted] })
  })

  it('executeGroup reports every id the group created', () => {
    const { session } = makeSession(pointSketchDoc())
    const result = session.executeGroup([
      { type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, 5], entityId: 'pt1' },
      { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:pt1'], value: 10 },
    ])

    const minted = sketchAt(session.getDoc()!).constraints?.[0]?.id
    expect(result).toEqual({ ok: true, createdIds: ['pt1', minted] })
  })

  it('returns an error Result and records a diagnostic when there is no document', () => {
    const { session } = makeSession(null)

    expect(session.execute(rename('a'))).toEqual({
      ok: false, code: 'no-document', message: expect.any(String),
    })
    expect(session.diagnostics()).toEqual([
      { code: 'no-document', message: expect.stringContaining('no document') },
    ])
  })
})

describe('the no-op guard', () => {
  it('N01: a same-value setter is a dead step', () => {
    const { session, solve } = makeSession()

    expect(session.execute(rename('first'))).toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N01: a same-value body-style write is a dead step', () => {
    const { session, solve } = makeSession({
      ...baseDoc(),
      part_style: { b1: { color: '#ff0000' } },
    })

    expect(session.execute({ type: 'set_part_color', bodyId: 'b1', color: '#ff0000' }))
      .toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N03: an unresolvable add_constraint is a dead step', () => {
    const { session, solve } = makeSession(pointSketchDoc())

    expect(session.execute({
      type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['dock:sk1:noSuchHost'],
    })).toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N03: a delete naming an absent entity is a dead step', () => {
    const { session, solve } = makeSession(pointSketchDoc())

    expect(session.execute({ type: 'delete', targets: ['entity:sk1:ghost'] }))
      .toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N04: a deliberately unguarded no-op still lands its entry', () => {
    const { session, solve } = makeSession()

    session.execute({ type: 'delete_feature', featureId: 'ghost' })

    expect(session.inspect().history.undo).toEqual(['delete feature ghost'])
    expect(session.isDirty()).toBe(true)
    expect(solve.calls).toHaveLength(1)
  })

  it('N08: a bare label carrier lands its entry without a doc change', () => {
    const { session } = makeSession()
    const before = structuredClone(session.getDoc())

    session.execute({ type: 'preview_commit', description: 'apply previewed color' })

    expect(session.getDoc()).toEqual(before)
    expect(session.inspect().history.undo).toEqual(['apply previewed color'])
  })
})

describe('executeGroup', () => {
  it('G01: a group is one entry that undo reverts whole', () => {
    const { session } = makeSession(pointSketchDoc())
    const before = structuredClone(session.getDoc())

    session.executeGroup([
      { type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, 5], entityId: 'pt1' },
      { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:pt1'], value: 10 },
    ])

    expect(session.inspect().history.undo).toEqual(['add point in sk1'])
    expect(session.undo()).toBe(true)
    expect(session.getDoc()).toEqual(before)
  })

  it('G02: an all-no-op group pushes nothing and stays clean', () => {
    const { session, solve } = makeSession()

    expect(session.executeGroup([rename('first')])).toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('G03: a one-element group lands the same entry as the single path', () => {
    const single = makeSession()
    single.session.execute(rename('a'))

    const group = makeSession()
    group.session.executeGroup([rename('a')])

    expect(group.session.getDoc()).toEqual(single.session.getDoc())
    expect(group.session.inspect().history).toEqual(single.session.inspect().history)
  })

  it('an empty group is a no-op success', () => {
    const { session, solve } = makeSession()

    expect(session.executeGroup([])).toEqual({ ok: true, createdIds: [] })
    expect(solve.calls).toHaveLength(0)
  })

  it('D06: only the drag family bypasses the solve cache; a group never does', () => {
    const { session, solve } = makeSession(pointSketchDoc())
    session.execute({
      type: 'move_vertex', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 1],
      solvedGeometry: { l1: [1, 1, 10, 0] },
    })
    expect(solve.calls.at(-1)?.opts).toEqual({
      bypassCache: true,
      dragAnchor: { featureId: 'sk1', entityId: 'l1' },
      _suppressFirstSolve: true,
    })

    const grouped = makeSession(pointSketchDoc())
    grouped.session.executeGroup([
      { type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, 5], entityId: 'pt1' },
      { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:pt1'], value: 10 },
    ])
    expect(grouped.solve.calls.at(-1)?.opts).toEqual({ _suppressFirstSolve: true })
  })
})

describe('undo and redo', () => {
  it('H09/H11: undo swaps in the entry doc, crosses the label, dirties, emits and re-solves', () => {
    const { session, solve } = makeSession()
    const events: SessionEvent[] = []
    session.subscribe(event => { if (event.type === 'historyRestored') events.push(event) })

    session.execute(rename('a'))
    const afterFirst = structuredClone(session.getDoc())
    session.execute(rename('b'))
    const afterSecond = structuredClone(session.getDoc())

    expect(session.undo()).toBe(true)

    expect(session.getDoc()).toEqual(afterFirst)
    expect(session.inspect().history).toEqual({
      undo: ['rename extrude-1 to a'],
      redo: ['rename extrude-1 to b'],
    })
    expect(session.isDirty()).toBe(true)
    expect(events).toEqual([{
      type: 'historyRestored',
      direction: 'undo',
      entry: { label: 'rename extrude-1 to b', doc: afterFirst, meta: rename('b') },
    }])
    // H11: the restored doc is re-solved, with no edit suppression.
    expect(solve.calls.at(-1)?.doc).toEqual(afterFirst)
    expect(solve.calls.at(-1)?.opts).toEqual({})

    expect(session.redo()).toBe(true)
    expect(session.getDoc()).toEqual(afterSecond)
    expect(events[1]).toEqual({
      type: 'historyRestored',
      direction: 'redo',
      entry: { label: 'rename extrude-1 to b', doc: afterSecond, meta: rename('b') },
    })
  })

  it('H04/H05: undo and redo on an empty stack are inert', () => {
    const { session, solve } = makeSession()
    const listener = vi.fn()
    session.subscribe(listener)

    expect(session.undo()).toBe(false)
    expect(session.redo()).toBe(false)

    expect(listener).not.toHaveBeenCalled()
    expect(solve.calls).toHaveLength(0)
    expect(session.isDirty()).toBe(false)
  })

  it('H01: a push after an undo clears the redo branch', () => {
    const { session } = makeSession()
    session.execute(rename('a'))
    session.undo()

    session.execute(rename('c'))

    expect(session.inspect().history).toEqual({ undo: ['rename extrude-1 to c'], redo: [] })
  })

  it('execute does not emit a history move', () => {
    const { session } = makeSession()
    const moves = vi.fn()
    session.subscribe(event => { if (event.type === 'historyRestored') moves() })

    session.execute(rename('a'))

    expect(moves).not.toHaveBeenCalled()
  })

  it('unsubscribing stops the events', () => {
    const { session } = makeSession()
    const listener = vi.fn()
    const unsubscribe = session.subscribe(listener)
    unsubscribe()

    session.execute(rename('a'))
    session.undo()

    expect(listener).not.toHaveBeenCalled()
  })
})

describe('the rollback mirror', () => {
  it('R01: writes the store position into the doc when no feature editor is open', () => {
    const { session, facts } = makeSession(rollbackDoc())
    facts.rollbackPosition = 2

    session.execute(renameF1('edited'))

    expect(session.getDoc()?.rollback).toBe(2)
    expect(session.inspect().history.undo).toEqual(['rename f1 to edited'])
  })

  it('R02: skips the mirror while a feature editor is open', () => {
    const { session, facts } = makeSession(rollbackDoc())
    facts.editingFeatureId = 'f2'
    facts.rollbackPosition = 3

    session.execute(renameF1('in-edit'))

    expect(session.getDoc()?.rollback).toBe(2)
  })

  it('R04: set_rollback without a pre-synced store aborts with an error Result', () => {
    const { session, solve } = makeSession(rollbackDoc())

    expect(session.execute({ type: 'set_rollback', position: 2 })).toEqual({
      ok: false, code: 'rollback-unsynced', message: expect.stringContaining('not pre-synced'),
    })
    expect(session.getDoc()?.rollback).toBe(2)
    expect(session.inspect().history.undo).toEqual([])
    expect(session.isDirty()).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('R04: a pre-synced set_rollback lands and pushes its entry', () => {
    const { session, facts } = makeSession(rollbackDoc())
    facts.rollbackPosition = 1

    expect(session.execute({ type: 'set_rollback', position: 1 }).ok).toBe(true)
    expect(session.getDoc()?.rollback).toBe(1)
    expect(session.inspect().history.undo).toEqual(['move rollback to 1'])
  })
})

describe('the dirty pin and restore through a session', () => {
  it('D01: restoring a session that pinned a clean doc clears the flag again', () => {
    const h = makeSession()
    const opened = h.session.begin('edit', { suppressed: true })
    expect(opened.ok).toBe(true)
    h.session.execute(rename('a'))
    h.mirrorDirty()
    expect(h.session.isDirty()).toBe(true)

    if (opened.ok) h.session.cancel(opened.id)

    expect(h.session.isDirty()).toBe(false)
  })

  it('D02: a session pinned on a dirty doc restores dirty', () => {
    const h = makeSession()
    h.session.execute(rename('pre'))
    h.mirrorDirty()

    const opened = h.session.begin('edit', { suppressed: true })
    h.session.execute(rename('a'))
    h.mirrorDirty()
    if (opened.ok) h.session.cancel(opened.id)

    expect(h.session.isDirty()).toBe(true)
  })

  it('D03: a save landing mid-session without a fingerprint leaves the rewind dirty', () => {
    const h = makeSession()
    const opened = h.session.begin('edit', { suppressed: true })
    h.session.execute(rename('a'))
    h.mirrorDirty()

    // The store's markSaved with no fingerprint, then the adapter's note.
    h.dirty.dirty = false
    h.dirty.saves += 1
    h.dirty.savedHash = null
    h.session.noteSaved()

    if (opened.ok) h.session.cancel(opened.id)

    expect(h.session.isDirty()).toBe(true)
  })

  it('D06: a published fingerprint reconciles the rewind by content', () => {
    const h = makeSession()
    const baseline = structuredClone(h.session.getDoc())
    const opened = h.session.begin('edit', { suppressed: true })
    h.session.execute(rename('a'))
    h.mirrorDirty()

    h.dirty.dirty = false
    h.dirty.saves += 1
    h.dirty.savedHash = hashSavedText(stringifyYaml(baseline))
    h.session.noteSaved()

    if (opened.ok) h.session.cancel(opened.id)

    expect(h.session.getDoc()).toEqual(baseline)
    expect(h.session.isDirty()).toBe(false)
  })

  it('D06: a fingerprint that does not match the restored content leaves it dirty', () => {
    const h = makeSession()
    const opened = h.session.begin('edit', { suppressed: true })
    h.session.execute(rename('a'))
    h.mirrorDirty()

    h.dirty.dirty = false
    h.dirty.saves += 1
    h.dirty.savedHash = hashSavedText('stored bytes')
    h.session.noteSaved()

    if (opened.ok) h.session.cancel(opened.id)

    expect(h.session.isDirty()).toBe(true)
  })

  it('D04: a session that netted to zero commits clean without serializing', () => {
    const h = makeSession()
    const opened = h.session.begin('edit', { suppressed: true })
    h.session.execute(rename('a'))
    h.session.execute(rename('first'))
    h.mirrorDirty()

    if (opened.ok) h.session.commit(opened.id)

    expect(h.session.isDirty()).toBe(false)
    expect(h.session.inspect().history.undo).toEqual([])
  })
})

describe('the dirty mirror decision', () => {
  it('offers one decision for a landed edit and none for a no-op', () => {
    const h = makeSession()
    expect(h.session.takeDirtyDecision()).toBeNull()

    h.session.execute(rename('a'))
    expect(h.session.takeDirtyDecision()).toBe(true)
    // Consumed: a second read offers nothing, so a later no-op call cannot
    // re-assert it over an external set.
    expect(h.session.takeDirtyDecision()).toBeNull()

    h.session.execute(rename('a'))
    expect(h.session.takeDirtyDecision()).toBeNull()
  })

  it('offers no decision when a save landed without a fingerprint and the rewind changed nothing', () => {
    const h = makeSession()
    const opened = h.session.begin('edit', { suppressed: true })
    // A save lands with no fingerprint (the store's markSaved() shape).
    h.dirty.dirty = false
    h.dirty.saves += 1
    h.dirty.savedHash = null
    h.session.noteSaved()

    if (opened.ok) h.session.cancel(opened.id)

    // The reconcile decided "leave the flag where the save left it", so the
    // adapter must not write the store at all.
    expect(h.session.takeDirtyDecision()).toBeNull()
    expect(h.dirty.dirty).toBe(false)
  })
})

describe('inspect', () => {
  it('returns the L1-owned JSON with the open transactions', () => {
    const { session } = makeSession()
    session.execute(rename('a'))

    const inspection = session.inspect()

    expect(inspection).toEqual({
      docId: null,
      dirty: true,
      featureCount: 1,
      rollback: null,
      editingFeatureId: null,
      history: { undo: ['rename extrude-1 to a'], redo: [] },
      transactions: [],
      solve: { generation: 1, pending: true, running: true, lastError: null },
    })
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection)
  })

  it('lists open transactions with their kinds', () => {
    const { session } = makeSession()
    const opened = session.begin('preview', {})

    expect(session.inspect().transactions).toEqual([
      { id: opened.ok ? opened.id : '', kind: 'preview' },
    ])
  })

  it('includes docId, validation and bodies when supplied', () => {
    const { session } = makeSession(baseDoc(), {
      docId: 'doc-1',
      getValidation: () => ({ status: 'ok' }),
      getBodies: () => ({ b1: { visible: true } }),
    })

    const inspection = session.inspect()

    expect(inspection.docId).toBe('doc-1')
    expect(inspection.validation).toEqual({ status: 'ok' })
    expect(inspection.bodies).toEqual({ b1: { visible: true } })
    expect(JSON.parse(JSON.stringify(inspection))).toEqual(inspection)
  })

  it('reads editingFeatureId from the injected editor facts', () => {
    const { session, facts } = makeSession()
    facts.editingFeatureId = 'extrude-1'

    expect(session.inspect().editingFeatureId).toBe('extrude-1')
  })

  it('clamps the restored rollback bar to the restored feature list', () => {
    const stale: PartDoc = { ...rollbackDoc(), rollback: 99 }
    expect(clampRollbackPosition(stale)).toBe(3)
    expect(clampRollbackPosition({ ...baseDoc(), rollback: 0 })).toBe(0)
    expect(clampRollbackPosition({ ...baseDoc(), rollback: -3 })).toBe(0)
    expect(clampRollbackPosition(baseDoc())).toBe(1)
    expect(clampRollbackPosition({ features: [] })).toBe(0)
  })
})

describe('idle', () => {
  it('resolves immediately when nothing is pending', async () => {
    const { session } = makeSession()
    await expect(session.idle()).resolves.toBeUndefined()
  })

  it('waits for the pending re-solve', async () => {
    const { session, solve } = makeSession()
    session.execute(rename('a'))

    let settled = false
    const waiting = session.idle().then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)

    solve.flush()
    await waiting
    expect(settled).toBe(true)
  })
})

describe('unknown mutation boundary', () => {
  it('faults in a non-DEV build and records no undo entry or doc change', () => {
    vi.stubEnv('DEV', false)
    try {
      for (const type of ['nope', 'constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
        const { session, doc } = makeSession()
        const before = structuredClone(doc.current)

        // The drive surface can hand untyped JSON to execute; the DEV-only log
        // this used to be is gone, so a production build refuses identically.
        const result = session.execute({ type } as unknown as Mutation)

        expect(result).toMatchObject({ ok: false, code: 'unknown-mutation' })
        expect(doc.current).toEqual(before)
        expect(session.historyEntries().undo).toHaveLength(0)
        expect(session.diagnostics()).toContainEqual(
          expect.objectContaining({ code: 'unknown-mutation' }),
        )
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
