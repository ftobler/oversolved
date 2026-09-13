import { describe, it, expect, vi, beforeEach } from 'vitest'
import { forwardRef, useImperativeHandle } from 'react'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { getPreviewStore } from '@/stores/previewStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAssemblyStore, DEFAULT_ASSEMBLY_EDITOR_DATA } from '@/stores/assemblyStore'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'

// J6, the assembly half. The assembly editor had no first-solve hook point at
// all, so an assembly opened and never saved carried no preview. The solve hook
// now offers the part editor's `onFirstSolve`, and the editor thumbnails its
// scene through it under the save path's (workspace, entry) key.

const h = vi.hoisted(() => ({
  save: vi.fn(),
  capture: vi.fn(async (): Promise<string | null> => 'data:image/png;base64,QVNN'),
  solveAssemblyViaWorker: vi.fn(),
}))

vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    documents: {
      load: vi.fn(async () => ({ content: 'kind: assembly\nfeatures: []', name: 'My Assembly' })),
      list: vi.fn(async () => []),
      save: h.save,
      thumbnailUrl: () => null,
    },
    cloudDocuments: null,
  },
}))

// The viewport needs WebGL; the mock answers only the imperative handle the
// capture rides on, which is the whole surface this suite drives.
vi.mock('@/components/Viewport/AssemblyViewport', () => ({
  default: forwardRef((_props, ref) => {
    useImperativeHandle(ref, () => ({ captureScreenshotForSaving: h.capture }))
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

function renderEditor(workspaceId?: string) {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws-2/entries/asm-1']}>
      <ToastProvider><AssemblyEditor uuid="asm-1" workspaceId={workspaceId} /></ToastProvider>
    </MemoryRouter>,
  )
}

describe('AssemblyEditor - the first solve writes a preview', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    vi.clearAllMocks()
    h.capture.mockResolvedValue('data:image/png;base64,QVNN')
    h.save.mockResolvedValue(undefined)
    h.solveAssemblyViaWorker.mockResolvedValue({ payload: { transforms: {}, bodies: {} } })
    useUnsavedChangesStore.getState().setDirty(false)
    useAssemblyStore.getState().setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
  })

  it('stores the capture under (workspace, entry) without saving the document', async () => {
    renderEditor('ws-2')

    await waitFor(async () => {
      expect(await getPreviewStore().get('ws-2', 'asm-1')).toBe('QVNN')
    })
    expect(h.save).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  }, 10000)

  it('falls back to the entry id as the workspace when the editor has none', async () => {
    renderEditor(undefined)

    await waitFor(async () => {
      expect(await getPreviewStore().get('asm-1', 'asm-1')).toBe('QVNN')
    })
  }, 10000)

  it('a failed capture is a miss, not an error', async () => {
    h.capture.mockRejectedValue(new Error('context lost'))
    const { container } = renderEditor('ws-2')

    await waitFor(() => expect(h.capture).toHaveBeenCalled())
    expect(await getPreviewStore().get('ws-2', 'asm-1')).toBeUndefined()
    expect(container.querySelector('.error-banner')).toBeNull()
  }, 10000)
})
