// The doc-swap residue regression, pinned end to end: the assembly store is
// module-level and survives a document swap, so a live manipulation/gizmoDrag/
// pick/selection from doc A must not leak into doc B. useAssemblyDoc's load
// resets every store-owned field EXCEPT the undo/redo stacks (clearAssemblyHistory
// owns those), so B's first solve is an ordinary full solve (setSolveResult,
// anchors rebuilt) rather than a live-drag tick (setDragSolveResult). A
// manipulation the reset misses (an in-flight request racing the load) is caught
// by the defensive guard in useAssemblySolve when its handle no longer resolves.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { stringify as stringifyYaml } from 'yaml'
import type { AssemblyDoc, PartInstance } from '@/types/cad'
import { IDENTITY_TRANSFORM } from '@/utils/transform3d'
import { ASSEMBLY_HANDLE } from '@/utils/assemblyBuiltins'

const h = vi.hoisted(() => {
  const make = () => {
    let resolve!: (v: unknown) => void
    let reject!: (e: unknown) => void
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    return { promise, resolve, reject }
  }
  return {
    make,
    loads: {} as Record<string, ReturnType<typeof make>>,
    solveAssemblyViaWorker: vi.fn(),
    setRelayHandlers: vi.fn(),
    clearRelayHandlers: vi.fn(),
    buildBundleViaWorker: vi.fn(),
    list: vi.fn(),
  }
})

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: (uuid: string) => (h.loads[uuid] ??= h.make()).promise,
      list: h.list,
    },
  },
}))
vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))

import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import {
  useAssemblyStore,
  DEFAULT_ASSEMBLY_EDITOR_DATA,
} from '@/stores/assemblyStore'

const tick = () => act(async () => { await new Promise(r => setTimeout(r, 0)) })

function meshPayload() {
  return {
    vertices: new Float32Array([0, 0, 0]),
    indices: new Uint32Array([0]),
    faceIdsPerTriangle: new Uint32Array([0]),
    edges: [],
  }
}

function instance(handle: string): PartInstance {
  return { handle, doc_id: `doc-${handle}`, doc_rev: 1, transform: { ...IDENTITY_TRANSFORM } }
}

function docWith(...instances: PartInstance[]): AssemblyDoc {
  return {
    kind: 'assembly',
    features: instances.map((inst, i) => ({ id: `f${i}`, kind: 'part_instance' as const, instance: inst })),
  }
}

function fullSolveResponse(tx: number) {
  return {
    id: 1,
    kind: 'solveAssembly' as const,
    ok: true as const,
    payload: {
      transforms: { pB: { ...IDENTITY_TRANSFORM, tx } },
      bodies: { pB: [meshPayload()] },
      anchors: {},
      mateResults: {},
    },
  }
}

