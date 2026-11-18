import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'

// A hung anchor solver is unrecoverable without a cancel: solveAssemblyViaWorker
// never settles, isSolving sticks, and the coalescer's inFlight never resets.
// These tests pin the recovery contract: a user cancel rejects benignly, both
// solving flags clear, and the coalescer runs a real solve afterwards.
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
  backendBundle: {
    documents: { list: h.list, load: h.load },
  },
}))

import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { useSolverStore } from '@/stores/solverStore'

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

describe('assembly solve hang recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.list.mockResolvedValue([])
    h.solveAssemblyViaWorker.mockResolvedValue(okResponse)
  })

  it('registers an onCancelSolve that cancels the anchor worker, and clears it on unmount', () => {
    const { unmount } = renderHook(() => useAssemblySolve('asm-1', null))
    expect(useSolverStore.getState().onCancelSolve).not.toBeNull()
    useSolverStore.getState().onCancelSolve?.()
    expect(h.cancelAssemblySolver).toHaveBeenCalledTimes(1)

    unmount()
    expect(useSolverStore.getState().onCancelSolve).toBeNull()
  })

  it('a worker that never replies keeps the spinner up; cancel clears it benignly and the coalescer recovers', async () => {
    let rejectSolve!: (e: unknown) => void
    const hung = new Promise<never>((_, reject) => { rejectSolve = reject })
    h.solveAssemblyViaWorker.mockImplementationOnce(() => hung)
    // The real client rejects the in-flight solve when cancelAssemblySolver
    // drops the worker; the mock mirrors that by settling the hung promise.
    h.cancelAssemblySolver.mockImplementation(() => {
      rejectSolve(new Error('assembly solve cancelled'))
    })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    // The worker never replies: the solver mirror stays up (LoadingOverlay reads
    // it) and no solve status has been raised.
    expect(useSolverStore.getState().isSolving).toBe(true)
    expect(useAssemblyStore.getState().solveStatus).toBeNull()

    // The user cancels through the shared overlay slot.
    await act(async () => {
      useSolverStore.getState().onCancelSolve?.()
    })

    expect(h.cancelAssemblySolver).toHaveBeenCalledTimes(1)
    expect(useSolverStore.getState().isSolving).toBe(false)
    // A cancel is benign: no solve error banner.
    expect(useAssemblyStore.getState().solveStatus).toBeNull()

    // The coalescer is not permanently wedged: a later request runs a real solve.
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(useSolverStore.getState().isSolving).toBe(false)
  })

  // A live drag tick is deliberately spinner-free (the overlay would cover the
  // scene being dragged), so a tick that hangs leaves the queue -- and the
  // pointer-up full solve queued behind it -- with no cancel affordance at all.
  // The full solve must arm the overlay as soon as it is queued, not when it
  // eventually starts.
  it('a full solve waiting behind a hung live tick surfaces the cancel affordance', async () => {
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1')),
      transforms: { p1: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    let rejectLive!: (e: unknown) => void
    const hung = new Promise<never>((_, reject) => { rejectLive = reject })
    h.solveAssemblyViaWorker.mockImplementationOnce(() => hung)
    h.solveAssemblyViaWorker.mockResolvedValueOnce(okResponse)
    h.cancelAssemblySolver.mockImplementation(() => {
      rejectLive(new Error('assembly solve cancelled'))
    })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    // The tick itself shows no spinner.
    expect(useSolverStore.getState().isSolving).toBe(false)

    // Pointer-up: the drag is over, so the request that lands now is a full
    // solve. It can only queue behind the hung tick.
    await act(async () => {
      useAssemblyStore.getState().cancelPartManipulation()
      result.current.requestSolve()
    })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    expect(useSolverStore.getState().isSolving).toBe(true)

    // The user can now drop the stuck worker, and the queued full solve runs.
    await act(async () => { useSolverStore.getState().onCancelSolve?.() })
    await act(async () => {})
    await act(async () => {})
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(useSolverStore.getState().isSolving).toBe(false)
  })

  // The other half of that decision: a tick queued behind another tick is still
  // a drag, so it must not put the spinner over the dragged scene.
  it('a live tick queued behind a live tick keeps the overlay off', async () => {
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1')),
      transforms: { p1: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gate; return okResponse })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    await act(async () => { result.current.requestSolve() })
    await act(async () => { result.current.requestSolve() })

    expect(useSolverStore.getState().isSolving).toBe(false)

    await act(async () => { release(); await gate })
    await act(async () => {})
    expect(useSolverStore.getState().isSolving).toBe(false)
    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('a superseded solve does not clear the mirror under the newer solve still in flight', async () => {
    // A uuid switch starts a new drain over the old one: D1 (asm-1) and D2
    // (asm-2) overlap, and D1's late settle must not drop the shared spinner
    // while D2 is still genuinely solving (the part path's isCurrent guard).
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gateA; return okResponse })
      .mockImplementationOnce(async () => { await gateB; return okResponse })

    const { result, rerender } = renderHook(
      ({ uuid }: { uuid: string }) => useAssemblySolve(uuid, docWith(instance('p1'))),
      { initialProps: { uuid: 'asm-1' } },
    )

    await act(async () => { result.current.requestSolve() })  // D1 (asm-1) in flight
    expect(useSolverStore.getState().isSolving).toBe(true)

    await act(async () => { rerender({ uuid: 'asm-2' }) })  // the switch starts D2
    await act(async () => {})  // D2's solve arms the mirror
    expect(useSolverStore.getState().isSolving).toBe(true)

    // D1 settles late, superseded: its finally must leave the flag to D2.
    await act(async () => { releaseA(); await gateA })
    await act(async () => {})
    expect(useSolverStore.getState().isSolving).toBe(true)

    // D2 completes; only its finally clears the flag.
    await act(async () => { releaseB(); await gateB })
    await act(async () => {})
    expect(useSolverStore.getState().isSolving).toBe(false)
  })
})
