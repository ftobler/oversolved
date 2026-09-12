// The undo stack no longer carries import bytes at all: after C1 a document
// holds a `file_id` reference and the registry owns the payload. cloneDocForUndo
// is a plain structuredClone, so MAX_UNDO_DEPTH entries retain ~MAX_UNDO_DEPTH
// small docs, never a copy of a 6 MB record.
//
// The gate asserts retained heap, not wall clock: a timing threshold flakes on a
// contended CI box, but a regression that put bytes back into the document would
// retain ~50 payload copies, which a heap delta between two reads cannot miss.
// The correctness tests below pin that the reference still round-trips and that
// cloneDocForUndo remains a real deep clone.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { useUndoRedo } from '@/hooks/useUndoRedo'
import { usePartDoc } from '@/hooks/usePartDoc'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { MemoryFileRegistry } from '@/stores/fileRegistry'
import { MAX_UNDO_DEPTH } from '@/config/undoConfig'
import { usePartEditorStore } from '@/stores/partEditorStore'
import type { PartDoc, Mutation, PartFeature } from '@/types/cad'

const MB = 1024 * 1024

describe('measurement gate: the undo stack does not duplicate the import payload', () => {
  it('retains ~the doc, not a 6 MB registry record, across MAX_UNDO_DEPTH entries', async () => {
    // A 6 MB record the doc references. The bytes live in the registry, never in
    // the document, so the stack cannot copy them.
    const registry = new MemoryFileRegistry()
    const { id: fileId } = await registry.create({
      name: 'big.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array(6 * MB),
    })

    const makeDoc = (i: number): PartDoc => ({
      version: 1,
      kind: 'part',
      features: [
        { id: 'imp1', kind: 'import_step', label: 'part.step', file_id: fileId },
        { id: `f${i}`, kind: 'sketch', label: `sketch ${i}` },
      ],
    })
    // GC is only exposed when vitest's node runs with --expose-gc; force a
    // collection when it is, so a previous run's allocation cannot bleed into
    // this run's baseline.
    const gc = (globalThis as { gc?: () => void }).gc

    // A single heap read can be inflated by a GC spike on a contended CI box.
    // The gate takes the minimum over several independent runs.
    let minRetained = Infinity
    let depth = 0
    for (let run = 0; run < 5; run++) {
      const docRef = { current: { version: 1, kind: 'part' } as PartDoc }
      const { result, unmount } = renderHookStrict(() =>
        useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, vi.fn(), vi.fn()))

      gc?.()
      act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, makeDoc(0)))
      gc?.()
      const baseline = process.memoryUsage().heapUsed
      for (let i = 1; i < MAX_UNDO_DEPTH + 6; i++) {
        act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, makeDoc(i)))
      }
      minRetained = Math.min(minRetained, process.memoryUsage().heapUsed - baseline)
      depth = result.current.undoStack.length
      // Release this run's retained entries so the next run measures against a
      // clean heap instead of stacking another 50 clones on top of the last.
      act(() => unmount())
    }

    expect(depth).toBe(MAX_UNDO_DEPTH)
    // The doc holds a uuid string, not bytes: the 50 retained entries stay under
    // a single 6 MB payload. A regression that inlined the bytes would retain
    // tens of payload copies and blow this budget by orders of magnitude.
    expect(minRetained).toBeLessThan(6 * MB)
  })
})

