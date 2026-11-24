// @vitest-environment node
//
// Undo/redo availability as the table exposes it. The engine decides (the
// session's own floor), and the spec must ask it: a sketch standing on its
// first entry, or a redo branch made only of entries from before the session,
// has to grey the command out rather than offer a keystroke that resolves to
// nothing.
import { describe, it, expect } from 'vitest'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { createDocSession, type DocSession } from '@/session/DocSession'
import type { PartDoc, SketchData } from '@/types/cad'
import { createFakeSolveScheduler } from '@/session/__tests__/fakeSolveScheduler'
import { useEditorState } from '@/hooks/useEditorState'
import { partContext } from './commandFixtures'

const makeDoc = (id = 'a'): PartDoc =>
  ({ version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] }) as PartDoc

function makeSession(): { session: DocSession; cell: { current: PartDoc } } {
  const cell = { current: makeDoc() }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: doc => structuredClone(doc),
    doc: { get: () => cell.current, set: next => { cell.current = next as PartDoc } },
    solve: createFakeSolveScheduler<PartDoc>(),
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: null, rollbackPosition: null }),
    dirtyFacts: () => ({ dirty: false, saves: 0, savedHash: null }),
  })
  return { session, cell }
}

const undoSpec = PART_COMMAND_SPECS.find(spec => spec.id === 'undo')!
const redoSpec = PART_COMMAND_SPECS.find(spec => spec.id === 'redo')!

const undoEnabled = (session: DocSession) => undoSpec.enabled(partContext({ session }))
const redoEnabled = (session: DocSession) => redoSpec.enabled(partContext({ session }))

describe('undo/redo availability from the session', () => {
  it('a sketch at its first entry reports nothing left to undo, and its undone entry is redoable', () => {
    const { session } = makeSession()
    session.begin('edit', { suppressed: false })
    session.execute({ type: 'add_sketch', featureId: 'sb', label: 'B' })
    expect(undoEnabled(session)).toBe(true)
    expect(redoEnabled(session)).toBe('nothing to redo')

    expect(session.undo()).toBe(true)

    // The entry the undo moved is the session's own, so redo is live; nothing
    // of the sketch is left below it.
    expect(undoEnabled(session)).toBe('nothing to undo')
    expect(redoEnabled(session)).toBe(true)

    expect(session.redo()).toBe(true)
    expect(undoEnabled(session)).toBe(true)
    expect(redoEnabled(session)).toBe('nothing to redo')
  })

  it('an open placement is undoable even at the session floor', () => {
    const { session } = makeSession()
    session.begin('edit', { suppressed: false })
    expect(undoEnabled(session)).toBe('nothing to undo')

    useEditorState.setState({ pendingPlacementConstraintId: 'c_placed' })
    try {
      // The press resolves the placement, so the toolbar must not grey it out
      // just because the session floor has nothing else above it.
      expect(undoEnabled(session)).toBe(true)
    } finally {
      useEditorState.setState({ pendingPlacementConstraintId: null })
    }
  })

  it('a redo branch made only of pre-session entries is unavailable inside the session', () => {    const { session } = makeSession()
    session.pushUndo('pre', makeDoc('floor'))
    session.undo()
    expect(redoEnabled(session)).toBe(true)

    session.begin('edit', { suppressed: false })

    expect(undoEnabled(session)).toBe('nothing to undo')
    expect(redoEnabled(session)).toBe('nothing to redo')
  })

  it('with no session open the plain stack lengths decide', () => {
    const { session } = makeSession()
    expect(undoEnabled(session)).toBe('nothing to undo')
    expect(redoEnabled(session)).toBe('nothing to redo')

    session.pushUndo('one', makeDoc('a'))
    expect(undoEnabled(session)).toBe(true)
    expect(redoEnabled(session)).toBe('nothing to redo')

    session.undo()
    expect(undoEnabled(session)).toBe('nothing to undo')
    expect(redoEnabled(session)).toBe(true)
  })
})
