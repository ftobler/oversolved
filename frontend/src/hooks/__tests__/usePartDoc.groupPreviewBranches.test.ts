// The commitMutationGroup prune/restore path and the preview/group escape and
// suppression branches of usePartDoc that the roundtrip and undoGaps suites do
// not reach. Real useUndoRedo and real mutation handlers; only the document and
// solver seams are mocked.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'

const solver = vi.hoisted(() => ({ solveResults: {} as Record<string, SketchData> }))
const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()
const setSolveResults = vi.fn((next: Record<string, SketchData>) => { solver.solveResults = next })

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
    cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: solver.solveResults,
    setSolveResults,
    bodies: {},
    pickBodies: {},
    pickStateReady: false,
    solving: false,
    solveError: null,
    setSolveError: vi.fn(),
    featureTimings: {},
    reSolve,
    validation: null,
  }),
}))

const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'ex1', label }) as Mutation

const featureIds = () => (docRef.current?.features ?? []).map(f => f.id)
const labelOf = () => (docRef.current?.features?.[0] as { label?: string } | undefined)?.label

function renderPartDoc() {
  return renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
}

beforeEach(() => {
  vi.clearAllMocks()
  solver.solveResults = {}
  docRef.current = null
  usePartEditorStore.setState({ editingFeatureId: null, rollbackPosition: null, pickBoundary: null })
  useUnsavedChangesStore.getState().setDirty(false)
})