describe('cloneDocForUndo', () => {
  const makeImportDoc = (): PartDoc => ({
    version: 1,
    kind: 'part',
    rollback: 0,
    features: [
      { id: 'origin', kind: 'origin' },
      { id: 'imp1', kind: 'import_step', label: 'a.step', file_id: 'file-1' },
      {
        id: 'sk1', kind: 'sketch', label: 'Sketch',
        entities: [{ id: 'l1', kind: 'line' }], initial: { l1: [0, 0, 10, 0] },
      },
    ],
  })

  it('deep-clones everything, so mutating the clone cannot touch the source', () => {
    const doc = makeImportDoc()
    const clone = cloneDocForUndo(doc)
    const srcImp = doc.features![1]
    const cloneImp = clone.features![1]
    expect(cloneImp).not.toBe(srcImp)
    expect(clone.features![0]).not.toBe(doc.features![0])
    const srcSk = doc.features![2] as { initial: Record<string, number[]> }
    expect((clone.features![2] as { initial: Record<string, number[]> }).initial).not.toBe(srcSk.initial)

    cloneImp.label = 'mutated'
    cloneImp.file_id = 'other'
    expect((doc.features![1] as PartFeature).label).toBe('a.step')
    expect((doc.features![1] as PartFeature).file_id).toBe('file-1')
  })

  it('carries no bytes on the import feature', () => {
    const clone = cloneDocForUndo(makeImportDoc())
    const imp = clone.features![1]
    expect(imp.file_id).toBe('file-1')
    expect('file_data' in imp).toBe(false)
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

  it('handles multiple import references independently', () => {
    const doc = {
      version: 1,
      kind: 'part',
      features: [
        { id: 'imp1', kind: 'import_step', file_id: 'file-1' },
        { id: 'imp2', kind: 'import_step', file_id: 'file-2' },
      ],
    } as PartDoc
    const clone = cloneDocForUndo(doc)
    expect(clone.features![0].file_id).toBe('file-1')
    expect(clone.features![1].file_id).toBe('file-2')
    expect(clone).toEqual(doc)
  })
})

describe('undo/redo round-trip keeps the import reference', () => {
  const docWith = (extraSketchIds: string[] = []): PartDoc => ({
    version: 1,
    kind: 'part',
    features: [
      { id: 'imp1', kind: 'import_step', label: 'part.step', file_id: 'file-1' },
      ...extraSketchIds.map(id => ({ id, kind: 'sketch', label: `sketch ${id}` })),
    ],
  })

  it('restores the file_id after undo and redo', () => {
    const docA = docWith()
    const docB = docWith(['sk1'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<PartDoc | null>) => { docRef.current = d as PartDoc })
    const { result } = renderHookStrict(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, vi.fn()))

    act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA))
    act(() => result.current.handleUndo())

    expect(docRef.current).toEqual(docA)
    expect(docRef.current!.features![0].file_id).toBe('file-1')
    expect(docRef.current!.features).toHaveLength(1)

    act(() => result.current.handleRedo())
    expect(docRef.current).toEqual(docB)
    expect(docRef.current!.features![0].file_id).toBe('file-1')
    expect(docRef.current!.features).toHaveLength(2)
  })

  it('mutating the restored doc other fields cannot corrupt the reference', () => {
    const docA = docWith()
    const docB = docWith(['sk1'])
    const docRef = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<PartDoc | null>) => { docRef.current = d as PartDoc })
    const { result } = renderHookStrict(() =>
      useUndoRedo(docRef as React.MutableRefObject<PartDoc | null>, setDoc, vi.fn()))

    act(() => result.current.pushUndo({ type: 'add_sketch' } as Mutation, docA))
    act(() => result.current.handleUndo())

    const restored = docRef.current!
    restored.features![0].label = 'renamed'
    expect(restored.features![0].file_id).toBe('file-1')

    act(() => result.current.handleRedo())
    expect(docRef.current).toEqual(docB)
    expect(docRef.current!.features![0].file_id).toBe('file-1')
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

  it('a new import references a NEW file while the old entry still references the old one', () => {
    docRef.current = { oversolved: 1, kind: 'part', features: [] } as PartDoc
    const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))

    act(() => result.current.handleMutation({ type: 'add_import_step', featureId: 'imp1', fileId: 'file-a', label: 'a.step' }))
    act(() => result.current.handleMutation({ type: 'add_import_step', featureId: 'imp2', fileId: 'file-b', label: 'b.step' }))

    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['imp1', 'imp2'])
    expect((docRef.current!.features![1] as PartFeature).file_id).toBe('file-b')

    // Undo to the single-import doc: the old entry restores file-a.
    act(() => result.current.handleUndo())
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['imp1'])
    expect((docRef.current!.features![0] as PartFeature).file_id).toBe('file-a')

    // Redo restores the re-imported doc with the NEW file on the new feature.
    act(() => result.current.handleRedo())
    expect((docRef.current!.features ?? []).map(f => f.id)).toEqual(['imp1', 'imp2'])
    expect((docRef.current!.features![0] as PartFeature).file_id).toBe('file-a')
    expect((docRef.current!.features![1] as PartFeature).file_id).toBe('file-b')
  })
})
