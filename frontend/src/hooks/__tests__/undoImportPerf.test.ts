// Measurement-gated test for undo-import-perf (feature/undo-import-perf.md).
//
// Every part-doc edit structuredClones the whole doc, and every retained undo
// entry holds its own copy, so an imported STEP file's inline base64 file_data
// is duplicated MAX_UNDO_DEPTH (50) times. cloneDocForUndo deep-clones
// everything except the immutable payloads, which are kept as ONE shared string
// per import. Measured locally on a 6 MB payload doc: a full structuredClone is
// ~4.1 ms vs ~0.01 ms scoped, and a 50-entry stack retains ~306 MB vs ~1x the
// payload (a 20 000x ratio).
//
// The gate asserts retained heap, not wall clock: a timing threshold flakes on
// a contended CI box, but a full clone per entry retains ~50 payload copies,
// which a heap delta between two reads in one process cannot miss. The budget
// is a fraction of one copy, so measurement noise cannot hide a regression.
// The correctness tests below pin that the skipped payload still round-trips
// byte-identically and that only the payload is shared.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { usePartDoc } from '@/hooks/usePartDoc'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation, PartFeature } from '@/types/cad'

const MB = 1024 * 1024
const PAYLOAD = 'A'.repeat(6 * MB)

describe('measurement gate: the undo stack does not duplicate the import payload', () => {
  it('retains ~1x the payload, not one copy per entry', () => {
    const makeDoc = (i: number): PartDoc => ({
      version: 1,
      kind: 'part',
      features: [
        { id: 'imp1', kind: 'import_step', label: 'part.step', file_data: PAYLOAD },
        { id: `f${i}`, kind: 'sketch', label: `sketch ${i}` },
      ],
    })
    const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
    const { result } = renderHookStrict(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

    // Warm the jit path before the baseline read so compile-time allocation
    // cannot leak into the delta.
    act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, makeDoc(0)))

    const baseline = process.memoryUsage().heapUsed
    for (let i = 1; i < MAX_UNDO_DEPTH + 6; i++) {
      act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, makeDoc(i)))
    }
    const retained = process.memoryUsage().heapUsed - baseline

    // A full clone per entry retains ~MAX_UNDO_DEPTH copies of a 6 MB payload
    // (~300 MB). Sharing the immutable payload retains roughly one payload
    // worth of the immutable strings the entries all point at. The budget is a
    // payload-relative fraction of one copy, generous for CI noise yet far
    // under the ~50-copy regression. Observed fixed-code retention is ~1x the
    // payload; 5x is ~9x over that and ~11x under the regression.
    expect(result.current.undoStack).toHaveLength(MAX_UNDO_DEPTH)
    expect(retained).toBeLessThan(PAYLOAD.length * 5)
  })
})

describe('cloneDocForUndo', () => {
  const makeImportDoc = (payload = PAYLOAD): PartDoc => ({
    version: 1,
    kind: 'part',
    rollback: 0,
    features: [
      { id: 'origin', kind: 'origin' },
      { id: 'imp1', kind: 'import_step', label: 'a.step', file_data: payload },
      {
        id: 'sk1', kind: 'sketch', label: 'Sketch',
        entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 10, 0] },
      },
    ],
  })

  it('preserves the payload byte-identically', () => {
    const clone = cloneDocForUndo(makeImportDoc())
    expect(clone.features![1].file_data).toBe(PAYLOAD)
  })

  it('deep-clones everything else, so mutating the clone cannot touch the source', () => {
    const doc = makeImportDoc()
    const clone = cloneDocForUndo(doc)
    const srcImp = doc.features![1] as PartFeature
    const cloneImp = clone.features![1] as PartFeature
    expect(cloneImp).not.toBe(srcImp)
    expect(clone.features![0]).not.toBe(doc.features![0])
    const srcSk = doc.features![2] as { initial: Record<string, number[]> }
    expect((clone.features![2] as { initial: Record<string, number[]> }).initial).not.toBe(srcSk.initial)

    cloneImp.label = 'mutated'
    cloneImp.file_data = 'DIFFERENT'
    expect((doc.features![1] as PartFeature).label).toBe('a.step')
    expect((doc.features![1] as PartFeature).file_data).toBe(PAYLOAD)
  })

  it('is value-equal to the source doc (nothing else was dropped)', () => {
    const doc = makeImportDoc()
    expect(cloneDocForUndo(doc)).toEqual(doc)
  })

  it('leaves a doc with no features unchanged in shape', () => {
    const plain = { version: 1, kind: 'part' } as PartDoc
    const clone = cloneDocForUndo(plain)
    expect(clone).toEqual(plain)
    expect('features' in clone).toBe(false)
  })

  it('handles multiple import payloads independently, per-payload', () => {
    const b = 'B'.repeat(1024)
    const c = 'C'.repeat(1024)
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'imp1', kind: 'import_step', file_data: b },
        { id: 'imp2', kind: 'import_step', file_data: c },
      ],
    } as PartDoc
    const clone = cloneDocForUndo(doc)
    expect(clone.features![0].file_data).toBe(b)
    expect(clone.features![1].file_data).toBe(c)
    // The two payloads stay distinct even though both are shared references.
    expect(clone.features![0].file_data).not.toBe(clone.features![1].file_data)
  })
})

