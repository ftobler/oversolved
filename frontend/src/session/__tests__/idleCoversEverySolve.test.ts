// @vitest-environment node
// The scheduler's pending count is the session's only honest answer to "is a
// solve still running?" idle() resolves when that count hits zero and
// inspect().solve reads it. This suite pins the routes the SESSION owns (its
// own transaction boundaries and undo) and the requestSolve port contract; the
// application wiring that calls into them (load, edit enter/exit, Rebuild,
// Clear cache) is pinned by the page suite Part.solveRoutes.test.tsx.
import { describe, it, expect } from 'vitest'
import { createDocSession, type DocSession } from '@/session/DocSession'
import type { DirtyFacts } from '@/session/dirty'
import type { EditorFacts } from '@/session/DocSession'
import type { PartDoc, SketchData } from '@/types/cad'
import { makeDoc, makeSketch } from '@/utils/core/testFixture'
import { createFakeSolveScheduler } from './fakeSolveScheduler'

function heldSession(doc: PartDoc | null = makeDoc(makeSketch('sk1'))) {
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
  return { session, solve }
}

// The solve is in flight right now: pending/running read it, and idle() has not
// resolved. Flushing the held request is what lets the same idle() settle.
async function expectHeldUntilSettled(session: DocSession, flush: () => void): Promise<void> {
  expect(session.inspect().solve.pending).toBe(true)
  expect(session.inspect().solve.running).toBe(true)
  let idleSettled = false
  const idling = session.idle().then(() => { idleSettled = true })
  await Promise.resolve()
  expect(idleSettled).toBe(false)

  flush()
  await idling
  expect(session.inspect().solve.pending).toBe(false)
}

describe('the session requestSolve port', () => {
  it('keeps the caller options and reports the request as pending until it settles', async () => {
    const h = heldSession()
    h.session.requestSolve({ bypassCache: true, validate: true })
    await expectHeldUntilSettled(h.session, h.solve.flush)

    expect(h.solve.calls.map(call => call.opts)).toEqual([{ bypassCache: true, validate: true }])
  })

  it('is null and schedules nothing with no document open', async () => {
    const h = heldSession(null)
    expect(h.session.requestSolve()).toBeNull()
    expect(h.session.inspect().solve.pending).toBe(false)
    expect(h.solve.calls).toEqual([])
    await expect(h.session.idle()).resolves.toBeUndefined()
  })

  it('refreshSolve is the same port with no options', async () => {
    const h = heldSession()
    h.session.refreshSolve()
    await expectHeldUntilSettled(h.session, h.solve.flush)
    expect(h.solve.calls.map(call => call.opts)).toEqual([{}])
  })
})

// The session owns these solves: they are its own transaction and history
// boundaries, so they cannot be moved into a caller and must stay counted.
describe('idle covers the solves the session starts', () => {
  it('covers an edit-exit solve', async () => {
    const h = heldSession()
    const opened = h.session.begin('edit', { suppressed: true })
    if (!opened.ok) throw new Error('edit session refused')
    h.session.cancel(opened.id)
    await expectHeldUntilSettled(h.session, h.solve.flush)
  })

  it('covers a preview cancel solve', async () => {
    const h = heldSession()
    const opened = h.session.begin('preview')
    if (!opened.ok) throw new Error('preview refused')
    h.session.cancel(opened.id)
    await expectHeldUntilSettled(h.session, h.solve.flush)
  })

  it('covers the undo re-solve', async () => {
    const h = heldSession()
    h.session.execute({ type: 'rename_feature', featureId: 'sk1', label: 'a' })
    h.solve.flush()
    await Promise.resolve()
    h.session.undo()
    await expectHeldUntilSettled(h.session, h.solve.flush)
  })
})
