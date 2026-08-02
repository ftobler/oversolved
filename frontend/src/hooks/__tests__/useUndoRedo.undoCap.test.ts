import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import type { PartDoc, Mutation } from '@/types/cad'

// The cap lives in its own module specifically so a test can shrink it: with
// MAX_UNDO_DEPTH at 50 a `redo.length <= 50` assertion is vacuous (it also
// passes for an empty stack). At 3 the cap is observable.
vi.mock('@/config/undoConfig', () => ({ MAX_UNDO_DEPTH: 3 }))

const makeDoc = (id: string): PartDoc =>
  ({ version: 1, kind: 'part', features: [{ id, kind: 'sketch' }] }) as PartDoc

describe('useUndoRedo capped history', () => {
  it('round-trips repeatedly without either stack exceeding the depth', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn((d: React.SetStateAction<PartDoc | null>) => { docRef.current = d as PartDoc })
    const { result } = renderHookStrict(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, vi.fn()))

    for (let i = 0; i < 8; i++) {
      act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, makeDoc(`f${i}`)) })
    }
    // Only the newest 3 of the 8 pushes survive the undo cap.
    expect(result.current.undoStack).toHaveLength(3)

    // Undo everything: the redo branch absorbs exactly the capped stack.
    for (let i = 0; i < 8; i++) act(() => { result.current.handleUndo() })
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(3)

    // Redo everything: undo rebuilds to the cap and redo drains.
    for (let i = 0; i < 8; i++) act(() => { result.current.handleRedo() })
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(3)

    // The counterpart push on every undo/redo is capped too, so repeated
    // round-tripping can never grow a stack past the depth.
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 3; j++) act(() => { result.current.handleUndo() })
      for (let j = 0; j < 3; j++) act(() => { result.current.handleRedo() })
      expect(result.current.undoStack.length).toBeLessThanOrEqual(3)
      expect(result.current.redoStack.length).toBeLessThanOrEqual(3)
    }
  })
})
