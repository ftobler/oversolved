import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

const h = vi.hoisted(() => ({
  solveAssemblyViaWorker: vi.fn(),
  cancelAssemblySolver: vi.fn(),
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
  listEntries: vi.fn(),
  readEntry: vi.fn(),
  resolveFile: vi.fn(),
  referenceEdges: vi.fn(),
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  cancelAssemblySolver: h.cancelAssemblySolver,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))

import { useAssemblySolve, partSpecs, mateSpecs, currentHashes } from '@/hooks/useAssemblySolve'
import { partBundleKey } from '@/workspace/contentHash'
import { bumpWorkspaceStoreRevision } from '@/workspace/storeEvents'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import type { WorkspaceSession } from '@/workspace/session'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { useSolverStore } from '@/stores/solverStore'
import { assemblyBodyId } from '@/utils/assemblyBodies'
import { assemblyVerdict } from '@/utils/core/assemblyStatus'
import { DRAG_MATE_ID, DRAG_WEIGHT } from '@/kernel/assemblyDrag'
import { resetFakeIndexedDb } from '@/stores/documentStore/__tests__/fakeIndexedDb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { getFileRegistry } from '@/stores/fileRegistry'

// The relay handlers and currentHashes read the one open workspace session, so a
// test shapes the session instead of a library-wide store.
function installSession(): WorkspaceSession {
  const session = {
    workspace: 'ws-test',
    open: vi.fn(),
    listEntries: (...args: unknown[]) => h.listEntries(...args),
    readEntry: (...args: unknown[]) => h.readEntry(...args),
    writeEntry: vi.fn(),
    resolveFile: (...args: unknown[]) => h.resolveFile(...args),
    referencesOf: vi.fn(),
    referenceEdges: (...args: unknown[]) => h.referenceEdges(...args),
  } as unknown as WorkspaceSession
  useWorkspaceSessionStore.setState({ session })
  return session
}

function meshPayload() {
  return {
    vertices: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0]),
    faceIdsPerTriangle: new Uint32Array([0]),
    edges: [],
  }
}

function instance(handle: string, extra: Partial<PartInstance> = {}): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM }, ...extra }
}

function docWith(...instances: PartInstance[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: instances.map((inst, i) => ({ id: `f${i}`, kind: 'part_instance' as const, instance: inst })),
  }
}

const okResponse = {
  id: 1,
  kind: 'solveAssembly' as const,
  ok: true as const,
  payload: { transforms: {}, bodies: {} },
}

describe('partSpecs / mateSpecs', () => {
  it('carries the fixed flag into the solver part spec', () => {
    const specs = partSpecs(docWith(instance('p1', { fixed: true }), instance('p2')))
    expect(specs.map(s => s.fixed)).toEqual([true, undefined])
  })

  it('reads mate specs from mate features, keyed by feature id', () => {
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [{
        id: 'mate-1',
        kind: 'mate',
        mate: {
          kind: 'fixed',
          ref_a: { part: 'p1', anchor: 'a1' },
          ref_b: { part: 'p2', anchor: 'a2' },
          offset: 3,
          angle: 'w / 2',  // an expression is not evaluated until Stage 8
        },
      }],
    }
    expect(mateSpecs(doc)).toEqual([{
      id: 'mate-1',
      kind: 'fixed',
      ref_a: { part: 'p1', anchor: 'a1' },
      ref_b: { part: 'p2', anchor: 'a2' },
      flip: undefined,
      offset: 3,
      // Authored as-is: the solve boundary refuses an unresolved expression
      // rather than the producer silently dropping it to undefined.
      angle: 'w / 2',
      radius: undefined,
      ratio: undefined,
    }])
  })

  it('carries a vector offset through unflattened', () => {
    // The spec keeps the authored shape: normalizing needs the anchor axis to
    // expand the legacy scalar form, and that only resolves inside the solve.
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [{
        id: 'mate-1',
        kind: 'mate',
        mate: {
          kind: 'fixed',
          ref_a: { part: 'p1', anchor: 'a1' },
          ref_b: { part: 'p2', anchor: 'a2' },
          offset: { x: 1, y: 2, z: 3 },
        },
      }],
    }
    expect(mateSpecs(doc)[0].offset).toEqual({ x: 1, y: 2, z: 3 })
  })

  it('carries the anchor descriptor through to the wire spec on each ref', () => {
    const descriptor = {
      geom_hash: '@gdf|0,0,0', kind: 'point', created_by: 'feat1',
      point: [0, 0, 0] as [number, number, number],
    }
    const doc: AssemblyDoc = {
      kind: 'assembly',
      features: [{
        id: 'mate-1',
        kind: 'mate',
        mate: {
          kind: 'fixed',
          ref_a: { part: 'p1', anchor: 'a1', anchor_descriptor: descriptor },
          ref_b: { part: 'p2', anchor: 'a2' },
        },
      }],
    }
    const spec = mateSpecs(doc)[0]
    expect(spec.ref_a.anchor_descriptor).toEqual(descriptor)
    expect(spec.ref_b.anchor_descriptor).toBeUndefined()
  })
})

