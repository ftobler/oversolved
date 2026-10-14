// The undo tooltip (PartToolbar) renders describeMutation(entry.mutation) for
// every step. usePartDoc resolves a preview or a pending brep projection into a
// label-only preview_commit entry, so the description it pushes IS the text the
// user reads: an internal sentence naming the boundary the resolution happened
// on would show up verbatim in the tooltip. Each case below reaches one of the
// push sites and pins the wording it renders. The old session-commit resolution
// is not among them: a preview can no longer be open when a session commits.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import type { PartDoc, Mutation } from '@/types/cad'
import { docRef, resetHarness, makeSketchDoc } from './usePartDoc.undoHarness'

vi.mock('@/hooks/useDocumentState', async () => {
  const { documentStateMock } = await import('./usePartDoc.undoHarness')
  return documentStateMock()
})

vi.mock('@/hooks/useSolver', async () => {
  const { solverMock } = await import('./usePartDoc.undoHarness')
  return solverMock()
})

type PartDocHook = { current: { setDoc: (d: PartDoc) => void } }

const colorDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  part_style: { b1: { color: '#ff0000' } },
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

// Stands in for the solver write-back: a doc write the preview did not make,
// which is what makes previewWouldPush see something to commit at all. Only that
// a change is there matters here -- the wording under test is the fallback
// commitPreview uses when the diff has nothing to compose a label from.
const installSolvedDoc = (result: PartDocHook) => {
  act(() => {
    result.current.setDoc({
      ...structuredClone(docRef.current),
      features: [{ ...docRef.current!.features![0], label: 'solved' }],
    })
  })
}

describe('undo labels for the label-only resolution entries', () => {
  beforeEach(resetHarness)

  it('a preview resolved at session start reads as an applied color', () => {
    docRef.current = colorDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    installSolvedDoc(result)
    act(() => { result.current.startEditSession(true) })

    expect(result.current.undoStack).toHaveLength(1)
    expect(describeMutation(result.current.undoStack[0].mutation)).toBe('apply previewed color')
  })

  it('a preview resolved before a history move reads as an applied color', () => {
    docRef.current = colorDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // Seed a redo branch so the history move has a move to make.
    act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'extrude-1', label: 'seeded' } as Mutation) })
    act(() => { result.current.handleUndo() })
    expect(result.current.redoStack).toHaveLength(1)

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current)) })
    installSolvedDoc(result)
    // A redo arriving while the popover is open resolves the preview first, so
    // the history move would carry exactly that work; the push clears the redo
    // branch, so the entry stays on the undo stack.
    act(() => { result.current.handleRedo() })

    expect(result.current.undoStack).toHaveLength(1)
    expect(describeMutation(result.current.undoStack[0].mutation)).toBe('apply previewed color')
  })

  // The one resolution whose description always reaches the user, because it is
  // pushed straight onto the stack rather than through commitPreview.
  it('a brep projection banked before a history move reads as an added projection', () => {
    docRef.current = makeSketchDoc()
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const store = useSketchEditorStore.getState()
    setSketchCallback('onMutation', result.current.handleMutation)
    setSketchCallback('beginBrepProjection', result.current.beginBrepProjection)
    setSketchCallback('cancelBrepProjection', result.current.cancelBrepProjection)
    setSketchCallback('getSketch', () => null)
    useSketchEditorStore.setState({ activeFeatureId: 'sk1' })
    try {
      // Seed a redo branch: one entry, then undone.
      act(() => { result.current.handleMutation({ type: 'add_entity', featureId: 'sk1', kind: 'point', params: [1, 2] } as Mutation) })
      act(() => { result.current.handleUndo() })

      // A brep pick materialises a projection with no entry of its own yet.
      act(() => { store.addBrepDimensionPick('?b1/edge:1', { isVertexPick: false, sourceKind: 'line' }) })
      expect(result.current.undoStack).toHaveLength(0)

      act(() => { result.current.handleRedo() })

      expect(result.current.undoStack).toHaveLength(1)
      expect(describeMutation(result.current.undoStack[0].mutation)).toBe('add projected edge')
    } finally {
      result.current.registerUndoTeardown(null)
      setSketchCallback('onMutation', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('getSketch', null)
    }
  })
})