describe('undo/redo round-trip with a skipped payload', () => {
  const payload = 'C'.repeat(MB)
  const docWith = (extraSketchIds: string[] = []): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      { id: 'imp1', kind: 'import_step', label: 'part.step', file_data: payload },
      ...extraSketchIds.map(id => ({ id, kind: 'sketch', label: `sketch ${id}` })),
    ],
  })

  it('restores the payload byte-identically after undo and redo', () => {
    const docA = docWith()
    const docB = docWith(['sk1'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<PartDoc | null>) => { docRef.current = d as PartDoc })
    const { result } = renderHookStrict(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, vi.fn()))

    act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA))
    act(() => result.current.handleUndo())

    expect(docRef.current).toEqual(docA)
    expect((docRef.current!.features![0] as PartFeature).file_data).toBe(payload)
    expect(docRef.current!.features).toHaveLength(1)

    act(() => result.current.handleRedo())
    expect(docRef.current).toEqual(docB)
    expect((docRef.current!.features![0] as PartFeature).file_data).toBe(payload)
    expect(docRef.current!.features).toHaveLength(2)
  })

  it('mutating the restored doc other fields cannot corrupt the shared payload', () => {
    const docA = docWith()
    const docB = docWith(['sk1'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<PartDoc | null>) => { docRef.current = d as PartDoc })
    const { result } = renderHookStrict(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, vi.fn()))

    act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA))
    act(() => result.current.handleUndo())

    // A later in-place edit of the restored doc (the cancelEditSession aliasing
    // shape) must not reach the payload: it is the immutable shared string.
    const restored = docRef.current!
    restored.features![0].label = 'renamed'
    restored.features![0].suppressed = true
    expect((restored.features![0] as PartFeature).file_data).toBe(payload)

    // Redo still restores docB with the payload intact.
    act(() => result.current.handleRedo())
    expect(docRef.current).toEqual(docB)
    expect((docRef.current!.features![0] as PartFeature).file_data).toBe(payload)
  })
})

// ─── Re-import through the real funnel ───

const docRef: { current: PartDoc | null } = { current: null }
const reSolve = vi.fn()

vi.mock('@/hooks/useDocumentState', () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    ownerUsername: null, loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
    permission: 'owner', isCloudDoc: false,
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
}))

vi.mock('@/hooks/useSolver', () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(),
    bodies: {}, pickBodies: {}, pickStateReady: false,
    solving: false, solveError: null, setSolveError: vi.fn(),
    solveResult: null, featureTimings: {}, reSolve, validation: null,
  }),
}))

describe('re-import through the real funnel', () => {
  beforeEach(() => {
    docRef.current = null
    reSolve.mockReset()
    usePartEditorStore.getState().setEditingFeatureId(null)
    usePartEditorStore.getState().setRollbackPosition(null)
    usePartEditorStore.getState().setPickBoundary(null)
  })

  it('a new import yields a NEW payload while the old entry still references the old one', () => {
    const payloadA = 'AAAA'.repeat(1024)
    const payloadB = 'BBBB'.repeat(1024)
    docRef.current = { oversolved: 1, kind: 'part', features: [] } as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', 'feature', vi.fn(), { solveOnLoad: false }))

    act(() => result.current.handleMutation({ type: 'add_import_step', featureId: 'imp1', fileData: payloadA, label: 'a.step' } as Mutation))
    act(() => result.current.handleMutation({ type: 'add_import_step', featureId: 'imp2', fileData: payloadB, label: 'b.step' } as Mutation))

    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['imp1', 'imp2'])
    expect((docRef.current!.features![1] as PartFeature).file_data).toBe(payloadB)

    // Undo to the single-import doc: the old entry restores payloadA.
    act(() => result.current.handleUndo())
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['imp1'])
    expect((docRef.current!.features![0] as PartFeature).file_data).toBe(payloadA)

    // Redo restores the re-imported doc with the NEW payload on the new feature.
    act(() => result.current.handleRedo())
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['imp1', 'imp2'])
    expect((docRef.current!.features![0] as PartFeature).file_data).toBe(payloadA)
    expect((docRef.current!.features![1] as PartFeature).file_data).toBe(payloadB)
  })
})
