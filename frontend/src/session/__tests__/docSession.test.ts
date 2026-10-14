// @vitest-environment node
// The DocSession core, headless: no React, no stores, no workers. The frozen
// history-behaviour rows the session owns are transcribed here (prefixed with
// their row id); the transaction rows land with the transactions phase.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createDocSession,
  clampRollbackPosition,
  type DocSession,
  type DocSessionDeps,
  type EditorFacts,
  type SessionEvent,
} from '@/session/DocSession'
import { hashSavedText } from '@/session/dirty'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import type { PartDoc, Mutation } from '@/types/cad'
import { createFakeSolveScheduler, type FakeSolveScheduler } from './fakeSolveScheduler'

// The session's failLoud is mocked with a controllable implementation: the
// default makes the guards throw (the real test-mode behaviour), a no-op
// emulates production so the error Result paths are observable.
const { failLoudMock } = vi.hoisted(() => ({ failLoudMock: vi.fn() }))

vi.mock('@/utils/invariants', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/invariants')>()
  return { ...actual, failLoud: failLoudMock }
})

const baseDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
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
    { id: 'f2', kind: 'extrude' },
    { id: 'f3', kind: 'fillet' },
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
}

function makeSession(doc: PartDoc | null = baseDoc(), overrides: Partial<DocSessionDeps> = {}): Harness {
  const solve = createFakeSolveScheduler<PartDoc>()
  const facts: EditorFacts = { editingFeatureId: null, rollbackPosition: null }
  const session = createDocSession(doc, {
    cloneDoc: source => structuredClone(source),
    solve,
    editorFacts: () => facts,
    ...overrides,
  })
  return { session, solve, facts }
}

beforeEach(() => {
  failLoudMock.mockReset()
  failLoudMock.mockImplementation((message: string) => { throw new Error(message) })
})

describe('execute', () => {
  it('lands a real mutation as one labelled entry, dirty, with an edit re-solve', () => {
    const { session, solve } = makeSession()
    const result = session.execute(rename('a'))

    expect(result).toEqual({ ok: true, createdIds: [] })
    expect(labelOf(session.getDoc())).toBe('a')
    expect(session.inspect().history).toEqual({ undo: ['rename extrude-1 to a'], redo: [] })
    expect(session.inspect().dirty).toBe(true)
    expect(solve.calls).toHaveLength(1)
    expect(solve.calls[0].doc).toEqual(session.getDoc())
    expect(solve.calls[0].opts).toEqual({ bypassCache: false, _suppressFirstSolve: true })
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

    const minted = session.getDoc()?.features?.[0]?.constraints?.[0]?.id
    expect(minted).toBeDefined()
    expect(result).toEqual({ ok: true, createdIds: [minted] })
  })

  it('executeGroup reports every id the group created', () => {
    const { session } = makeSession(pointSketchDoc())
    const result = session.executeGroup([
      { type: 'add_entity', featureId: 'sk1', kind: 'point', params: [5, 5], entityId: 'pt1' },
      { type: 'add_constraint', featureId: 'sk1', kind: 'length', targets: ['entity:sk1:pt1'], value: 10 },
    ])

    const minted = session.getDoc()?.features?.[0]?.constraints?.[0]?.id
    expect(result).toEqual({ ok: true, createdIds: ['pt1', minted] })
  })

  it('fails loud and records a diagnostic when there is no document', () => {
    const { session } = makeSession(null)

    expect(() => session.execute(rename('a'))).toThrow(/no document/)
    expect(session.diagnostics()).toEqual([
      { code: 'no-document', message: expect.stringContaining('no document') },
    ])
  })

  it('returns the error Result instead of throwing outside test mode', () => {
    failLoudMock.mockImplementation(() => {})
    const { session } = makeSession(null)

    expect(session.execute(rename('a'))).toEqual({
      ok: false, code: 'no-document', message: expect.any(String),
    })
    expect(session.diagnostics().map(d => d.code)).toEqual(['no-document'])
  })

  it('refuses an unknown mutation type as an error Result', () => {
    failLoudMock.mockImplementation(() => {})
    const { session, solve } = makeSession()

    const result = session.execute({ type: 'no_such_mutation' } as unknown as Mutation)

    expect(result).toEqual({
      ok: false, code: 'unknown-mutation', message: expect.any(String),
    })
    expect(session.diagnostics().map(d => d.code)).toEqual(['unknown-mutation'])
    expect(solve.calls).toHaveLength(0)
  })
})

