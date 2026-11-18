// The wiring half of the rebuild feature: the Parts card's button reaches the
// solve hook, and a click is a cold solve (no content hashes) with no edit
// behind it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle } from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import type { WorkspaceSession } from '@/workspace/session'
import { partBundleKey } from '@/workspace/contentHash'

const h = vi.hoisted(() => ({
  solveAssemblyViaWorker: vi.fn(),
  listEntries: vi.fn(),
  referenceEdges: vi.fn(),
}))

// A document with one live part instance, so the first solve has a real content
// hash to send and a cold rebuild is visibly different from it.
const PART_ENTRY = { id: 'doc-p1', kind: 'document', name: 'Bracket', contentHash: 'ch1' }

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async () => ({
        content: [
          'kind: assembly',
          'features:',
          '  - id: inst_p1',
          '    kind: part_instance',
          '    instance:',
          '      handle: p1',
          '      doc_id: doc-p1',
          '      doc_rev: 1',
          '      transform: { tx: 0, ty: 0, tz: 0, qx: 0, qy: 0, qz: 0, qw: 1 }',
          '',
        ].join('\n'),
        name: 'My Assembly',
      })),
      list: vi.fn(async () => []),
      save: vi.fn(),
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({
      captureScreenshotForSaving: vi.fn(),
      whenFramed: (onFramed: () => void) => { onFramed() },
    }))
    return <div data-testid="assembly-viewport" />
  }),
}))

vi.mock('@/kernel/worker/anchorSolverClient', () => ({
  solveAssemblyViaWorker: h.solveAssemblyViaWorker,
  setRelayHandlers: vi.fn(),
  clearRelayHandlers: vi.fn(),
}))
vi.mock('@/kernel/worker/solverClient', () => ({
  buildBundleViaWorker: vi.fn(),
  exportAssemblyViaWorker: vi.fn(),
}))

import AssemblyEditor from '@/pages/AssemblyEditor'
import { ToastProvider } from '@/contexts/ToastContext'

function installSession(): void {
  useWorkspaceSessionStore.setState({
    session: {
      workspace: 'asm-1',
      listEntries: (...args: unknown[]) => h.listEntries(...args),
      readEntry: vi.fn(),
      writeEntry: vi.fn(),
      resolveFile: vi.fn(),
      referencesOf: vi.fn(),
      referenceEdges: (...args: unknown[]) => h.referenceEdges(...args),
      savedRevs: async () => new Map(),
    } as unknown as WorkspaceSession,
  })
}

describe('AssemblyEditor rebuild button', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    installSession()
    h.listEntries.mockResolvedValue([PART_ENTRY])
    h.referenceEdges.mockResolvedValue({})
    h.solveAssemblyViaWorker.mockResolvedValue({
      id: 1,
      kind: 'solveAssembly' as const,
      ok: true as const,
      payload: { transforms: {}, bodies: {} },
    })
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
    useAssemblyStore.getState().clearAssemblyHistory()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  it('clicks through to a cold solve and writes no undo entry', async () => {
    render(
      <MemoryRouter initialEntries={['/workspaces/asm-1/entries/asm-1']}>
        <ToastProvider><AssemblyEditor uuid="asm-1" /></ToastProvider>
      </MemoryRouter>,
    )

    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(1))
    expect(h.solveAssemblyViaWorker.mock.calls[0][2]).toEqual({
      'doc-p1': partBundleKey('ch1', []),
    })

    fireEvent.click(screen.getByRole('button', { name: /Rebuild geometry/i }))

    await waitFor(() => expect(h.solveAssemblyViaWorker).toHaveBeenCalledTimes(2))
    expect(h.solveAssemblyViaWorker.mock.calls[1][2]).toEqual({})
    expect(useAssemblyStore.getState().undoStack).toHaveLength(0)
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  }, 10000)
})
