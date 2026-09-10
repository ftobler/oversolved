// The stale-scene regression, pinned at the version guard: an in-flight assembly
// solve paints its pre-undo result over the restored doc (the part editor guards
// this via requestIdRef, the assembly path did not). A solve captures the version
// when it starts, and a request that landed meanwhile (undo/redo restoring a doc
// is the classic case) drops its result. The queued re-solve owns the record.
//
// The undo side is exercised through the REAL useAssemblyUndoRedo so the
// manipulation/gizmoDrag/settlingOffsets clears it performs are what the tests
// pin, not a hand-rolled reset.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { assemblyBodyId } from '@/utils/assemblyBodies'

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
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import {
  useAssemblyStore,
  setAssemblyCallbacks,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'

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

function solveResponse(tx: number) {
  return {
    id: 1,
    kind: 'solveAssembly' as const,
    ok: true as const,
    payload: {
      transforms: { p1: { ...IDENTITY_TRANSFORM, tx } },
      bodies: { p1: [meshPayload()] },
    },
  }
}

describe('useAssemblySolve staleness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.list.mockResolvedValue([])
    h.solveAssemblyViaWorker.mockResolvedValue(null)
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    // manipulation/gizmoDrag/settlingOffsets/pickScopeEntity/hoverHits are
    // store-owned, so setSnapshot above does not reset them.
    useAssemblyStore.setState({
      manipulation: null, gizmoDrag: null, settlingOffsets: {},
      pickScopeEntity: null, hoverHits: [], solveStatus: null,
    })
    setAssemblyCallbacks(null)
  })

  it('drops a pre-undo solve result and lets the queued restored-doc solve win', async () => {
    const docA = docWith(instance('p1'))  // the doc the in-flight solve is for
    const docB = docWith(instance('p1'), instance('p2'))  // the doc undo restores
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gateA; return solveResponse(111) })
      .mockImplementationOnce(async () => { await gateB; return solveResponse(0) })

    const docRef: React.MutableRefObject<AssemblyDoc | null> = { current: docA }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const { result, rerender } = renderHook(
      ({ doc }: { doc: AssemblyDoc }) => {
        const solve = useAssemblySolve('asm-1', doc)
        const undoRedo = useAssemblyUndoRedo(docRef, setDoc, solve.requestSolve)
        return { solve, undoRedo }
      },
      { initialProps: { doc: docA } },
    )

    // A solve for the current doc A is in flight.
    await act(async () => { result.current.solve.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    // Undo restores doc B and asks for a re-solve, which bumps the version.
    act(() => { result.current.undoRedo.pushUndo(docB, 'Add part') })
    await act(async () => {
      result.current.undoRedo.handleUndo()
      rerender({ doc: docB })  // the restored doc reaches the solve hook's docRef
    })

    // The in-flight A solve lands late: it must be dropped, not painted over B.
    await act(async () => { releaseA(); await gateA })
    await act(async () => {})
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)  // the queued B solve started
    const mid = useAssemblyStore.getState()
    expect(mid.transforms.p1).toBeUndefined()  // A's scene was never written
    expect(mid.bodies[assemblyBodyId('p1', 0)]).toBeUndefined()

    // The queued B solve lands and wins.
    await act(async () => { releaseB(); await gateB })
    const store = useAssemblyStore.getState()
    expect(store.transforms.p1.tx).toBe(0)
    expect(store.bodies[assemblyBodyId('p1', 0)]).toBeDefined()
  })

  it('discards a stale live-drag solve result', async () => {
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })
    useAssemblyStore.getState().beginPartManipulation('p1')
    useAssemblyStore.getState().dragPartTranslate([10, 0, 0])

    const dragResponse = (tx: number) => ({
      id: 1,
      kind: 'solveAssembly' as const,
      ok: true as const,
      payload: {
        transforms: { p1: { ...IDENTITY_TRANSFORM, tx }, p2: { ...IDENTITY_TRANSFORM, tx } },
        bodies: { p1: [meshPayload()], p2: [meshPayload()] },
      },
    })
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gateA; return dragResponse(42) })
      .mockImplementationOnce(async () => { await gateB; return dragResponse(5) })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    // A second request invalidates the in-flight drag tick (the undo mid-drag case).
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    await act(async () => { releaseA(); await gateA })
    await act(async () => {})
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)  // the queued tick runs
    const mid = useAssemblyStore.getState()
    expect(mid.transforms.p2.tx).not.toBe(42)  // the stale tick's pose was never written
    expect(mid.bodies[assemblyBodyId('p2', 0)]).toBeUndefined()

    await act(async () => { releaseB(); await gateB })
    const store = useAssemblyStore.getState()
    // The stale tick's p2 pose was dropped; the queued tick's result wins.
    expect(store.transforms.p2.tx).toBe(5)
    expect(store.transforms.p2.tx).not.toBe(42)
    expect(store.bodies[assemblyBodyId('p2', 0)]).toBeDefined()

    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('mid-drag undo nulls the session and a later pointer-up cannot commit it', () => {
    const docA = docWith(instance('p1'))  // the doc undo restores
    const docB = docWith(instance('p1'), instance('p2'))  // the doc being dragged
    const docRef: React.MutableRefObject<AssemblyDoc | null> = { current: docB }
    const setDoc = vi.fn((d: React.SetStateAction<AssemblyDoc | null>) => { docRef.current = d as AssemblyDoc })
    const requestSolve = vi.fn()
    const mutateDoc = vi.fn((_label: string, _fn: (d: AssemblyDoc) => AssemblyDoc) => {})
    const { result } = renderHookStrict(() => useAssemblyUndoRedo(docRef, setDoc, requestSolve))
    setAssemblyCallbacks({ mutateDoc, mutateDocSession: mutateDoc, requestSolve })
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: docB })

    act(() => { result.current.pushUndo(docA, 'Move part') })
    act(() => {
      const s = useAssemblyStore.getState()
      expect(s.beginPartManipulation('p1')).toBe(true)
      s.setGizmoDrag({ kind: 'axis', axis: 'x' })
      s.dragPartTranslate([3, 0, 0])
      useAssemblyStore.setState({
        settlingOffsets: { p1: { ...IDENTITY_TRANSFORM, tx: 3 } },
        pickScopeEntity: 'P|1|face|0',
        hoverHits: [{ entityKey: 'P|1|face|0' }],
      })
    })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()
    expect(useAssemblyStore.getState().gizmoDrag).not.toBeNull()

    act(() => { result.current.handleUndo() })
    const afterUndo = useAssemblyStore.getState()
    expect(afterUndo.manipulation).toBeNull()
    expect(afterUndo.gizmoDrag).toBeNull()
    expect(afterUndo.settlingOffsets).toEqual({})
    expect(afterUndo.pickScopeEntity).toBeNull()
    expect(afterUndo.hoverHits).toEqual([])

    // Pointer-up on the restored doc must not commit the abandoned drag: the
    // store's endPartManipulation early-returns on a null manipulation.
    act(() => { useAssemblyStore.getState().endPartManipulation() })
    expect(mutateDoc).not.toHaveBeenCalled()
    expect(result.current.undoStack).toHaveLength(0)
  })

  it('a non-stale solve still applies normally', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue(solveResponse(7))
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })

    const store = useAssemblyStore.getState()
    expect(store.transforms.p1.tx).toBe(7)
    expect(store.bodies[assemblyBodyId('p1', 0)]).toBeDefined()
    expect(store.isSolving).toBe(false)
  })

  it('a stale non-live failure does not surface a solveError under a newer live tick', async () => {
    // The queued live tick owns the record: a live drag skips the full-solve
    // error clear, so the stale full solve's failure must not write a banner
    // the drag's success would then never clear.
    setAssemblyCallbacks(null)
    useAssemblyStore.getState().setSnapshot({
      ...DEFAULT_ASSEMBLY_EDITOR_DATA,
      doc: docWith(instance('p1'), instance('p2')),
      transforms: { p1: { ...IDENTITY_TRANSFORM }, p2: { ...IDENTITY_TRANSFORM } },
    })

    const dragResponse = (tx: number) => ({
      id: 1,
      kind: 'solveAssembly' as const,
      ok: true as const,
      payload: {
        transforms: { p1: { ...IDENTITY_TRANSFORM, tx }, p2: { ...IDENTITY_TRANSFORM, tx } },
        bodies: { p1: [meshPayload()], p2: [meshPayload()] },
      },
    })
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gateA; throw new Error('stale failure') })
      .mockImplementationOnce(async () => { await gateB; return dragResponse(5) })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'), instance('p2'))))

    await act(async () => { result.current.requestSolve() })  // full solve A starts non-live
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    // A drag starts while A is in flight; its request supersedes A.
    act(() => {
      useAssemblyStore.getState().beginPartManipulation('p1')
      useAssemblyStore.getState().dragPartTranslate([10, 0, 0])
    })
    await act(async () => { result.current.requestSolve() })  // queues the live tick
    await act(async () => { releaseA(); await gateA })  // A fails after the bump
    await act(async () => {})  // the queued live tick starts and blocks on its gate

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(useAssemblyStore.getState().solveStatus?.error).toBeUndefined()  // stale failure dropped

    await act(async () => { releaseB(); await gateB })
    const store = useAssemblyStore.getState()
    expect(store.solveStatus?.error).toBeUndefined()
    expect(store.transforms.p2.tx).toBe(5)  // the live tick applied its result
    expect(store.isSolving).toBe(false)

    useAssemblyStore.getState().cancelPartManipulation()
  })

  it('unmount mid-solve drops the result and a remount starts clean', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gate; return solveResponse(111) })
      .mockImplementationOnce(async () => solveResponse(0))

    const first = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    await act(async () => { first.result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    // Unmount while the solve is in flight: the cleanup bumps the version so the
    // late result cannot paint into the shared store.
    first.unmount()
    await act(async () => { release(); await gate })
    await act(async () => {})
    const after = useAssemblyStore.getState()
    expect(after.transforms.p1).toBeUndefined()
    expect(after.bodies[assemblyBodyId('p1', 0)]).toBeUndefined()

    // A remount gets a fresh version and a clean queue: one request, one solve.
    const second = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    await act(async () => { second.result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(useAssemblyStore.getState().transforms.p1.tx).toBe(0)
  })

  it('a uuid change mid-burst drops the old IIFE queued runs against the old assembly', async () => {
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gateA; return solveResponse(1) })
      .mockImplementationOnce(async () => { await gateB; return solveResponse(2) })

    const { result, rerender } = renderHook(
      ({ uuid }: { uuid: string }) => useAssemblySolve(uuid, docWith(instance('p1'))),
      { initialProps: { uuid: 'asm-1' } },
    )

    await act(async () => { result.current.requestSolve() })  // solve #1 in flight against asm-1
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    await act(async () => { result.current.requestSolve() })  // queued against asm-1
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)

    // The doc switches mid-burst: the old drain must drop its queued solve and
    // the new uuid owns the in-flight slot.
    await act(async () => { rerender({ uuid: 'asm-2' }) })
    await act(async () => { releaseA(); await gateA })
    await act(async () => {})  // the new uuid's drain runs; the old queued run is dropped

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)  // no second solve against asm-1
    expect(h.solveAssemblyViaWorker.mock.calls[1][0]).toBe('asm-2')
    expect(useAssemblyStore.getState().transforms.p1).toBeUndefined()  // old result dropped

    await act(async () => { releaseB(); await gateB })
    expect(useAssemblyStore.getState().transforms.p1.tx).toBe(2)
  })

  it('a uuid round-trip does not let a stranded drain release the in-flight slot', async () => {
    // asm-1 -> asm-2 -> asm-1 with all three drains blocked: D1's late resolve
    // must not release the record D3 owns (a uuid equality check would see
    // asm-1 === asm-1 and release it), or a fresh request would start a fourth
    // drain while D3 is still genuinely solving.
    let release1!: () => void
    const gate1 = new Promise<void>(r => { release1 = r })
    let release2!: () => void
    const gate2 = new Promise<void>(r => { release2 = r })
    let release3!: () => void
    const gate3 = new Promise<void>(r => { release3 = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gate1; return solveResponse(1) })
      .mockImplementationOnce(async () => { await gate2; return solveResponse(2) })
      .mockImplementationOnce(async () => { await gate3; return solveResponse(3) })
      .mockImplementationOnce(async () => solveResponse(4))  // the queued trailing solve

    const { result, rerender } = renderHook(
      ({ uuid }: { uuid: string }) => useAssemblySolve(uuid, docWith(instance('p1'))),
      { initialProps: { uuid: 'asm-1' } },
    )

    await act(async () => { result.current.requestSolve() })  // D1 (asm-1) in flight
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    await act(async () => { rerender({ uuid: 'asm-2' }) })  // switch starts D2
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    await act(async () => { rerender({ uuid: 'asm-1' }) })  // switch back starts D3
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(3)

    // D1 resolves late. If it had released the in-flight slot, this fresh
    // request would start a fourth drain; it must instead just queue.
    await act(async () => { release1(); await gate1 })
    await act(async () => { result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(3)

    // The survivors drain in order; the final (queued) solve captures the latest
    // version and wins the scene.
    await act(async () => { release2(); await gate2 })
    await act(async () => { release3(); await gate3 })
    await act(async () => {})
    expect(useAssemblyStore.getState().transforms.p1.tx).toBe(4)
    expect(useAssemblyStore.getState().isSolving).toBe(false)
  })

  // The assembly flag's ownership guard: a stale hook instance from a previous
  // document resolves after a new editor mounted and started its own solve.
  // Its finally must not clear the new mount's spinner, so ownership of that
  // clear is proven by a monotonic full-solve sequence, not by instance state.
  it("a stale mount's late full solve does not clear a new mount's running solve", async () => {
    useAssemblyStore.setState({ isSolving: false })
    let releaseA!: () => void
    const gateA = new Promise<void>(r => { releaseA = r })
    let releaseB!: () => void
    const gateB = new Promise<void>(r => { releaseB = r })
    h.solveAssemblyViaWorker
      .mockImplementationOnce(async () => { await gateA; return solveResponse(111) })
      .mockImplementationOnce(async () => { await gateB; return solveResponse(222) })

    const first = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    await act(async () => { first.result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    expect(useAssemblyStore.getState().isSolving).toBe(true)

    // A dies with its solve still hung; B remounts for another document and
    // its own full solve takes the spinner over.
    first.unmount()
    const second = renderHook(() => useAssemblySolve('asm-2', docWith(instance('p2'))))
    await act(async () => { second.result.current.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(useAssemblyStore.getState().isSolving).toBe(true)

    // A's hang resolves late: it must leave B's solving flag alone.
    await act(async () => { releaseA(); await gateA })
    await act(async () => {})
    expect(useAssemblyStore.getState().isSolving).toBe(true)

    // B finishing is what clears it.
    await act(async () => { releaseB(); await gateB })
    await act(async () => {})
    expect(useAssemblyStore.getState().isSolving).toBe(false)
  })

  // The symmetric half: an unmount mid-hang clears the assembly flag right
  // away instead of waiting on a finally the hung solve may never reach.
  it('unmounting mid-full-solve clears the assembly solving flag immediately', async () => {
    useAssemblyStore.setState({ isSolving: false })
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    h.solveAssemblyViaWorker.mockImplementationOnce(async () => { await gate; return solveResponse(111) })

    const first = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))
    await act(async () => { first.result.current.requestSolve() })
    expect(useAssemblyStore.getState().isSolving).toBe(true)

    first.unmount()
    expect(useAssemblyStore.getState().isSolving).toBe(false)

    // The hung solve resolving afterwards must not resurrect the flag either.
    await act(async () => { release(); await gate })
    await act(async () => {})
    expect(useAssemblyStore.getState().isSolving).toBe(false)
  })
})
