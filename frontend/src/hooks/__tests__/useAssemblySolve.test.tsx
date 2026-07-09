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
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: h.setRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))
vi.mock('@/adapters/backend', () => ({
  backendBundle: { documents: { list: h.list, load: h.load } },
}))

import { useAssemblySolve, partSpecs, mateSpecs, currentRevs } from '@/hooks/useAssemblySolve'
import { useAssemblyStore } from '@/stores/assemblyStore'

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
  it('carries the grounded flag into the solver part spec', () => {
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

  it('surfaces a solver failure as a store error rather than throwing', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue(null)
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    expect(useAssemblyStore.getState().solveError).toMatch(/unavailable/)
    expect(useAssemblyStore.getState().isSolving).toBe(false)
  })

  it('registers relay handlers that reach the document store and the OCC bundle builder', async () => {
    h.load.mockResolvedValue({ content: 'kind: part\nfeatures: []' })
    renderHook(() => useAssemblySolve('asm-1', null))

    const handlers = h.setRelayHandlers.mock.calls[0][0]
    expect(await handlers.partDocContent('doc-a')).toEqual({ kind: 'part', features: [] })

    await handlers.buildBundle('doc-a', 4, { kind: 'part' })
    expect(h.buildBundleViaWorker).toHaveBeenCalledWith({ kind: 'part' }, 'doc-a', 4)
  })
})
