// useUndoRedo.stackSnapshotRef is a SINGLE slot: a second
// saveUndoStackSnapshot silently replaces the first restore point. In
// production the nested-session guards (usePartDoc.startEditSession's
// failLoud-and-return, useEditFeature's one-open-editor rule) keep a second
// save unreachable, so this documents the single-slot semantics rather than a
// nesting guarantee.
import { describe, it, expect, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import type { PartDoc, Mutation } from '@/types/cad'

describe('useUndoRedo stack snapshot single slot', () => {
  it('a second save clobbers the first restore point', () => {
    const docA = { version: 1, kind: 'part', features: [{ id: 'a' }] } as PartDoc
    const docB = { version: 1, kind: 'part', features: [{ id: 'b' }] } as PartDoc
    const docC = { version: 1, kind: 'part', features: [{ id: 'c' }] } as PartDoc
    const docRef = { current: docA }
    const { result } = renderHookStrict(() => useUndoRedo(
      docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn(),
    ))

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA) })
    act(() => { result.current.saveUndoStackSnapshot() })  // S1 = [A]

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docB) })
    act(() => { result.current.saveUndoStackSnapshot() })  // S2 = [A, B], clobbers S1

    act(() => { result.current.pushUndo({ type: 'add_sketch' } as Mutation, docC) })
    expect(result.current.undoStack).toHaveLength(3)

    act(() => { result.current.restoreUndoStackSnapshot() })

    // S2 is the surviving restore point: [A, B], not S1's [A], and not a no-op.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.redoStack).toHaveLength(0)
  })
})