describe('commitMutationGroup solve-result prune and restore', () => {
  it('prunes the deleted body feature and restores it through the group re-solve', () => {
    solver.solveResults = { ex1: { solved: {} } }
    docRef.current = {
      version: 1, kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude' }, { id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => {
      result.current.commitMutationGroup([{ type: 'delete_feature', featureId: 'ex1' }] as Mutation[])
    })

    expect(featureIds()).toEqual(['sk1'])
    expect(result.current.undoStack).toHaveLength(1)
    expect(setSolveResults).toHaveBeenCalledWith({})
    expect(reSolve).toHaveBeenCalledTimes(1)
    expect(reSolve.mock.calls[0][1]).toMatchObject({ _restoreSolveResults: { ex1: { solved: {} } } })
  })

  it('applies a known mutation in a group that also carries an unknown one', () => {
    docRef.current = {
      version: 1, kind: 'part', features: [{ id: 'ex1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { result } = renderPartDoc()

      act(() => {
        result.current.commitMutationGroup([
          { type: 'bogus_mutation' } as unknown as Mutation,
          renameTo('second'),
        ])
      })

      expect(error).toHaveBeenCalledWith(expect.stringContaining('no handler for mutation type: bogus_mutation'))
      expect(labelOf()).toBe('second')
      expect(result.current.undoStack).toHaveLength(1)
    } finally {
      error.mockRestore()
    }
  })
})

describe('preview mutation label over part_style diffs', () => {
  it('names bodies added and removed while the preview was open', () => {
    docRef.current = {
      version: 1, kind: 'part',
      part_style: { b1: { color: '#ff0000' }, b3: { color: '#0000ff' } },
      features: [{ id: 'ex1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    // A preview-scope edit marks the preview as touched.
    act(() => { result.current.handleMutation({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    // Meanwhile the solver fabricates b2 and drops b3.
    docRef.current!.part_style = { b1: { color: '#00ff00' }, b2: { color: '#00ff00' } }

    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })

    expect(result.current.undoStack).toHaveLength(1)
    const description = (result.current.undoStack[0].mutation as { description?: string }).description ?? ''
    expect(description).toContain('b2')
    expect(description).toContain('b3')
  })

  it('falls back to the mutation it was handed when the label would be null', () => {
    docRef.current = {
      version: 1, kind: 'part',
      features: [{ id: 'ex1', kind: 'extrude', label: 'first' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    const original = structuredClone(docRef.current!)
    act(() => { result.current.startPreviewMode(original) })
    // A change outside part_style while the preview is open.
    docRef.current = {
      ...docRef.current, features: [{ id: 'ex1', kind: 'extrude', label: 'changed' }],
    } as unknown as PartDoc

    act(() => { result.current.handleMutation(renameTo('renamed')) })

    // preview_commit (label falls back to the rename it was handed) then the
    // escaped mutation's own entry.
    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('rename_feature')
    expect(result.current.undoStack[1].mutation.type).toBe('rename_feature')
  })
})

describe('group preview scope and suppression', () => {
  it('swallows a group made entirely of preview-scope mutations as one preview frame', () => {
    docRef.current = {
      version: 1, kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'ex1', kind: 'extrude' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => {
      result.current.commitMutationGroup([
        { type: 'set_part_color', bodyId: 'b1', color: '#00ff00' },
        { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 },
      ] as Mutation[])
    })

    // Swallowed: no per-frame entry while the preview is open.
    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.commitPreview({ type: 'set_part_color', bodyId: 'b1', color: '#00ff00' }) })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
  })

  it('escapes a non-preview group and keeps the color change undoable', () => {
    docRef.current = {
      version: 1, kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    // The group changes something outside part_style: previewMutationFor is null,
    // so the group's first mutation names the escaped entry.
    docRef.current = {
      ...docRef.current, features: [{ id: 'sk1', kind: 'sketch', label: 'edited' }],
    } as unknown as PartDoc

    act(() => {
      result.current.commitMutationGroup([
        { type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 1, 1], entityId: 'l2' },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(2)
    expect(result.current.undoStack[0].mutation.type).toBe('add_entity')
    expect(result.current.undoStack[1].mutation.type).toBe('add_entity')
  })

  it('a suppressed group whose only change is body style still leaves an undo entry', () => {
    docRef.current = {
      version: 1, kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    // A brep projection withhold armed at the session boundary must be consumed
    // by the swallowed group rather than leak past it.
    act(() => { result.current.beginBrepProjection() })
    act(() => {
      result.current.commitMutationGroup([
        { type: 'set_part_color', bodyId: 'b1', color: '#00ff00' },
      ] as Mutation[])
    })

    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('edit_session')
  })

  it('an all-preview group swallowed by a suppressed session with an open preview still earns its entry', () => {
    docRef.current = {
      version: 1, kind: 'part',
      part_style: { b1: { color: '#ff0000' } },
      features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    // A color preview opened inside the session: the session's 'all' scope
    // swallows the group, but the preview still owns the undo entry for it.
    act(() => { result.current.startPreviewMode(structuredClone(docRef.current!)) })
    act(() => {
      result.current.commitMutationGroup([
        { type: 'set_part_color', bodyId: 'b1', color: '#00ff00' },
        { type: 'set_part_transparency', bodyId: 'b1', transparency: 0.5 },
      ] as Mutation[])
    })

    // Swallowed as a preview frame: no per-frame entry while the session is open.
    expect(result.current.undoStack).toHaveLength(0)
    act(() => { result.current.commitEditSession() })
    // The preview_commit pushes the entry that can revert the color; without it
    // the change lands in the doc with no way back.
    expect(result.current.undoStack).toHaveLength(1)
    expect(result.current.undoStack[0].mutation.type).toBe('preview_commit')
  })
})

describe('session and featureless-doc edges', () => {
  it('starting an edit session with no doc is a no-op', () => {
    docRef.current = null
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(0)
  })

  it('a suppressed session commit without an editing feature names the entry empty', () => {
    docRef.current = {
      version: 1, kind: 'part', features: [{ id: 'sk1', kind: 'sketch' }],
    } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.startEditSession(true) })
    act(() => {
      usePartEditorStore.setState({ editingFeatureId: null })
      result.current.handleMutation({
        type: 'add_entity', featureId: 'sk1', kind: 'line', params: [0, 0, 5, 5], entityId: 'l2',
      } as Mutation)
    })
    act(() => { result.current.commitEditSession() })

    expect(result.current.undoStack).toHaveLength(1)
    expect((result.current.undoStack[0].mutation as { featureId?: string }).featureId).toBe('')
  })

  it('a featureless doc makes an idempotent reorder/rename a no-op', () => {
    docRef.current = { version: 1, kind: 'part' } as unknown as PartDoc
    const { result } = renderPartDoc()

    act(() => { result.current.handleMutation({ type: 'reorder_features', featureId: 'x', toIndex: 0 } as unknown as Mutation) })
    act(() => { result.current.handleMutation(renameTo('x')) })

    expect(result.current.undoStack).toHaveLength(0)
    expect(reSolve).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })
})