describe('the no-op guard', () => {
  it('N01: a same-value setter is a dead step', () => {
    const { session, solve } = makeSession()

    expect(session.execute(rename('first'))).toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.inspect().dirty).toBe(false)
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
    expect(session.inspect().dirty).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N03: an unresolvable add_constraint is a dead step', () => {
    const { session, solve } = makeSession(pointSketchDoc())

    expect(session.execute({
      type: 'add_constraint', featureId: 'sk1', kind: 'coincident', targets: ['dock:sk1:noSuchHost'],
    })).toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.inspect().dirty).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N03: a delete naming an absent entity is a dead step', () => {
    const { session, solve } = makeSession(pointSketchDoc())

    expect(session.execute({ type: 'delete', targets: ['entity:sk1:ghost'] }))
      .toEqual({ ok: true, createdIds: [] })
    expect(session.inspect().history.undo).toEqual([])
    expect(session.inspect().dirty).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('N04: a deliberately unguarded no-op still lands its entry', () => {
    const { session, solve } = makeSession()

    session.execute({ type: 'delete_feature', featureId: 'ghost' })

    expect(session.inspect().history.undo).toEqual(['delete feature ghost'])
    expect(session.inspect().dirty).toBe(true)
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
    expect(session.inspect().dirty).toBe(false)
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
    session.subscribe(event => events.push(event))

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
    expect(session.inspect().dirty).toBe(true)
    expect(events).toEqual([{
      type: 'historyRestored',
      direction: 'undo',
      entry: { label: 'rename extrude-1 to b', doc: afterFirst },
    }])
    // H11: the restored doc is re-solved, with no edit suppression.
    expect(solve.calls.at(-1)?.doc).toEqual(afterFirst)
    expect(solve.calls.at(-1)?.opts).toEqual({})

    expect(session.redo()).toBe(true)
    expect(session.getDoc()).toEqual(afterSecond)
    expect(events[1]).toEqual({
      type: 'historyRestored',
      direction: 'redo',
      entry: { label: 'rename extrude-1 to b', doc: afterSecond },
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
    expect(session.inspect().dirty).toBe(false)
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
    const listener = vi.fn()
    session.subscribe(listener)

    session.execute(rename('a'))

    expect(listener).not.toHaveBeenCalled()
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

  it('R04: set_rollback without a pre-synced store fails loud in test mode', () => {
    const { session, solve } = makeSession(rollbackDoc())

    expect(() => session.execute({ type: 'set_rollback', position: 2 }))
      .toThrow(/not pre-synced/)
    expect(session.inspect().history.undo).toEqual([])
    expect(session.inspect().dirty).toBe(false)
    expect(solve.calls).toHaveLength(0)
  })

  it('R04 in prod: the unguarded dispatch lands and mirrors the store', () => {
    failLoudMock.mockImplementation(() => {})
    const { session } = makeSession(rollbackDoc())

    expect(session.execute({ type: 'set_rollback', position: 2 }).ok).toBe(true)
    // The store was never pre-synced, so the mirror writes the absent position.
    expect(session.getDoc()?.rollback).toBeUndefined()
    expect(session.inspect().history.undo).toEqual(['move rollback to 2'])
  })
})

describe('the dirty pin and restore', () => {
  it('D01: restoring a session that pinned a clean doc clears the flag again', () => {
    const { session } = makeSession()
    const pin = session.pinDirty()

    session.execute(rename('a'))
    expect(session.inspect().dirty).toBe(true)

    session.reconcileDirtyAfterRewind(pin, true, () => 'baseline')
    expect(session.inspect().dirty).toBe(false)
  })

  it('D02: a session pinned on a dirty doc restores dirty', () => {
    const { session } = makeSession()
    session.execute(rename('a'))
    const pin = session.pinDirty()

    session.execute(rename('b'))
    session.reconcileDirtyAfterRewind(pin, true, () => 'baseline')

    expect(session.inspect().dirty).toBe(true)
  })

  it('D03: a save landing mid-session without a fingerprint leaves the rewind dirty', () => {
    const { session } = makeSession()
    const pin = session.pinDirty()

    session.execute(rename('a'))
    session.markSaved()
    session.reconcileDirtyAfterRewind(pin, true, () => 'baseline')

    expect(session.inspect().dirty).toBe(true)
  })

  it('D06: a published fingerprint reconciles the rewind by content', () => {
    const { session } = makeSession()
    const pin = session.pinDirty()

    session.execute(rename('a'))
    session.markSaved(hashSavedText('baseline'))
    session.reconcileDirtyAfterRewind(pin, true, () => 'baseline')

    expect(session.inspect().dirty).toBe(false)
  })

  it('D06: a fingerprint that does not match the restored content leaves it dirty', () => {
    const { session } = makeSession()
    const pin = session.pinDirty()

    session.execute(rename('a'))
    session.markSaved(hashSavedText('stored bytes'))
    session.reconcileDirtyAfterRewind(pin, true, () => 'restored bytes')

    expect(session.inspect().dirty).toBe(true)
  })

  it('D04: a session that netted to zero commits clean without serializing', () => {
    const { session } = makeSession()
    const pin = session.pinDirty()

    session.execute(rename('a'))
    session.execute(rename('first'))
    const serialize = vi.fn(() => 'anything')
    session.reconcileDirtyAfterRewind(pin, false, serialize)

    expect(session.inspect().dirty).toBe(false)
    expect(serialize).not.toHaveBeenCalled()
  })

  it('a new document drops the flag, the count and the fingerprint', () => {
    const { session } = makeSession()
    session.execute(rename('a'))
    session.markSaved(hashSavedText('stored bytes'))

    session.clearForNewDocument()

    expect(session.inspect().dirty).toBe(false)
    expect(session.pinDirty()).toEqual({ dirty: false, saves: 0 })
  })
})

describe('inspect', () => {
  it('returns the L1-owned JSON with an empty transaction list', () => {
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
