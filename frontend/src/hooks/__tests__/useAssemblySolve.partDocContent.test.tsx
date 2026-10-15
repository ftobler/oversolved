// The solve relay reads a bundle part through the same loader as the editor:
// a legacy singular `body` arrives plural, and a part the loader refuses fails
// the bundle by name and field instead of reaching the OCC worker half-parsed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { WorkspaceSession } from '@/workspace/session'

const h = vi.hoisted(() => ({
  solveAssemblyViaWorker: vi.fn(),
  cancelAssemblySolver: vi.fn(),
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
  buildBundleViaWorker: vi.fn(),
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  cancelAssemblySolver: h.cancelAssemblySolver,
  setRelayHandlers: h.setRelayHandlers,
  clearRelayHandlers: h.clearRelayHandlers,
}))
vi.mock('@/kernel/worker/solverClient', () => ({ buildBundleViaWorker: h.buildBundleViaWorker }))
vi.mock('@/adapters/backend', () => ({ backendBundle: { documents: { load: vi.fn(), list: vi.fn() } } }))

import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'

interface RelayHandlers {
  partDocContent: (docId: string) => Promise<Record<string, unknown>>
}

function installSession(text: string): void {
  useWorkspaceSessionStore.getState().setSession({
    workspace: 'ws',
    readEntry: async (id: string) => ({ id, kind: 'document', name: 'Bracket', docKind: 'part', text }),
    resolveFile: async () => undefined,
  } as unknown as WorkspaceSession)
}

function relayHandlers(): RelayHandlers {
  renderHook(() => useAssemblySolve('asm-1', null))
  return h.setRelayHandlers.mock.calls[0][0] as RelayHandlers
}

describe('useAssemblySolve partDocContent relay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useWorkspaceSessionStore.getState().setSession(null as unknown as WorkspaceSession)
  })

  it('returns the migrated document for a legacy singular transform body', async () => {
    installSession('kind: part\nfeatures:\n  - id: t1\n    kind: transform\n    transform:\n      body: "@b1"\n')
    const doc = await relayHandlers().partDocContent('p1')
    const transform = ((doc.features as Array<Record<string, unknown>>)[0]).transform as Record<string, unknown>
    expect(transform.bodies).toEqual(['@b1'])
    expect('body' in transform).toBe(false)
  })

  it('rejects a part the loader refuses, naming the field', async () => {
    installSession('kind: part\nfeatures:\n  - id: ex1\n    kind: extrude\n    extrude:\n      distance: .nan\n')
    await expect(relayHandlers().partDocContent('p1')).rejects.toThrow(/features\[0\]\.extrude\.distance/)
  })

  it('refuses when no workspace is open', async () => {
    useWorkspaceSessionStore.getState().setSession(null as unknown as WorkspaceSession)
    await expect(relayHandlers().partDocContent('p1')).rejects.toThrow(/No workspace is open/)
  })
})
