import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

const h = vi.hoisted(() => ({
  solveAssemblyViaWorker: vi.fn(),
  setRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
  list: vi.fn(),
  load: vi.fn(),
  cloudLoad: vi.fn(),
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: h.setRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))
vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: { list: h.list, load: h.load },
    cloudDocuments: { load: h.cloudLoad },
  },
}))

import { useAssemblySolve, partSpecs, mateSpecs, currentRevs } from '@/hooks/useAssemblySolve'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'
import { assemblyBodyId } from '@/utils/assemblyBodies'

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
  payload: { transforms: {}, bodies: {}, mateResults: {} },
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

  it('surfaces a solver failure as a store error rather than throwing', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue(null)
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    expect(useAssemblyStore.getState().solveError).toMatch(/unavailable/)
    expect(useAssemblyStore.getState().isSolving).toBe(false)
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
        mateResults: {},
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
    expect(h.cloudLoad).not.toHaveBeenCalled()  // local hit needs no cloud round-trip

    await handlers.buildBundle('doc-a', 4, { kind: 'part' })
    // The relay stamps the doc id onto the raw PartDoc YAML so the OCC worker's
    // doc-keyed cache-reset guard fires between bundle builds of different docs.
    expect(h.buildBundleViaWorker).toHaveBeenCalledWith({ kind: 'part', id: 'doc-a' }, 'doc-a', 4)
  })

  it('falls back to the cloud store for a part with no local mirror', async () => {
    // A part instanced from the picker's cloud category exists only in the
    // cloud domain; the relay must resolve it there when the local load misses.
    h.load.mockRejectedValue(new Error('not found'))
    h.cloudLoad.mockResolvedValue({ content: 'kind: part\nfeatures: [{id: f1}]' })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    expect(await handlers.partDocContent('doc-cloud')).toEqual({ kind: 'part', features: [{ id: 'f1' }] })
    expect(h.cloudLoad).toHaveBeenCalledWith('doc-cloud')
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
