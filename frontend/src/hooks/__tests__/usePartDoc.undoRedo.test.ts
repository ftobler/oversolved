import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import type { PartDoc, Mutation } from '@/types/cad'

function makeDoc(overrides?: Partial<PartDoc>): PartDoc {
  return { oversolved: 1, kind: 'part', features: [], ...overrides }
}

describe('useUndoRedo integration', () => {
  it('undo then redo does not duplicate redo stack entries', () => {
    const docA = makeDoc({ features: [{ id: 'f1', kind: 'sketch' }] })
    const docB = makeDoc({ features: [{ id: 'f2', kind: 'extrude' }] })
    const docC = makeDoc({ features: [{ id: 'f3', kind: 'fillet' }] })
    const docRef = { current: docC as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve),
    )

    // Push three undo entries
    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA as PartDoc)
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docB as PartDoc)
    })

    // Undo once: goes to docB, redo has docC
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)
    expect(result.current.redoStack[0].doc).toBe(docC)

    // Redo: goes back to docC, undo restored
    act(() => { result.current.handleRedo() })
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(2)
  })

  it('multi-step undo and redo restores original state', () => {
    const docs = ['A', 'B', 'C', 'D'].map(label =>
      makeDoc({ features: [{ id: `f_${label}`, kind: 'sketch' }] }),
    )
    const docRef = { current: docs[3] as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve),
    )

    // Build undo stack: A, B, C (current is D)
    act(() => {
      result.current.pushUndo({ type: 'delete_feature', featureId: 'm1' } as Mutation, docs[0] as PartDoc)
      result.current.pushUndo({ type: 'delete_feature', featureId: 'm2' } as Mutation, docs[1] as PartDoc)
      result.current.pushUndo({ type: 'delete_feature', featureId: 'm3' } as Mutation, docs[2] as PartDoc)
    })

    // Undo three times: D→C→B→A
    act(() => { result.current.handleUndo() })
    expect(setDoc).toHaveBeenLastCalledWith(docs[2])
    act(() => { result.current.handleUndo() })
    expect(setDoc).toHaveBeenLastCalledWith(docs[1])
    act(() => { result.current.handleUndo() })
    expect(setDoc).toHaveBeenLastCalledWith(docs[0])
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(3)

    // Redo three times: A→B→C→D
    act(() => { result.current.handleRedo() })
    expect(setDoc).toHaveBeenLastCalledWith(docs[1])
    act(() => { result.current.handleRedo() })
    expect(setDoc).toHaveBeenLastCalledWith(docs[2])
    act(() => { result.current.handleRedo() })
    expect(setDoc).toHaveBeenLastCalledWith(docs[3])
    expect(result.current.undoStack).toHaveLength(3)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('stack limit drops oldest entries when exceeding max size', () => {
    const docRef = { current: makeDoc() as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve),
    )

    // Push 55 entries (max is 50)
    for (let i = 0; i < 55; i++) {
      act(() => {
        result.current.pushUndo(
          { type: 'add_sketch' } as Mutation,
          makeDoc({ features: [{ id: `f${i}`, kind: 'sketch' }] }) as PartDoc,
        )
      })
    }

    expect(result.current.undoStack.length).toBeLessThanOrEqual(50)
  })
})
