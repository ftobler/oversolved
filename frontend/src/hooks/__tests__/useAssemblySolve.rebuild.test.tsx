// An assembly rebuild is a cold re-solve: every part bundle bypasses the cache so
// stale geometry is rebuilt from the current part documents. The cold flag is
// one-shot and belongs to the solve the rebuild's own request produces, never to
// a run it superseded (that run's coalesced trailing solve is the cold one).

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

import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { partBundleKey } from '@/workspace/contentHash'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import type { WorkspaceSession } from '@/workspace/session'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function installSession(): void {
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

const PART_ENTRY = { id: 'doc-p1', kind: 'document', name: 'P1', contentHash: 'ch1' }
const REAL_HASHES = { 'doc-p1': partBundleKey('ch1', []) }

describe('useAssemblySolve rebuild', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installSession()
    h.listEntries.mockResolvedValue([PART_ENTRY])
    h.referenceEdges.mockResolvedValue({})
    h.solveAssemblyViaWorker.mockResolvedValue(okResponse)
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().clearAssemblyHistory()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('sends no hashes so every part bundle cold-rebuilds', async () => {
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.rebuild() })

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1)
    // The empty map is the wire's cold signal: solveAssembly skips the bundle
    // cache lookup per part and cannot key a cache write either.
    expect(h.solveAssemblyViaWorker.mock.calls[0][2]).toEqual({})
    // A rebuild with no prior solve still lists once: the entry list is what
    // tells a sub-assembly from a part, and the hashes it computes are then
    // dropped for the cold wire. With a prior solve the cached list is reused.
    expect(h.listEntries).toHaveBeenCalledTimes(1)
  })

  it('is one-shot: the next plain solve sends the real hash map again', async () => {
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.rebuild() })
    expect(h.solveAssemblyViaWorker.mock.calls[0][2]).toEqual({})

    await act(async () => { result.current.requestSolve() })

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    expect(h.solveAssemblyViaWorker.mock.calls[1][2]).toEqual(REAL_HASHES)
  })

  it('a rebuild requested during an in-flight solve cold-rebuilds the queued solve', async () => {
    // Hold the in-flight solve before it chooses its hashes, so the rebuild's
    // request lands while that run is still in the hash fetch. The flag must not
    // be eaten by the superseded run: its coalesced trailing solve is the one
    // the user asked to be cold.
    let releaseHashes!: () => void
    const hashGate = new Promise<void>(r => { releaseHashes = r })
    h.listEntries.mockImplementationOnce(async () => { await hashGate; return [PART_ENTRY] })

    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.requestSolve() })
    expect(h.listEntries).toHaveBeenCalledTimes(1)  // the in-flight solve is at the fetch

    await act(async () => { result.current.rebuild() })

    await act(async () => { releaseHashes(); await hashGate })
    await act(async () => {})

    expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2)
    // The run that was already in flight keeps the real map it fetched; the
    // queued run the rebuild produced is the cold one and lists nothing.
    expect(h.solveAssemblyViaWorker.mock.calls[0][2]).toEqual(REAL_HASHES)
    expect(h.solveAssemblyViaWorker.mock.calls[1][2]).toEqual({})
    expect(h.listEntries).toHaveBeenCalledTimes(1)
  })

  it('writes no undo entry and leaves the document clean', async () => {
    const { result } = renderHook(() => useAssemblySolve('asm-1', docWith(instance('p1'))))

    await act(async () => { result.current.rebuild() })

    // A rebuild re-derives the scene; it is not an edit, so the undo stacks and
    // the unsaved-changes flag must not move.
    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useAssemblyStore.getState().redoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })
})