describe('assembly owned state reset on doc swap', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.loads = {}
    h.list.mockResolvedValue([])
    h.solveAssemblyViaWorker.mockResolvedValue(null)
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    // setSnapshot preserves store-owned fields, so the leftover transient state
    // from a previous test is cleared by the reset under test, not by hand.
    useAssemblyStore.getState().resetTransientAssemblyState()
  })

  it('a doc swap resets every owned field and the new doc first-solves full, never a drag tick', async () => {
    h.solveAssemblyViaWorker.mockResolvedValue(fullSolveResponse(7))
    const docA = docWith(instance('pA'))
    const docB = docWith(instance('pB'))

    const { result, rerender } = renderHook(
      ({ uuid }: { uuid: string }) => {
        const docData = useAssemblyDoc(uuid)
        const solve = useAssemblySolve(uuid, docData.doc)
        return { docData, solve }
      },
      { initialProps: { uuid: 'A' } },
    )
    await tick()
    await act(async () => { h.loads.A.resolve({ content: stringifyYaml(docA), name: 'Asm A' }) })
    await tick()
    expect(result.current.docData.doc?.kind).toBe('assembly')

    // A live manipulation on doc A, left mid-flight (navigating away mid-drag).
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: docA })
    expect(useAssemblyStore.getState().beginPartManipulation('pA')).toBe(true)
    useAssemblyStore.getState().setGizmoDrag({ kind: 'axis', axis: 'x' })
    useAssemblyStore.getState().dragPartTranslate([3, 0, 0])
    useAssemblyStore.setState({
      settlingOffsets: { pA: { ...IDENTITY_TRANSFORM, tx: 3 } },
      pickCandidates: [{ part: ASSEMBLY_HANDLE, anchor: 'AssemblyTop' }],
      pickIndex: 0,
      pickScopeEntity: 'P|1|face|0',
      hoverHits: [{ entityKey: 'P|1|face|0' }],
      selection: new Set(['P|1|face|0']),
      hoveredEntity: 'P|1|face|0',
      selectedPartHandle: 'pA',
      selectedMateId: 'm1',
      activeMateField: { featureId: 'm1', field: 'ref_a' },
      mateFieldDirty: true,
      showPickDebug: true,
    })
    expect(useAssemblyStore.getState().manipulation).not.toBeNull()
    expect(useAssemblyStore.getState().gizmoDrag).not.toBeNull()

    // Doc B loads over the residue.
    rerender({ uuid: 'B' })
    await tick()
    await act(async () => { h.loads.B.resolve({ content: stringifyYaml(docB), name: 'Asm B' }) })
    await tick()

    const reset = useAssemblyStore.getState()
    expect(reset.manipulation).toBeNull()
    expect(reset.gizmoDrag).toBeNull()
    expect(reset.settlingOffsets).toEqual({})
    expect(reset.pickCandidates).toEqual([])
    expect(reset.pickIndex).toBe(-1)
    expect(reset.pickScopeEntity).toBeNull()
    expect(reset.hoverHits).toEqual([])
    expect(reset.selection.size).toBe(0)
    expect(reset.hoveredEntity).toBeNull()
    expect(reset.selectedPartHandle).toBeNull()
    expect(reset.selectedMateId).toBeNull()
    expect(reset.activeMateField).toBeNull()
    expect(reset.mateFieldDirty).toBe(false)
    expect(reset.showPickDebug).toBe(false)
    // History is cleared by clearAssemblyHistory on the load path, never by the
    // transient reset; see the dedicated reset-preserves-stacks test below.
    expect(reset.undoStack).toEqual([])
    expect(reset.redoStack).toEqual([])

    // B's first solve is an ordinary full solve: setSolveResult rebuilds the
    // anchor table and pick lookups, which setDragSolveResult never touches.
    await act(async () => { result.current.solve.requestSolve() })
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    const solved = useAssemblyStore.getState()
    expect(solved.transforms.pB.tx).toBe(7)
    expect(solved.anchors[ASSEMBLY_HANDLE]).toBeDefined()
    expect(Object.keys(solved.entityMateRefs).length).toBeGreaterThan(0)
  })

  it('resetTransientAssemblyState preserves the undo/redo stacks', () => {
    const entry = { doc: docWith(instance('pA')), label: 'stale' }
    useAssemblyStore.setState({ undoStack: [entry], redoStack: [entry] })
    useAssemblyStore.setState({
      manipulation: { handle: 'pA', seed: { ...IDENTITY_TRANSFORM }, current: { ...IDENTITY_TRANSFORM } },
      gizmoDrag: { kind: 'axis', axis: 'x' },
    })

    useAssemblyStore.getState().resetTransientAssemblyState()

    const store = useAssemblyStore.getState()
    expect(store.undoStack).toEqual([entry])
    expect(store.redoStack).toEqual([entry])
    expect(store.manipulation).toBeNull()
    expect(store.gizmoDrag).toBeNull()
  })

  it('a stale manipulation whose handle is gone is cleared and the full solve surfaces errors', async () => {
    const docA = docWith(instance('pA'))
    const docB = docWith(instance('pB'))
    // A manipulation on doc A outlives the doc swap the reset missed (an
    // in-flight request racing the load, say). The store still names docA.
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: docA })
    expect(useAssemblyStore.getState().beginPartManipulation('pA')).toBe(true)
    useAssemblyStore.getState().dragPartTranslate([3, 0, 0])
    // The doc the solve sees no longer contains the grabbed handle.
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: docB })
    expect(useAssemblyStore.getState().manipulation?.handle).toBe('pA')
    expect(useAssemblyStore.getState().gizmoDrag).toBeNull()

    const { result } = renderHook(() => useAssemblySolve('asm-b', docB))
    await act(async () => { result.current.requestSolve() })

    const store = useAssemblyStore.getState()
    expect(store.manipulation).toBeNull()
    expect(store.gizmoDrag).toBeNull()
    // It fell through to the ordinary full solve, not a swallowed live tick.
    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
  })

  it('a stale handle routes a failing solve to setSolveError, not the silent live path', async () => {
    const docA = docWith(instance('pA'))
    const docB = docWith(instance('pB'))
    h.solveAssemblyViaWorker.mockRejectedValue(new Error('solver boom'))
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: docA })
    expect(useAssemblyStore.getState().beginPartManipulation('pA')).toBe(true)
    useAssemblyStore.getState().dragPartTranslate([3, 0, 0])
    useAssemblyStore.getState().setSnapshot({ ...DEFAULT_ASSEMBLY_EDITOR_DATA, doc: docB })

    const { result } = renderHook(() => useAssemblySolve('asm-b', docB))
    await act(async () => { result.current.requestSolve() })

    const store = useAssemblyStore.getState()
    expect(store.manipulation).toBeNull()
    expect(store.solveError).toContain('solver boom')
  })
})
