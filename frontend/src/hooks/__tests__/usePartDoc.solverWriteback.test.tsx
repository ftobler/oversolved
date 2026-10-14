/**
 * Undo round-trip through the REAL solver for the write-back purity fix.
 *
 * The regression this pins: the old solve path deleted superfluous constraints
 * and projection_error entities out of the doc with no undo entry, so Ctrl+Z
 * restored them only for the immediate re-solve to delete them again. This
 * harness wires usePartDoc (the DocSession adapter) with the REAL useSolver and the worker
 * mocked, so it drives the actual flow a user walks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore, DEFAULT_PART_EDITOR_DATA } from '@/stores/partEditorStore'
import { useSolverStore } from '@/stores/solverStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import type { PartDoc, Mutation } from '@/types/cad'

const { mockSolveViaWorker } = vi.hoisted(() => ({ mockSolveViaWorker: vi.fn() }))

vi.mock('@/kernel/worker/solverClient', () => ({ solveViaWorker: mockSolveViaWorker }))
vi.mock('@/utils/geometry/geometryMapping', () => ({ unflattenGeometry: vi.fn().mockReturnValue({}) }))

const docRef: { current: PartDoc | null } = { current: null }
const saveDocMock = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current,
    setDoc: (d: PartDoc) => { docRef.current = d },
    docRef,
    docName: 'test',
    setDocName: vi.fn(),
    loading: false,
    error: null,
    setError: vi.fn(),
    saveDoc: saveDocMock,
    renameDoc: vi.fn(),
    cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: [],
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

function makeSuperfluousDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      label: 'first',
      entities: [
        { id: 'l1', kind: 'line' },
        { id: 'l2', kind: 'line' },
      ],
      constraints: [
        { id: 'c_keep', kind: 'horizontal', target: '$l1' },
        { id: 'c_super', kind: 'vertical', target: '$l2' },
      ],
      initial: {},
    }],
  }
}

function superfluousResponse(): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: {
      sk1: {
        status: 'ok',
        geometry: { l1: [0, 0, 10, 0], l2: [0, 5, 10, 5] },
        constraints: {
          c_keep: { residual: 0, render: { kind: 'symbol_h', at: [5, 0], entity: 'l1' }, superfluous: false },
          c_super: { residual: 0, render: { kind: 'symbol_v', at: [5, 5], entity: 'l2' }, superfluous: true },
        },
      },
    },
    bodies: {},
    _build_state: null,
  }
}

function makeProjectionDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [{
      id: 'sk1',
      kind: 'sketch',
      entities: [
        { id: 'line1', kind: 'line' },
        { id: 'proj1', kind: 'line', source: '?edge;line' },
      ],
      constraints: [
        { id: 'c_ref', kind: 'coincident', a: '$line1end', b: '$proj1start' },
      ],
      initial: {},
    }],
  }
}

function projectionResponse(): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: {
      sk1: {
        status: 'ok',
        geometry: { line1: [0, 0, 1, 0] },
        projection_errors: ['proj1'],
      },
    },
    bodies: {},
    _build_state: null,
  }
}

function sk1Response(): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: {
      sk1: { status: 'ok', geometry: { l1: [0, 0, 1, 0] } },
      sk2: { status: 'ok', geometry: { l1: [0, 0, 2, 0] } },
    },
    bodies: {},
    _build_state: null,
  }
}

function makeTwoSketchDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], initial: {} },
      { id: 'sk2', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], initial: {} },
    ],
  }
}

// sk1 carries two entities so a partial delete leaves the feature in the doc.
function makePartialDeleteDoc(): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }, { id: 'l2', kind: 'line' }], initial: {} },
      { id: 'sk2', kind: 'sketch', entities: [{ id: 'l1', kind: 'line' }], initial: {} },
    ],
  }
}

const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'sk1', label }) as Mutation

// The solved params arrive as float32 (wasm-kernel/codec.ts), so the wire says
// 3.1415927410125732 where the mutator's round() persists 3.141593.
const F32_PI = Math.fround(Math.PI)

// A sketch under the feature whose edit session suppresses per-action entries,
// which is the shape the aggregate edit_session entry belongs to.
function makeSketchThenExtrudeDoc(initial: number[]): PartDoc {
  return {
    version: 1,
    kind: 'part',
    features: [
      { id: 'sk1', kind: 'sketch', label: 'first', entities: [{ id: 'l1', kind: 'line' }], initial: { l1: initial } },
      { id: 'ex1', kind: 'extrude', label: 'body' },
    ],
  } as unknown as PartDoc
}

function sketchResponse(): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: { sk1: { status: 'ok', geometry: { l1: [0, 0, F32_PI, 0] } } },
    bodies: {},
    _build_state: null,
  }
}

// A solve in the band where the f32 quantum flips the mutators' 6dp grid: the
// wire carries 25.700000762939453 for an authored 25.7, and round() turns that
// into 25.700001. Every suite below 4 saw no mismatch, which is why the
// rounding-only write-back looked complete.
function bandResponse(): Record<string, unknown> {
  return {
    solve_ms: 0,
    result: { sk1: { status: 'ok', geometry: { l1: [0, 0, Math.fround(25.7), 0] } } },
    bodies: {},
    _build_state: null,
  }
}

const constraintsOf = (doc: PartDoc | null) => doc?.features?.[0]?.constraints ?? []

const entitiesOf = (doc: PartDoc | null) => doc?.features?.[0]?.entities ?? []

describe('solver write-back undo round-trip', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    saveDocMock.mockReset()
    useUnsavedChangesStore.getState().setDirty(false)
    const store = usePartEditorStore.getState()
    store.setEditingFeatureId(DEFAULT_PART_EDITOR_DATA.editingFeatureId)
    store.setPickBoundary(DEFAULT_PART_EDITOR_DATA.pickBoundary)
    store.setRollbackPosition(DEFAULT_PART_EDITOR_DATA.rollbackPosition)
    useSolverStore.setState({ isSolving: false, onCancelSolve: null })
  })

  // The flush reSolve fire-and-forgets; drain the microtask queue so the solve
  // (mock worker) lands before the next assertion.
  const flush = async () => { await act(async () => {}) }

  it('a superfluous constraint removed by the cleanup command survives undo + re-solve', async () => {
    docRef.current = makeSuperfluousDoc()
    mockSolveViaWorker.mockResolvedValue(superfluousResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // A plain edit that flags the constraint superfluous on solve.
    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()
    expect(constraintsOf(docRef.current).some(c => c.id === 'c_super')).toBe(true)
    expect(result.current.solveResults.sk1?.constraints?.c_super?.superfluous).toBe(true)

    // The explicit cleanup command removes it, one undo entry.
    act(() => {
      result.current.handleMutation({ type: 'remove_dangling_content', features: { sk1: { entities: [], constraints: ['c_super'] } } })
    })
    await flush()
    expect(constraintsOf(docRef.current).map(c => c.id)).toEqual(['c_keep'])
    expect(result.current.undoStack).toHaveLength(2)

    // Ctrl+Z restores it; the re-solve after undo must NOT delete it again.
    act(() => { result.current.handleUndo() })
    await flush()
    expect(constraintsOf(docRef.current).map(c => c.id)).toEqual(['c_keep', 'c_super'])
    expect(result.current.undoStack).toHaveLength(1)

    // A save after undo persists the restored doc.
    act(() => { result.current.saveDoc('doc-1', result.current.doc!) })
    expect((saveDocMock.mock.calls[0][1] as PartDoc).features![0].constraints!.map(c => c.id))
      .toEqual(['c_keep', 'c_super'])
  })

  it('projected entities removed by the cleanup command are restored by undo', async () => {
    docRef.current = makeProjectionDoc()
    mockSolveViaWorker.mockResolvedValue(projectionResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()
    expect(entitiesOf(docRef.current).map(e => e.id)).toEqual(['line1', 'proj1'])
    expect(result.current.solveResults.sk1?.projection_errors).toEqual(['proj1'])

    // Cleanup removes the projected entity and its referencing constraint.
    act(() => {
      result.current.handleMutation({ type: 'remove_dangling_content', features: { sk1: { entities: ['proj1'], constraints: [] } } })
    })
    await flush()
    expect(entitiesOf(docRef.current).map(e => e.id)).toEqual(['line1'])
    expect(result.current.undoStack).toHaveLength(2)

    act(() => { result.current.handleUndo() })
    await flush()
    expect(entitiesOf(docRef.current).map(e => e.id)).toEqual(['line1', 'proj1'])
    expect(result.current.undoStack).toHaveLength(1)
  })

  it('a failing solve after delete_feature restores the pruned result, not a ghost', async () => {
    docRef.current = makeTwoSketchDoc()
    mockSolveViaWorker.mockResolvedValue(sk1Response())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()
    expect(result.current.solveResults.sk1).toBeDefined()

    // The delete re-solve fails (local solver unavailable); the pruned entry
    // must come back so the feature does not ghost out.
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'sk1' } as Mutation) })
    await flush()
    expect(result.current.solveError).toContain('Local solver unavailable')
    expect(result.current.solveResults.sk1).toBeDefined()

    // Undo restores the feature; a successful re-solve repopulates the record.
    mockSolveViaWorker.mockResolvedValue(sk1Response())
    act(() => { result.current.handleUndo() })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'sk1')).toBe(true)
    expect(result.current.solveResults.sk1).toBeDefined()
    expect(result.current.solveError).toBeNull()
  })

  it('a failed solve after a partial delete does not restore the pruned result', async () => {
    docRef.current = makePartialDeleteDoc()
    mockSolveViaWorker.mockResolvedValue(sk1Response())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()
    expect(result.current.solveResults.sk1).toBeDefined()

    // Deleting one entity of sk1 prunes its whole result; the failing re-solve
    // must NOT restore the snapshot, or the deleted entity's geometry would be
    // redrawn as a ghost. The viewport falls back to the doc, which no longer
    // carries l1.
    mockSolveViaWorker.mockResolvedValue(null)
    act(() => { result.current.handleMutation({ type: 'delete', targets: ['entity:sk1:l1'] } as Mutation) })
    await flush()

    expect(result.current.solveError).toContain('Local solver unavailable')
    expect(result.current.solveResults.sk1).toBeUndefined()
    const sk1 = docRef.current!.features!.find(f => f.id === 'sk1')!
    expect(sk1.entities!.map(e => e.id)).toEqual(['l2'])
  })

  it('a failed delete re-solve that is superseded does not clobber the newer result', async () => {
    docRef.current = makeTwoSketchDoc()
    mockSolveViaWorker.mockResolvedValue(sk1Response())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()

    // The delete re-solve hangs; while it is in flight a newer (succeeding)
    // solve lands with a result that legitimately has no sk1 entry. The stale
    // failure must neither restore the pruned sk1 over that newer result nor
    // paint the unavailable banner under it.
    let releaseDelete!: (v: unknown) => void
    mockSolveViaWorker.mockReturnValueOnce(new Promise<unknown>(r => { releaseDelete = r }))
    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'sk1' } as Mutation) })

    mockSolveViaWorker.mockResolvedValue({
      solve_ms: 0,
      result: { sk2: { status: 'ok', geometry: { l1: [0, 0, 2, 0] } } },
      bodies: {},
      _build_state: null,
    })
    // Renaming the surviving sketch is a real edit, so it starts a newer solve
    // while the delete's solve is still hanging. (A no-op rename would be
    // skipped by the handleMutation no-op guard, so it could not supersede.)
    act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'sk2', label: 'again' } as Mutation) })
    await flush()

    // Release the stale failing delete solve; its restore is skipped.
    await act(async () => {
      releaseDelete(null)
      await flush()
    })

    expect(result.current.solveError).toBeNull()
    expect(result.current.solveResults.sk2).toBeDefined()
    expect(result.current.solveResults.sk1).toBeUndefined()
  })

  it('undo + redo through the real solver return to the forward doc, write-back included', async () => {
    // The generic solve path is pure: the only doc edit it owns is adopting the
    // solved geometry. The superfluous flag lives in solveResults, so the undo's
    // re-solve must NOT delete the constraint again (the undo-solver-writeback
    // regression). The redo leg proves the whole round-trip lands on the forward
    // doc byte-for-byte, geometry write-back included.
    docRef.current = makeSuperfluousDoc()
    mockSolveViaWorker.mockResolvedValue(superfluousResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()
    const forward = structuredClone(docRef.current)
    expect((forward.features![0] as { initial: Record<string, number[]> }).initial.l1).toEqual([0, 0, 10, 0])
    expect(result.current.solveResults.sk1?.constraints?.c_super?.superfluous).toBe(true)

    act(() => { result.current.handleUndo() })
    await flush()
    expect((docRef.current!.features![0] as { label?: string }).label).toBe('first')
    // The re-solve after undo flagged the constraint again but did not delete it.
    expect(constraintsOf(docRef.current).map(c => c.id)).toEqual(['c_keep', 'c_super'])
    expect(result.current.solveResults.sk1?.constraints?.c_super?.superfluous).toBe(true)

    act(() => { result.current.handleRedo() })
    await flush()
    expect(structuredClone(docRef.current)).toEqual(forward)
    expect(constraintsOf(docRef.current).map(c => c.id)).toEqual(['c_keep', 'c_super'])
  })

  it('delete_feature repopulates solveResults to match the restored doc through undo', async () => {
    // The worker reflects reality: it reports geometry only for the sketch
    // features actually present in the payload, so a deleted feature has no
    // record after the delete's re-solve and is repopulated by the undo's.
    docRef.current = makeTwoSketchDoc()
    mockSolveViaWorker.mockImplementation((payload: Record<string, unknown>) => {
      const features = (payload.features as { id: string; kind: string }[]) ?? []
      const result: Record<string, unknown> = {}
      for (const f of features) {
        if (f.kind === 'sketch') result[f.id] = { status: 'ok', geometry: { l1: [0, 0, 1, 0] } }
      }
      return Promise.resolve({ solve_ms: 0, result, bodies: {}, _build_state: null })
    })

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => { result.current.handleMutation(renameTo('edited')) })
    await flush()
    expect(result.current.solveResults.sk1).toBeDefined()

    act(() => { result.current.handleMutation({ type: 'delete_feature', featureId: 'sk1' } as Mutation) })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'sk1')).toBe(false)
    expect(result.current.solveResults.sk1).toBeUndefined()

    act(() => { result.current.handleUndo() })
    await flush()
    // The undo restored the feature and the re-solve repopulated its record.
    expect(docRef.current!.features!.some(f => f.id === 'sk1')).toBe(true)
    expect(result.current.solveResults.sk1).toBeDefined()
    expect(result.current.solveResults.sk1?.status).toBe('ok')

    act(() => { result.current.handleRedo() })
    await flush()
    expect(docRef.current!.features!.some(f => f.id === 'sk1')).toBe(false)
    expect(result.current.solveResults.sk1).toBeUndefined()
  })
})

// ─── Write-back vs the edit-session diff and the unsaved-changes flag ───

describe('solver write-back and a session that edited nothing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    saveDocMock.mockReset()
    useUnsavedChangesStore.getState().setDirty(false)
    const store = usePartEditorStore.getState()
    store.setEditingFeatureId(DEFAULT_PART_EDITOR_DATA.editingFeatureId)
    store.setPickBoundary(DEFAULT_PART_EDITOR_DATA.pickBoundary)
    store.setRollbackPosition(DEFAULT_PART_EDITOR_DATA.rollbackPosition)
    useSolverStore.setState({ isSolving: false, onCancelSolve: null })
  })

  // The flush reSolve fire-and-forgets; drain the microtask queue so the solve
  // (mock worker) lands before the next assertion.
  const flush = async () => { await act(async () => {}) }

  // What useEditFeature does when the editor opens on ex1: the store learns
  // which feature is open, where the rollback bar sits and how far the pick
  // boundary reaches, so useSolver's editing invariant holds.
  const openSessionOnEx1 = (result: { current: { startEditSession: (s: boolean) => void; reSolve: (d: PartDoc) => Promise<void> | void } }) => {
    const store = usePartEditorStore.getState()
    store.setEditingFeatureId('ex1')
    store.setRollbackPosition(2)
    store.setPickBoundary(1)
    act(() => { result.current.startEditSession(true) })
    return act(async () => { await result.current.reSolve(docRef.current!) })
  }

  // Entering an edit re-solves the whole stack (useEditFeature's tail), and that
  // solve re-bakes every sketch's solved geometry into `initial`. The session
  // snapshot was taken just before it, so an unrounded write-back leaves the two
  // docs differing only in digits the user cannot see -- and the commit then
  // reads that as the session's work.
  it('a re-solve during a session that edited nothing leaves no edit_session entry', async () => {
    docRef.current = makeSketchThenExtrudeDoc([0, 0, 3.141593, 0])
    mockSolveViaWorker.mockResolvedValue(sketchResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const before = docRef.current

    await openSessionOnEx1(result)

    // The write-back rounded the f32 params back to what the mutator wrote, so
    // the solve moved nothing and even the doc object survived it.
    expect(docRef.current).toBe(before)

    act(() => { result.current.commitEditSession() })
    // An aggregate here would restore a doc identical to the live one, and undo
    // would re-solve to re-derive the same geometry: a step that looks dead.
    expect(result.current.undoStack).toHaveLength(0)
  })

  // The other half of the same coin: the authored initial carried more
  // precision than the document stores (hand written YAML, an import, a solve
  // that resolved a projection differently). It agrees with the solved value
  // inside the f32 envelope, so the write-back keeps the authored spelling
  // rather than re-spelling it on the mutators' grid -- and what is left is
  // still not a user edit, so it must not mint a step.
  it('a solve over an over-precise authored initial is not a user edit', async () => {
    docRef.current = makeSketchThenExtrudeDoc([0, 0, Math.PI, 0])
    mockSolveViaWorker.mockResolvedValue(sketchResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const before = docRef.current

    await openSessionOnEx1(result)

    // The authored digits survive, so the doc did not even change object.
    expect(docRef.current).toBe(before)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial.l1).toEqual([0, 0, Math.PI, 0])

    act(() => { result.current.commitEditSession() })
    expect(result.current.undoStack).toHaveLength(0)
  })

  // The f32 band the rounding-only write-back missed. Rounding the wire value
  // does not recover the authored 25.7 (it mints 25.700001), so the re-solve
  // used to leave a fresh doc object and a live doc that disagreed with the
  // session snapshot taken just before it.
  it('a re-solve in the f32 band during a session that edited nothing changes nothing', async () => {
    docRef.current = makeSketchThenExtrudeDoc([0, 0, 25.7, 0])
    mockSolveViaWorker.mockResolvedValue(bandResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const before = docRef.current

    await openSessionOnEx1(result)

    // The write-back kept the authored spelling, so the whole doc survived the
    // re-solve: same object, same digits.
    expect(docRef.current).toBe(before)
    const initial = (docRef.current!.features![0] as { initial: Record<string, number[]> }).initial
    expect(initial.l1).toEqual([0, 0, 25.7, 0])

    act(() => { result.current.commitEditSession() })
    // sessionWouldPush diffs the snapshot against the live doc; nothing moved,
    // so no aggregate entry is minted and undo gains no dead step.
    expect(result.current.undoStack).toHaveLength(0)
  })

  // The three-click repro: open the editor, Ctrl+S, Escape. Nothing was edited,
  // the rewind restored the very doc the save just stored, so the flag must stay
  // clear -- the pinned save count moving is not enough to call the document
  // unsaved.
  it('a save during a session that changed nothing does not leave the document dirty', async () => {
    docRef.current = makeSketchThenExtrudeDoc([0, 0, 3.141593, 0])
    mockSolveViaWorker.mockResolvedValue(sketchResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
    const before = docRef.current

    await openSessionOnEx1(result)
    expect(docRef.current).toBe(before)

    useUnsavedChangesStore.getState().markSaved()  // the save landing
    act(() => { result.current.cancelEditSession() })
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  // The control: the same three clicks around a real edit. The save stored the
  // edit, the rewind throws it away, so the live doc no longer matches the saved
  // bytes and the flag has to stay set.
  it('a save after a real edit still leaves the cancelled document dirty', async () => {
    docRef.current = makeSketchThenExtrudeDoc([0, 0, 3.141593, 0])
    mockSolveViaWorker.mockResolvedValue(sketchResponse())

    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    // The session opens on ex1 as above, with the edit landing inside it; the
    // re-solve after it is the mutation's own.
    const store = usePartEditorStore.getState()
    store.setEditingFeatureId('ex1')
    store.setRollbackPosition(2)
    store.setPickBoundary(1)
    act(() => { result.current.startEditSession(true) })
    act(() => { result.current.handleMutation({ type: 'rename_feature', featureId: 'ex1', label: 'edited' } as Mutation) })
    await flush()
    useUnsavedChangesStore.getState().markSaved()  // the save landing

    act(() => { result.current.cancelEditSession() })
    expect(useUnsavedChangesStore.getState().dirty).toBe(true)
  })
})
