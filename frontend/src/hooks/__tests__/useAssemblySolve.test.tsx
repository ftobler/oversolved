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
  list: vi.fn(),
  load: vi.fn(),
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  cancelAssemblySolver: h.cancelAssemblySolver,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))
vi.mock('@/adapters/backend', () => ({
  backendBundle: { documents: { list: h.list, load: h.load } },
}))

import { useAssemblySolve, partSpecs, mateSpecs, currentRevs } from '@/hooks/useAssemblySolve'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { assemblyBodyId } from '@/utils/assemblyBodies'
import { assemblyVerdict } from '@/utils/core/assemblyStatus'

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
      angle: undefined,
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
})

describe('currentRevs', () => {
  beforeEach(() => vi.clearAllMocks())

  it('prefers the store rev over the rev recorded at placement', async () => {
    h.list.mockResolvedValue([{ uuid: 'doc-p1', meta: { rev: 9 } }])
    expect(await currentRevs(docWith(instance('p1')))).toEqual({ 'doc-p1': 9 })
  })

  it('falls back to the recorded rev when the store is unreachable', async () => {
    h.list.mockRejectedValue(new Error('offline'))
    expect(await currentRevs(docWith(instance('p1')))).toEqual({ 'doc-p1': 1 })
  })

  it('moves the solve key when the part is edited after being instanced', async () => {
    // PS-H1: the instance pins the doc_rev it was inserted at, so editing the
    // part afterwards must re-key `${doc_id}@${rev}` from the store's CURRENT
    // meta.rev. Reading the pinned rev instead would cache-hit the stale bundle
    // and paint the assembly with pre-edit geometry.
    const asm = docWith(instance('p1', { doc_rev: 1 }))
    h.list.mockResolvedValue([{ uuid: 'doc-p1', meta: { rev: 7 } }])
    expect(await currentRevs(asm)).toEqual({ 'doc-p1': 7 })
  })
})

describe('useAssemblySolve', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.list.mockResolvedValue([])
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

  it('two requestSolve calls in one burst call documents.list() once', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gate; return okResponse })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })
    expect(h.list).toHaveBeenCalledTimes(1)  // fetched for the in-flight solve

    // Queues a trailing solve while the first is blocked -- reuses the
    // burst's already-fetched rev map instead of listing again.
    await act(async () => { result.current.requestSolve() })
    expect(h.list).toHaveBeenCalledTimes(1)

    await act(async () => { release(); await gate })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.list).toHaveBeenCalledTimes(1)

    // A fresh burst after this one drains re-fetches: revs are not cached forever.
    await act(async () => { result.current.requestSolve() })
    expect(h.list).toHaveBeenCalledTimes(2)
  })

  it('a live drag burst reuses the rev map instead of re-listing documents', async () => {
    // Revs are stable across a drag; live ticks reuse the first solve's map so
    // the bundle stays a cache hit and a drag never re-issues documents.list().
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
    expect(h.list).toHaveBeenCalledTimes(1)

    // Queues a trailing live tick while the first is blocked; it reuses the
    // burst's already-fetched rev map instead of listing again.
    await act(async () => { result.current.requestSolve() })
    expect(h.list).toHaveBeenCalledTimes(1)

    await act(async () => { release(); await gate })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.list).toHaveBeenCalledTimes(1)  // the trailing tick reused lastRevs

    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('a mid-burst part edit invalidates the rev cache so the trailing solve re-fetches', async () => {
    // The rev cache is keyed to the doc's recorded instance revs; a part edited
    // mid-burst updates the assembly doc with the bumped rev, so the trailing
    // solve must not reuse the pre-edit map.
    const before = docWith(instance('p1'))  // the part is at rev 1 when the burst starts
    const after = docWith(instance('p1', { doc_rev: 9 }))  // the edit bumps the recorded rev

    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gateA; return okResponse })

    // The store agrees with each doc's recorded rev at its fetch.
    h.list.mockResolvedValueOnce([{ uuid: 'doc-p1', meta: { rev: 1 } }])
    h.list.mockResolvedValueOnce([{ uuid: 'doc-p1', meta: { rev: 9 } }])

    const { result, rerender } = renderHook(
      ({ doc }: { doc: AssemblyDoc }) => useAssemblySolve('asm-1', doc),
      { initialProps: { doc: before } },
    )

    await act(async () => { result.current.requestSolve() })  // solve #1 fetches revs for the pre-edit doc
    expect(h.list).toHaveBeenCalledTimes(1)

    // The part edit reaches the assembly doc mid-burst; the cached map predates
    // it, so the trailing solve must re-fetch rather than reuse the old key.
    await act(async () => { rerender({ doc: after }) })
    await act(async () => { result.current.requestSolve() })  // queues a trailing solve

    await act(async () => { releaseA(); await gateA })
    await act(async () => {})  // the trailing solve runs

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.list).toHaveBeenCalledTimes(2)  // the key change invalidated the cache
    expect(h.solveAssemblyViaWorker.mock.calls[1][2]).toEqual({ 'doc-p1': 9 })
  })

  it('surfaces a solver failure as a store error rather than throwing', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue(null)
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    expect(useAssemblyStore.getState().solveStatus?.error).toMatch(/unavailable/)
    expect(useAssemblyStore.getState().isSolving).toBe(false)
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

  it('registers relay handlers that reach the document store and the OCC bundle builder', async () => {
    h.load.mockResolvedValue({ content: 'kind: part\nfeatures: []' })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    expect(await handlers.partDocContent('doc-a')).toEqual({ kind: 'part', features: [] })
    expect(h.load).toHaveBeenCalledWith('doc-a')

    await handlers.buildBundle('doc-a', 4, { kind: 'part' })
    // The relay stamps the doc id onto the raw PartDoc YAML so the OCC worker's
    // doc-keyed cache-reset guard fires between bundle builds of different docs.
    expect(h.buildBundleViaWorker).toHaveBeenCalledWith({ kind: 'part', id: 'doc-a' }, 'doc-a', 4)
  })

  it('relay partDocContent migrates a legacy singular transform body to the plural list', async () => {
    // The anchor solver relays raw PartDoc YAML to the OCC worker, which reads
    // only `bodies`; a legacy singular `body` would silently fail the solve.
    h.load.mockResolvedValue({
      content: 'kind: part\nfeatures:\n  - id: t1\n    kind: transform\n    transform:\n      body: "@body_ex1"\n      operation: new\n',
    })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    const doc = (await handlers.partDocContent('doc-a')) as Record<string, unknown>
    const sub = (doc.features as Array<Record<string, unknown>>)[0].transform as Record<string, unknown>
    expect(sub.bodies).toEqual(['@body_ex1'])
    expect('body' in sub).toBe(false)
  })
})