describe('currentHashes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceSessionStore.setState({ session: null })
  })

  it('builds the bundle key from the workspace entry content hash', async () => {
    installSession()
    h.listEntries.mockResolvedValue([{ id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch1' }])
    h.referenceEdges.mockResolvedValue({})
    expect(await currentHashes(docWith(instance('p1')))).toEqual({ 'doc-p1': partBundleKey('ch1', []) })
  })

  it('folds referenced file content hashes into the part key', async () => {
    installSession()
    h.listEntries.mockResolvedValue([
      { id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch1' },
      { id: 'f1', kind: 'file', name: 'shaft.step', contentHash: 'fh1' },
    ])
    h.referenceEdges.mockResolvedValue({ 'doc-p1': ['f1'] })
    expect(await currentHashes(docWith(instance('p1')))).toEqual({
      'doc-p1': partBundleKey('ch1', ['fh1']),
    })
  })

  it('changes the part key when a referenced file is replaced (replace-bytes)', async () => {
    installSession()
    h.referenceEdges.mockResolvedValue({ 'doc-p1': ['f1'] })
    h.listEntries.mockResolvedValueOnce([
      { id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch1' },
      { id: 'f1', kind: 'file', name: 'shaft.step', contentHash: 'fh-old' },
    ])
    const first = await currentHashes(docWith(instance('p1')))
    h.listEntries.mockResolvedValueOnce([
      { id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch1' },
      { id: 'f1', kind: 'file', name: 'shaft.step', contentHash: 'fh-new' },
    ])
    const second = await currentHashes(docWith(instance('p1')))
    expect(second['doc-p1']).not.toBe(first['doc-p1'])
  })

  it('omits a part whose content hash is unknown, so the cache is bypassed', async () => {
    installSession()
    h.listEntries.mockResolvedValue([{ id: 'doc-p1', kind: 'document', name: 'P1' }])
    h.referenceEdges.mockResolvedValue({})
    expect(await currentHashes(docWith(instance('p1')))).toEqual({})
  })

  it('returns no keys when the session is unreachable', async () => {
    installSession()
    h.listEntries.mockRejectedValue(new Error('offline'))
    expect(await currentHashes(docWith(instance('p1')))).toEqual({})
  })

  it('returns no keys when no workspace is open', async () => {
    expect(await currentHashes(docWith(instance('p1')))).toEqual({})
  })

  it('moves the solve key when the part is edited after being instanced', async () => {
    // The instance pins the doc_rev it was inserted at, but the bundle cache
    // keys on the workspace entry's CURRENT content hash, so an edit re-keys
    // and cannot cache-hit the pre-edit geometry.
    installSession()
    h.referenceEdges.mockResolvedValue({})
    h.listEntries.mockResolvedValue([{ id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch-before' }])
    const asm = docWith(instance('p1', { doc_rev: 1 }))
    expect(await currentHashes(asm)).toEqual({ 'doc-p1': partBundleKey('ch-before', []) })

    h.listEntries.mockResolvedValue([{ id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch-after' }])
    expect(await currentHashes(asm)).toEqual({ 'doc-p1': partBundleKey('ch-after', []) })
  })
})

describe('useAssemblySolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installSession()
    h.listEntries.mockResolvedValue([])
    h.referenceEdges.mockResolvedValue({})
    h.solveAssemblyViaWorker.mockResolvedValue(okResponse)
  })

  it('solves against the doc as mutated in the same event, not the pre-mutation doc', async () => {
    // The drag commit writes the transform and asks for a re-solve in one event;
    // the new transform must be what reaches the solver.
    const before = docWith(instance('p1'))
    const after = docWith(instance('p1', { transform: { ...IDENTITY_TRANSFORM, tx: 42 } }))

    const { result, rerender } = renderHook(
      ({ doc }) => useAssemblySolve('asm-1', doc),
      { initialProps: { doc: before } },
    )

    await act(async () => {
      result.current.requestSolve()
      rerender({ doc: after })
    })

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    const parts = h.solveAssemblyViaWorker.mock.calls[0][1]
    expect(parts[0].transform.tx).toBe(42)
  })

  it('does not solve on mount', () => {
    renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    expect(h.solveAssemblyViaWorker).not.toHaveBeenCalled()
  })

  it('unregisters the relay handlers on unmount', () => {
    const { unmount } = renderHook(() => useAssemblySolve('asm-1', null))
    expect(h.setRelayHandlers).toHaveBeenCalledTimes(1)
    unmount()
    // A stale worker's relay requests must not be serviced by a dead component.
    expect(h.clearRelayHandlers).toHaveBeenCalledTimes(1)
  })

  it('coalesces requests arriving while a solve is in flight into one trailing solve', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gate; return okResponse })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)  // in flight

    // Three more requests while the first is blocked queue exactly one follow-up.
    await act(async () => {
      result.current.requestSolve()
      result.current.requestSolve()
      result.current.requestSolve()
    })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    await act(async () => { release(); await gate })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
  })

  it('two requestSolve calls in one burst list the workspace entries once', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gate; return okResponse })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })
    expect(h.listEntries).toHaveBeenCalledTimes(1)  // fetched for the in-flight solve

    // Queues a trailing solve while the first is blocked -- reuses the
    // burst's already-fetched hash map instead of listing again.
    await act(async () => { result.current.requestSolve() })
    expect(h.listEntries).toHaveBeenCalledTimes(1)

    await act(async () => { release(); await gate })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.listEntries).toHaveBeenCalledTimes(1)

    // A fresh burst after this one drains re-fetches: hashes are not cached forever.
    await act(async () => { result.current.requestSolve() })
    expect(h.listEntries).toHaveBeenCalledTimes(2)
  })

  it('a live drag burst reuses the hash map instead of re-listing documents', async () => {
    // Hashes are stable across a drag; live ticks reuse the first solve's map so
    // the bundle stays a cache hit and a drag never re-lists workspace entries.
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gate; return okResponse })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))

    await act(async () => { result.current.requestSolve() })  // first live tick fetches once
    expect(h.listEntries).toHaveBeenCalledTimes(1)

    // Queues a trailing live tick while the first is blocked; it reuses the
    // burst's already-fetched hash map instead of listing again.
    await act(async () => { result.current.requestSolve() })
    expect(h.listEntries).toHaveBeenCalledTimes(1)

    await act(async () => { release(); await gate })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.listEntries).toHaveBeenCalledTimes(1)  // the trailing tick reused lastHashes

    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('a mid-burst workspace edit invalidates the hash cache so the trailing solve re-fetches', async () => {
    // The hash cache is keyed to `uuid|workspaceRevision`; a working-copy write
    // mid-burst bumps the revision, so the trailing solve must not reuse the
    // pre-edit map.
    const before = docWith(instance('p1'))
    const after = docWith(instance('p1', { doc_rev: 9 }))

    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gateA; return okResponse })

    // The workspace agrees with each doc's content hash at its fetch.
    h.listEntries.mockResolvedValueOnce([{ id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch-before' }])
    h.listEntries.mockResolvedValueOnce([{ id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch-after' }])

    const { result, rerender } = renderHook(
      ({ doc }: { doc: AssemblyDoc }) => useAssemblySolve('asm-1', doc),
      { initialProps: { doc: before } },
    )

    await act(async () => { result.current.requestSolve() })  // solve #1 fetches hashes for the pre-edit doc
    expect(h.listEntries).toHaveBeenCalledTimes(1)

    // The part edit reaches the working copy mid-burst; the cached map predates
    // it, so the trailing solve must re-fetch rather than reuse the old key.
    bumpWorkspaceStoreRevision()
    await act(async () => { rerender({ doc: after }) })
    await act(async () => { result.current.requestSolve() })  // queues a trailing solve

    await act(async () => { releaseA(); await gateA })
    await act(async () => {})  // the trailing solve runs

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.listEntries).toHaveBeenCalledTimes(2)  // the key change invalidated the cache
    expect(h.solveAssemblyViaWorker.mock.calls[1][2]).toEqual({ 'doc-p1': partBundleKey('ch-after', []) })
  })

  it('surfaces a solver failure as a store error rather than throwing', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue(null)
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    expect(useAssemblyStore.getState().solveStatus?.error).toMatch(/unavailable/)
    expect(useSolverStore.getState().isSolving).toBe(false)
  })

  it('stores an overconstrained verdict from the payload so the banner predicate is true', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue({
      id: 1, kind: 'solveAssembly' as const, ok: true as const,
      payload: {
        transforms: {}, bodies: {},
        status: {
          verdict: 'overconstrained', residualNorm: 0.5, rank: 0, dof: 0, iters: 1,
          mates: { m1: { stale: false } }, parts: {},
        },
      },
    })
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    const status = useAssemblyStore.getState().solveStatus
    expect(status?.verdict).toBe('overconstrained')
    expect(assemblyVerdict(status).failed).toBe(true)
  })

  it('a live triad drag encodes a weighted soft objective, not a fixed body', async () => {
    // The triad used to pin the grabbed part with `fixed: true`, which took its
    // own mates out of the solve and produced the pointer-up jump. It must now
    // ride a weighted target-pose objective instead.
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))
    await act(async () => { result.current.requestSolve() })

    const parts = h.solveAssemblyViaWorker.mock.calls[0][1]
    const mates = h.solveAssemblyViaWorker.mock.calls[0][3]
    const grabbed = parts.find((p: { handle: string }) => p.handle === 'p1')
    expect(grabbed?.fixed).not.toBe(true)
    const dragMate = mates.find((m: { id: string }) => m.id === DRAG_MATE_ID)
    expect(dragMate).toBeDefined()
    expect(dragMate.kind).toBe('fixed')
    expect(dragMate.weight).toBe(DRAG_WEIGHT)

    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('a live drag drops the grabbed part from the re-keyed body/edge dicts', async () => {
    // The grabbed part is pinned in the solve at pose+delta and comes back
    // re-baked there. The render group applies the drag offset on top, so the
    // solved mesh must be dropped or the part would draw at pose+2*delta -- the
    // doubled-drag bug. The drop must survive toBodyResults re-keying the dict
    // from bare handle (`p1`) to `p1:body_0`.
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    h.solveAssemblyViaWorker.mockResolvedValue({
      id: 1, kind: 'solveAssembly' as const, ok: true as const,
      payload: {
        // Keyed by handle: the grabbed part comes back pinned at pose+delta.
        transforms: { p1: { ...IDENTITY_TRANSFORM, tx: 10 }, p2: { ...IDENTITY_TRANSFORM } },
        bodies: { p1: [meshPayload()], p2: [meshPayload()] },
      },
    })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))
    await act(async () => { result.current.requestSolve() })

    const store = useAssemblyStore.getState()
    // The follower lands in the store; the grabbed part is dropped so the live
    // offset is the only thing that moves it.
    expect(store.bodies[assemblyBodyId('p2', 0)]).toBeDefined()
    expect(store.bodies[assemblyBodyId('p1', 0)]).toBeUndefined()
    expect(store.edgeCurves[assemblyBodyId('p1', 0)]).toBeUndefined()
    // Its transform is likewise held at the pre-drag pose, not the pinned one.
    expect(store.transforms.p1).toMatchObject({ tx: 0 })

    setAssemblyCallbacks(null)
    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('flags live drag ticks (and full solves) on the worker request', async () => {
    // The live entry point skips the dense rank/dof SVD; the full entry point is
    // the one on pointer-up that owns the verdict. The wire flag is what selects
    // them worker-side.
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    h.solveAssemblyViaWorker.mockResolvedValue({
      id: 1, kind: 'solveAssembly' as const, ok: true as const,
      payload: {
        transforms: { p2: { ...IDENTITY_TRANSFORM, tx: 4 } },
        bodies: { p2: [meshPayload()] },
        // The live entry point zeroes the diagnostics it skipped.
        status: {
          verdict: 'fully_constrained', residualNorm: 0, rank: 0, dof: 0, iters: 1,
          mates: {}, parts: {},
        },
      },
    })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker.mock.calls[0][4]).toBe(true)
    // A zeroed-diagnostics live reply still installs the follower's transform.
    expect(useAssemblyStore.getState().transforms.p2).toMatchObject({ tx: 4 })

    // Pointer-up clears the manipulation, so the next request is a full solve.
    useAssemblyStore.getState().cancelPartManipulation()
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker.mock.calls[1][4]).toBe(false)
  })

  it('a live drag tick strips the verdict so a per-frame overconstrained cannot flicker the banner', async () => {
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    h.solveAssemblyViaWorker.mockResolvedValue({
      id: 1, kind: 'solveAssembly' as const, ok: true as const,
      payload: {
        transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
        bodies: { p1: [meshPayload()], p2: [meshPayload()] },
        // The solver calls the mid-drag preview overconstrained; the tick still
        // must not raise the banner.
        status: {
          verdict: 'overconstrained', residualNorm: 0.5, rank: 0, dof: 0, iters: 1,
          mates: { m1: { stale: false } }, parts: {},
        },
      },
    })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))
    await act(async () => { result.current.requestSolve() })

    const stored = useAssemblyStore.getState().solveStatus
    expect(stored?.verdict).toBe('none')
    // The per-mate and per-part marks survive the strip.
    expect(stored?.mates).toEqual({ m1: { stale: false } })
    expect(assemblyVerdict(stored).failed).toBe(false)

    setAssemblyCallbacks(null)
    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('registers relay handlers that reach the workspace session and the OCC bundle builder', async () => {
    installSession()
    h.readEntry.mockResolvedValue({ kind: 'document', name: 'P', text: 'kind: part\nfeatures: []' })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    expect(await handlers.partDocContent('doc-a')).toEqual({ kind: 'part', features: [] })
    expect(h.readEntry).toHaveBeenCalledWith('doc-a')

    await handlers.buildBundle('doc-a', 'h4', { kind: 'part' })
    // The relay stamps the doc id onto the raw PartDoc YAML so the OCC worker's
    // doc-keyed cache-reset guard fires between bundle builds of different docs.
    // No import files, so the byte side channel is undefined.
    expect(h.buildBundleViaWorker).toHaveBeenCalledWith({ kind: 'part', id: 'doc-a' }, 'doc-a', 'h4', undefined)
  })

  it('partDocContent refuses a doc_id that is not a live document entry', async () => {
    installSession()
    h.readEntry.mockRejectedValue(new Error('Entry not found: ghost'))
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    await expect(handlers.partDocContent('ghost')).rejects.toThrow(/Entry not found/)
  })

  it('buildBundle resolves bytes through the workspace session before the flat registry', async () => {
    // The workspace entry is authoritative once adopted; the flat registry is
    // the fallback for a STEP the import just staged but did not adopt.
    installSession()
    h.resolveFile.mockResolvedValue(new Uint8Array([7, 7, 7]))
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    const spec = { kind: 'part', features: [{ id: 'imp1', kind: 'import_step', file_id: 'f1' }] }
    await handlers.buildBundle('doc-a', 'h1', spec)

    expect(h.resolveFile).toHaveBeenCalledWith('f1')
    const call = h.buildBundleViaWorker.mock.calls[0]
    expect(Array.from(call[3].f1)).toEqual([7, 7, 7])
  })

  it('C1: resolves import bytes on the main thread before the OCC bundle build', async () => {
    // The anchor worker's spec is reference-only. The registered handler resolves
    // the file id here and forwards bytes to buildBundleViaWorker (the OCC
    // worker), so no byte payload is ever handed to the anchor solver. No
    // workspace session: the flat registry is the documented fallback.
    useWorkspaceSessionStore.setState({ session: null })
    resetFakeIndexedDb()
    resetDbConnection()
    const entry = await getFileRegistry().create({
      name: 'bracket.step', kind: 'step', mime: 'application/step', bytes: new Uint8Array([4, 5, 6]),
    })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    const spec = { kind: 'part', features: [{ id: 'imp1', kind: 'import_step', file_id: entry.id }] }
    await handlers.buildBundle('doc-a', 'h4', spec)

    expect(h.buildBundleViaWorker).toHaveBeenCalledTimes(1)
    const call = h.buildBundleViaWorker.mock.calls[0]
    expect(call[0]).toEqual({ ...spec, id: 'doc-a' })
    expect(call[1]).toBe('doc-a')
    expect(call[2]).toBe('h4')
    expect(Array.from(call[3][entry.id])).toEqual([4, 5, 6])
    // The spec that reached the anchor worker carried no bytes.
    expect(spec.features[0]).not.toHaveProperty('file_data')
  })

  it('relay partDocContent migrates a legacy singular transform body to the plural list', async () => {
    // The anchor solver relays raw PartDoc YAML to the OCC worker, which reads
    // only `bodies`; a legacy singular `body` would silently fail the solve.
    installSession()
    h.readEntry.mockResolvedValue({
      kind: 'document',
      name: 'P',
      text: 'kind: part\nfeatures:\n  - id: t1\n    kind: transform\n    transform:\n      body: "@body_ex1"\n      operation: new\n',
    })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    const doc = (await handlers.partDocContent('doc-a')) as Record<string, unknown>
    const sub = (doc.features as Array<Record<string, unknown>>)[0].transform as Record<string, unknown>
    expect(sub.bodies).toEqual(['@body_ex1'])
    expect('body' in sub).toBe(false)
  })
})
