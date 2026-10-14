import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { docRef, renameTo, resetHarness } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

// The adapter end-to-end over the session's history: the same three claims the
// deleted useUndoRedo integration suite pinned (one move per keystroke, no
// duplicated redo entries, the cap), observed through the hook's public stacks.
describe('usePartDoc undo/redo integration', () => {
  it('undo then redo does not duplicate redo stack entries', () => {
    resetHarness()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleMutation(renameTo('b')) })

    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)
    expect(result.current.redoStack[0].mutation).toEqual(renameTo('b'))

    act(() => { result.current.handleRedo() })
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(2)
  })

  it('multi-step undo and redo restores the original state', () => {
    resetHarness()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('a')) })
    act(() => { result.current.handleMutation(renameTo('b')) })
    act(() => { result.current.handleMutation(renameTo('c')) })

    for (const label of ['b', 'a', 'first']) {
      act(() => { result.current.handleUndo() })
      expect((docRef.current?.features?.[0] as { label?: string }).label).toBe(label)
    }
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(3)

    for (const label of ['a', 'b', 'c']) {
      act(() => { result.current.handleRedo() })
      expect((docRef.current?.features?.[0] as { label?: string }).label).toBe(label)
    }
    expect(result.current.undoStack).toHaveLength(3)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('the stack limit drops the oldest entries when exceeding max size', () => {
    resetHarness()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    for (let i = 0; i < 55; i++) {
      act(() => { result.current.handleMutation(renameTo(`f${i}`)) })
    }

    // Exact depth plus which end was discarded: a <= 50 bound also holds for an
    // empty stack, so it would pass even if nothing was ever pushed.
    expect(result.current.undoStack).toHaveLength(50)
    expect(result.current.undoStack[0].mutation).toEqual(renameTo('f5'))
    expect(result.current.undoStack[49].mutation).toEqual(renameTo('f54'))
  })

})
