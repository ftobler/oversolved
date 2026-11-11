// @vitest-environment jsdom
//
// The view options menu's unit row is a document edit, so the one thing the
// menu must not get wrong is history: a switch is a single undo entry, and undo
// puts back the document's previous unit (millimetres is the absent field).
// The menu's own no-op guard is pinned in the ViewOptionsButton suite; this
// suite pins the doc path it dispatches into, including a second guard.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { lengthUnitOf } from '@/utils/lengthUnit'
import type { Mutation } from '@/types/cad'
import { docRef, resetHarness } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

const switchUnit = (unit: 'mm' | 'inch'): Mutation => ({ type: 'set_length_unit', unit })

describe('usePartDoc length unit history', () => {
  beforeEach(resetHarness)

  it('records one entry for a switch and undo restores the old unit', () => {
    expect(lengthUnitOf(docRef.current.length_unit)).toBe('mm')
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(switchUnit('inch')) })
    expect(docRef.current.length_unit).toBe('inch')
    expect(result.current.undoStack).toHaveLength(1)
    expect(describeMutation(result.current.undoStack[0].mutation)).toBe('set length unit to inch')

    act(() => { result.current.handleUndo() })
    expect(lengthUnitOf(docRef.current.length_unit)).toBe('mm')
    // Switching back to millimetres is the absence of the field again, so the
    // undone document is byte-identical to a fresh one.
    expect('length_unit' in docRef.current).toBe(false)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
  })

  it('a second switch adds its own entry, so each one undoes separately', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(switchUnit('inch')) })
    act(() => { result.current.handleMutation(switchUnit('mm')) })
    expect(result.current.undoStack).toHaveLength(2)

    act(() => { result.current.handleUndo() })
    expect(docRef.current.length_unit).toBe('inch')
    act(() => { result.current.handleUndo() })
    expect(lengthUnitOf(docRef.current.length_unit)).toBe('mm')
  })

  it('re-asking for the current unit spends no entry', () => {
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(switchUnit('mm')) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect('length_unit' in docRef.current).toBe(false)
  })
})
