// @vitest-environment node
// The part undo engine's direct suite, ported from the deleted useUndoRedo
// hook: the same assertions now run against the session's History and the doc
// port. The hook suites (usePartDoc.*) pin the adapter over these semantics.
// MAX_UNDO_DEPTH is mocked down so the cap is observable with a small stack.
import { describe, it, expect, vi } from 'vitest'
import { createDocSession, type DocSession, type EditorFacts } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import type { PartDoc, SketchData } from '@/types/cad'
import { createFakeSolveScheduler } from './fakeSolveScheduler'

vi.mock('@/config/undoConfig', () => ({ MAX_UNDO_DEPTH: 3 }))

const makeDoc = (id: string): PartDoc =>
  ({ version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] }) as PartDoc

const idOf = (doc: PartDoc | null) => doc?.features?.[0]?.id ?? ''

interface Engine {
  session: DocSession
  cell: { current: PartDoc | null }
  solve: ReturnType<typeof createFakeSolveScheduler<PartDoc>>
  facts: EditorFacts
  dirty: DirtyFacts
}

function makeEngine(doc: PartDoc | null = null): Engine {
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
  return { session, cell, solve, facts, dirty }
}

const undoIds = (e: Engine) => e.session.historyEntries().undo.map(entry => idOf(entry.doc))
const redoIds = (e: Engine) => e.session.historyEntries().redo.map(entry => idOf(entry.doc))
const undoLabels = (e: Engine) => e.session.historyEntries().undo.map(entry => entry.label)

