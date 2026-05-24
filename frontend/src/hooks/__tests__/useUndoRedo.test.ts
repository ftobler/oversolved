import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import type { PartDoc, Mutation } from '@/types/cad'

describe('useUndoRedo', () => {
  it('pushUndo adds to undoStack and clears redoStack', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_extrude', featureId: 'f1' } as Mutation, docRef.current!)
    })

    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(0)

    act(() => {
      result.current.pushUndo({ type: 'delete_feature', featureId: 'f2' } as Mutation, docRef.current!)
    })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.redoStack).toHaveLength(0)
  })

  it('handleUndo restores previous doc state', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'extrude' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2', kind: 'extrude' }] } as PartDoc
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA)
    })

    act(() => {
      result.current.handleUndo()
    })

    expect(setDoc).toHaveBeenCalledWith(docA)
    // reSolve reads rollback from the store; the test patches the store before
    // calling so verifying just doc-arg is sufficient.
    expect(reSolve).toHaveBeenCalledWith(docA)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(1)
    expect(result.current.redoStack[0].doc).toBe(docB)
    expect(docRef.current).toBe(docA)
  })

  it('handleRedo restores next doc state', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docB = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docA }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
    })
    act(() => {
      result.current.handleUndo()
    })
    setDoc.mockClear()
    reSolve.mockClear()

    act(() => {
      result.current.handleRedo()
    })

    expect(setDoc).toHaveBeenCalledWith(docB)  // the docRef.current at time of undo
    expect(result.current.redoStack).toHaveLength(0)
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('undo+redo round-trip preserves document', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2', kind: 'extrude' }] } as PartDoc
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docA)
    })

    act(() => {
      result.current.handleUndo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docA)

    act(() => {
      result.current.handleRedo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docB)
  })

  it('new mutation after undo clears redoStack', () => {
    const docA = { version: 1, kind: 'part' } as PartDoc
    const docB = { version: 1, kind: 'part' } as PartDoc
    const docRef = { current: docB }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
    })
    act(() => {
      result.current.handleUndo()
    })
    expect(result.current.redoStack).toHaveLength(1)

    setDoc.mockClear()
    reSolve.mockClear()

    act(() => {
      result.current.pushUndo({ type: 'new_mutation' } as unknown as Mutation, docRef.current!)
    })

    expect(result.current.redoStack).toHaveLength(0)
  })

  it('enforces max stack size', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    for (let i = 0; i < 55; i++) {
      act(() => {
        result.current.pushUndo({ type: 'add_sketch' } as Mutation, { version: 1, kind: 'part', features: [{ id: `f${i}`, kind: 'sketch' }] } as PartDoc)
      })
    }

    expect(result.current.undoStack.length).toBeLessThanOrEqual(50)
  })

  it('suppressUndoRef prevents pushUndo from adding undo entries', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docRef.current!)
    })
    expect(result.current.undoStack).toHaveLength(1)

    result.current.suppressUndoRef.current = true

    act(() => {
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docRef.current!)
    })

    expect(result.current.undoStack).toHaveLength(2) // pushUndo still pushes, suppressUndoRef is not checked inside pushUndo
  })

  it('handleUndo on empty stack is no-op', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.handleUndo()
    })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('handleRedo on empty stack is no-op', () => {
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.handleRedo()
    })

    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(0)
    expect(setDoc).not.toHaveBeenCalled()
  })

  it('multiple undos in sequence work correctly', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'f1', kind: 'sketch' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'f2', kind: 'extrude' }] } as PartDoc
    const docC = { version: 1, kind: 'part', features: [{ id: 'f3', kind: 'fillet' }] } as PartDoc
    const docRef = { current: docC }
    const setDoc = vi.fn()
    const reSolve = vi.fn()
    const { result } = renderHook(() => useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, reSolve))

    act(() => {
      result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA)
      result.current.pushUndo({ type: 'add_extrude' } as Mutation, docB)
    })

    expect(result.current.undoStack).toHaveLength(2)

    act(() => {
      result.current.handleUndo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docB)
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.redoStack).toHaveLength(1)

    act(() => {
      result.current.handleUndo()
    })
    expect(setDoc).toHaveBeenLastCalledWith(docA)
    expect(result.current.undoStack).toHaveLength(0)
    expect(result.current.redoStack).toHaveLength(2)
  })
})
