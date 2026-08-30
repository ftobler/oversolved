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
import { useAssemblyStore } from '@/stores/assemblyStore'
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
  payload: { transforms: {}, bodies: {}, mateResults: {} },
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

    // The worker never replies: both solving flags stay up (LoadingOverlay reads
    // the solver store) and no solveError has been raised.
    expect(useSolverStore.getState().isSolving).toBe(true)
    expect(useAssemblyStore.getState().isSolving).toBe(true)
    expect(useAssemblyStore.getState().solveError).toBeNull()

    // The user cancels through the shared overlay slot.
    await act(async () => {
      useSolverStore.getState().onCancelSolve?.()
    })

    expect(h.cancelAssemblySolver).toHaveBeenCalledTimes(1)
    expect(useSolverStore.getState().isSolving).toBe(false)
    expect(useAssemblyStore.getState().isSolving).toBe(false)
    // A cancel is benign: no solveError banner.
    expect(useAssemblyStore.getState().solveError).toBeNull()

    // The coalescer is not permanently wedged: a later request runs a real solve.
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(useAssemblyStore.getState().isSolving).toBe(false)
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