describe('the session undo engine', () => {
  it('a push adds to the undo stack and clears the redo stack', () => {
    const e = makeEngine(makeDoc('live'))
    e.session.pushUndo('one', makeDoc('a'))
    e.session.pushUndo('two', makeDoc('b'))

    expect(undoLabels(e)).toEqual(['one', 'two'])
    expect(redoIds(e)).toEqual([])
  })

  it('undo restores the previous doc and re-solves it', () => {
    const e = makeEngine(makeDoc('b'))
    e.session.pushUndo('one', makeDoc('a'))

    expect(e.session.undo()).toBe(true)

    expect(e.cell.current).toEqual(makeDoc('a'))
    expect(e.solve.calls.at(-1)?.doc).toEqual(makeDoc('a'))
    expect(undoIds(e)).toEqual([])
    expect(redoIds(e)).toEqual(['b'])
    // The counterpart holds a snapshot of the departing doc, not a reference.
    expect(e.session.historyEntries().redo[0].doc).not.toBe(e.cell.current)
  })

  it('redo restores the departing doc', () => {
    const e = makeEngine(makeDoc('b'))
    e.session.pushUndo('one', makeDoc('a'))
    e.session.undo()

    expect(e.session.redo()).toBe(true)

    expect(e.cell.current).toEqual(makeDoc('b'))
    expect(redoIds(e)).toEqual([])
    expect(undoIds(e)).toEqual(['a'])
  })

  it('undo plus redo round-trips the document', () => {
    const e = makeEngine(makeDoc('b'))
    e.session.pushUndo('one', makeDoc('a'))

    e.session.undo()
    expect(e.cell.current).toEqual(makeDoc('a'))
    e.session.redo()
    expect(e.cell.current).toEqual(makeDoc('b'))
  })

  it('a push after an undo clears the redo branch', () => {
    const e = makeEngine(makeDoc('b'))
    e.session.pushUndo('one', makeDoc('a'))
    e.session.undo()
    expect(redoIds(e)).toEqual(['b'])

    e.session.pushUndo('two', e.cell.current ?? makeDoc('live'))

    expect(redoIds(e)).toEqual([])
  })

  it('enforces the cap and drops the oldest entries', () => {
    const e = makeEngine(makeDoc('live'))
    for (let i = 0; i < 8; i++) e.session.pushUndo(`f${i}`, makeDoc(`f${i}`))

    expect(undoIds(e)).toEqual(['f5', 'f6', 'f7'])

    // Undo everything: the redo branch absorbs exactly the capped stack.
    for (let i = 0; i < 8; i++) e.session.undo()
    expect(undoIds(e)).toEqual([])
    expect(redoIds(e)).toHaveLength(3)
    expect(undoIds(e).length + redoIds(e).length).toBeLessThanOrEqual(MAX_UNDO_DEPTH)

    // Redo everything: undo rebuilds to the cap and redo drains.
    for (let i = 0; i < 8; i++) e.session.redo()
    expect(redoIds(e)).toEqual([])
    expect(undoIds(e)).toHaveLength(3)
    expect(undoIds(e).length + redoIds(e).length).toBeLessThanOrEqual(MAX_UNDO_DEPTH)

    // Repeated round-tripping conserves the total.
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) e.session.undo()
      for (let j = 0; j < 3; j++) e.session.redo()
      expect(undoIds(e).length + redoIds(e).length).toBeLessThanOrEqual(MAX_UNDO_DEPTH)
    }
  })

  it('with no live document, undo and redo are no-ops that leave the stacks paired', () => {
    const e = makeEngine(makeDoc('live'))
    e.session.pushUndo('one', makeDoc('a'))

    e.cell.current = null
    expect(e.session.undo()).toBe(false)
    expect(undoIds(e)).toEqual(['a'])
    expect(redoIds(e)).toEqual([])

    e.cell.current = makeDoc('post')
    expect(e.session.undo()).toBe(true)
    expect(redoIds(e)).toHaveLength(1)

    e.cell.current = null
    expect(e.session.redo()).toBe(false)
    expect(undoIds(e)).toEqual([])
    expect(redoIds(e)).toHaveLength(1)
  })

  it('undo and redo on an empty stack are inert', () => {
    const e = makeEngine(makeDoc('live'))
    expect(e.session.undo()).toBe(false)
    expect(e.session.redo()).toBe(false)
    expect(e.solve.calls).toHaveLength(0)
  })

  it('a move shifts exactly one entry, keeping the total constant', () => {
    const e = makeEngine(makeDoc('live'))
    for (let i = 0; i < 3; i++) e.session.pushUndo(`f${i}`, makeDoc(`f${i}`))

    const total = undoIds(e).length + redoIds(e).length
    for (let i = 0; i < 5; i++) {
      e.session.undo()
      e.session.redo()
      expect(undoIds(e).length + redoIds(e).length).toBe(total)
    }
  })

  it('push stores a clone, so mutating the source doc later cannot corrupt the entry', () => {
    const e = makeEngine(makeDoc('live'))
    const source = makeDoc('source')
    e.session.pushUndo('one', source)

    source.features![0].id = 'corrupted'

    expect(undoIds(e)).toEqual(['source'])
  })

  it('undo pairs a clone of the departing doc onto the redo stack', () => {
    const departing = makeDoc('b')
    const e = makeEngine(departing)
    e.session.pushUndo('one', makeDoc('a'))

    e.session.undo()

    // The counterpart captured the departing doc by value; a later mutation of
    // that object cannot change what the redo restores.
    expect(e.session.historyEntries().redo[0].doc).not.toBe(departing)
    departing.features![0].id = 'corrupted'
    e.session.redo()
    expect(e.cell.current).toEqual(makeDoc('b'))
  })

  it('undo and redo set the session dirty', () => {
    const e = makeEngine(makeDoc('b'))
    e.session.pushUndo('one', makeDoc('a'))

    e.session.undo()
    expect(e.session.isDirty()).toBe(true)

    e.dirty.dirty = false
    e.session.noteSaved()
    e.session.redo()
    expect(e.session.isDirty()).toBe(true)
  })

  it('an undo while a session is open drops the session and its parked snapshot', () => {
    const e = makeEngine(makeDoc('a'))
    // A sketch session pushes one entry per action, so the undo has real work
    // to move; the move tears the session down and invalidates its snapshot.
    e.session.begin('edit', { suppressed: false })
    e.session.execute({ type: 'add_sketch', featureId: 'sb', label: 'B' })
    const editId = e.session.transactions()[0].id

    e.session.undo()

    // The parked restore point is dead with the session: a late cancel cannot
    // rewind the stacks to their pre-session contents.
    expect(e.session.cancel(editId)).toEqual({
      ok: false, code: 'unknown-transaction', message: expect.any(String),
    })
    expect(idOf(e.cell.current)).toBe('a')
    expect(undoIds(e)).toEqual([])
  })

  it('a cancel restores its own baseline and consumes the snapshot', () => {
    // The single-slot clobber semantics themselves are pinned in
    // history.test.ts (the session's snapshot IS that slot); this pins the
    // session-level pairing of rewind and restore across two sessions.
    const e = makeEngine(makeDoc('a'))
    const first = e.session.begin('edit', { suppressed: false })
    e.session.execute({ type: 'add_sketch', featureId: 'sb', label: 'B' })
    if (first.ok) e.session.cancel(first.id)
    expect(idOf(e.cell.current)).toBe('a')

    const second = e.session.begin('edit', { suppressed: false })
    e.session.execute({ type: 'add_sketch', featureId: 'sc', label: 'C' })
    if (second.ok) e.session.cancel(second.id)

    expect(idOf(e.cell.current)).toBe('a')
    expect(undoIds(e)).toEqual([])
  })
})
