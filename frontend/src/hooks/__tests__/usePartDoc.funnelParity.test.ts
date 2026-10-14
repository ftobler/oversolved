import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'

import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'
import { docRef, reSolve, renameTo, resetHarness } from './usePartDoc.undoHarness'
import { useEditorState } from '@/hooks/useEditorState'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// Both funnels share one body (handler loop, rollback mirror, prune, the
// preview/session/withhold branch, the re-solve). A single mutation sent through
// handleMutation and the same mutation as a one-element group through
// commitMutationGroup must leave the same observable state. The solve options
// are the one deliberate difference: handleMutation computes the drag-anchor
// options, the group always passes its own fixed set.
interface Observed {
  doc: PartDoc
  undo: { type: string; doc: PartDoc }[]
  redoLength: number
  dirty: boolean
  solveDoc: PartDoc | undefined
  solveOpts: Record<string, unknown> | undefined
}

function runSingle(m: Mutation, setup: () => void = () => {}): Observed {
  resetHarness()
  setup()
  useUnsavedChangesStore.getState().setDirty(false)
  reSolve.mockClear()
  const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  act(() => { result.current.handleMutation(m) })
  return observe(result.current)
}

function runGroup(m: Mutation, setup: () => void = () => {}): Observed {
  resetHarness()
  setup()
  useUnsavedChangesStore.getState().setDirty(false)
  reSolve.mockClear()
  const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  act(() => { result.current.commitMutationGroup([m]) })
  return observe(result.current)
}

function observe(hook: ReturnType<typeof usePartDoc>): Observed {
  const call = reSolve.mock.calls[0] as [PartDoc, Record<string, unknown>] | undefined
  return {
    doc: structuredClone(docRef.current),
    undo: hook.undoStack.map(e => ({ type: e.mutation.type, doc: structuredClone(e.doc) })),
    redoLength: hook.redoStack.length,
    dirty: useUnsavedChangesStore.getState().dirty,
    solveDoc: call ? structuredClone(call[0]) : undefined,
    solveOpts: call?.[1],
  }
}

describe('usePartDoc funnel parity: single mutation vs one-element group', () => {
  beforeEach(resetHarness)

  it('a pushing rename leaves the same doc, undo stack, dirty flag and solve doc', () => {
    const single = runSingle(renameTo('second'))
    const group = runGroup(renameTo('second'))

    expect(single.doc).toEqual(group.doc)
    expect(single.undo).toEqual(group.undo)
    expect(single.undo).toHaveLength(1)
    expect(single.redoLength).toBe(group.redoLength)
    expect(single.dirty).toBe(true)
    expect(group.dirty).toBe(true)
    expect(single.solveDoc).toEqual(group.solveDoc)
    expect(single.solveOpts?._suppressFirstSolve).toBe(true)
    expect(group.solveOpts?._suppressFirstSolve).toBe(true)
  })

  it('a no-op rename pushes nothing and neither dirties nor re-solves on either path', () => {
    const single = runSingle(renameTo('first'))
    const group = runGroup(renameTo('first'))

    expect(single.undo).toEqual([])
    expect(group.undo).toEqual([])
    expect(single.dirty).toBe(false)
    expect(group.dirty).toBe(false)
    expect(single.solveDoc).toBeUndefined()
    expect(group.solveDoc).toBeUndefined()
  })

  it('a mutation swallowed by a suppressed session leaves the same state on either path', () => {
    const runInSession = (inSession: (hook: ReturnType<typeof usePartDoc>) => void) => {
      resetHarness()
      useEditorState.getState().setEditingFeatureId('extrude-1')
      useUnsavedChangesStore.getState().setDirty(false)
      reSolve.mockClear()
      const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
      act(() => { result.current.startEditSession(true) })
      act(() => { inSession(result.current) })
      return observe(result.current)
    }
    const single = runInSession(hook => hook.handleMutation(renameTo('in-edit')))
    const group = runInSession(hook => hook.commitMutationGroup([renameTo('in-edit')]))

    expect(single.doc).toEqual(group.doc)
    expect(single.undo).toEqual(group.undo)
    expect(single.undo).toHaveLength(0)
    expect(single.dirty).toBe(group.dirty)
    expect(single.solveDoc).toEqual(group.solveDoc)
  })
})
