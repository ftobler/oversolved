// A doc edit must re-solve INCREMENTALLY. `handleMutation` used to pass
// `bypassCache: true` for every mutation, which discards the checkpoint cache
// and rebuilds the whole stack: deleting one part out of a 200-part STEP import
// cost 28.5s instead of 0.50s, because the delete re-ran the import.
//
// The one case that still needs the bypass is a drag: `drag_anchor` is a
// VOLATILE_FEATURE_KEY (kernel/builder.ts), so dirty detection is deliberately
// blind to it and a solve differing only in the anchor would read as clean.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { usePartDoc } from '@/hooks/usePartDoc'
import type { PartDoc, Mutation } from '@/types/cad'

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: vi.fn(),
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    ownerUsername: null,
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: vi.fn(),
    renameDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {},
    setSolveResults: vi.fn(),
    bodies: {},
    pickBodies: {},
    solving: false,
    solveError: null,
    setSolveError: vi.fn(),
    solveResult: null,
    featureTimings: {},
    reSolve,
    validation: null,
  }),
}))

vi.mock('@/hooks/useUndoRedo', () => ({
  useUndoRedo: () => ({
    undoStack: [],
    redoStack: [],
    suppressUndoRef: { current: false },
    pushUndo: vi.fn(),
    handleUndo: vi.fn(),
    handleRedo: vi.fn(),
    saveUndoStackSnapshot: vi.fn(),
    restoreUndoStackSnapshot: vi.fn(),
    clearUndoStackSnapshot: vi.fn(),
  }),
}))

// A STEP import plus a sketch to drag in, mirroring the shape of the document
// this whole change exists for.
function makeDoc(): PartDoc {
  return {
    oversolved: 1,
    kind: 'part',
    features: [
      { id: 'imp1', kind: 'import_step', file_data: 'AAAA', scale: 1 },
      { id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 1, 1] } },
    ],
  } as unknown as PartDoc
}

/** Apply one mutation through the hook and return the options reSolve got. */
function solveOptionsFor(m: Mutation): Record<string, unknown> | undefined {
  docRef.current = makeDoc()
  const { result } = renderHook(() => usePartDoc('doc1', { solveOnLoad: false }))
  act(() => { result.current.handleMutation(m) })
  expect(reSolve).toHaveBeenCalledTimes(1)
  return reSolve.mock.calls[0][1] as Record<string, unknown> | undefined
}

describe('handleMutation cache policy', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    docRef.current = null
  })

  it('keeps the checkpoint cache for a delete_feature (the STEP-import trigger)', () => {
    const opts = solveOptionsFor({ type: 'delete_feature', featureId: 'sk1' } as Mutation)
    expect(opts?.bypassCache).toBeFalsy()
  })

  it('keeps the checkpoint cache for an ordinary parameter edit', () => {
    const opts = solveOptionsFor({ type: 'add_import_step', featureId: 'imp2', fileData: 'BBBB' } as unknown as Mutation)
    expect(opts?.bypassCache).toBeFalsy()
  })

  // The three drag mutations are the ones that carry `drag_anchor`, the single
  // field findFirstDirty ignores -- so they, and only they, must bypass.
  const dragMutations: Mutation[] = [
    { type: 'move_vertex', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 2] },
    { type: 'move_vertex_with_constraint', featureId: 'sk1', entityId: 'l1', vertexKey: 'start', to: [1, 2], constraintKind: 'coincident' },
    { type: 'move_entity', featureId: 'sk1', entityId: 'l1', delta: [1, 2] },
  ]
  for (const m of dragMutations) {
    it(`bypasses the cache for ${m.type}, whose drag_anchor dirty detection cannot see`, () => {
      const opts = solveOptionsFor(m)
      expect(opts?.bypassCache).toBe(true)
      expect(opts?.dragAnchor).toEqual({ featureId: 'sk1', entityId: 'l1' })
    })
  }
})
