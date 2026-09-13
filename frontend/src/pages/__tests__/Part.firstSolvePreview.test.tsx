import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import Part from '@/pages/Part'
import { getPreviewStore } from '@/stores/previewStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
import { Wrapper, partDocStoreMock } from '@/__tests__/test-utils'

// J6. Saving was the only writer of a preview, so a document opened and never
// saved had none and its entry row would paint a placeholder forever. The first
// successful solve now captures one, under the same (workspace, entry) key the
// save path writes, without saving and without dirtying the document.

const h = vi.hoisted(() => ({
  capture: vi.fn(async (): Promise<string | null> => 'data:image/png;base64,UEFSVA=='),
}))

// jsdom has no Worker, so the real client resolves null for any non-empty doc
// and the first solve never completes. Answer with an empty build so the
// first-solve hook point actually fires.
vi.mock('@/kernel/worker/solverClient', () => ({
  solveViaWorker: vi.fn().mockResolvedValue({ solve_ms: 0, result: {}, bodies: {}, _build_state: null }),
  cancelSolver: vi.fn(),
}))

vi.mock('../../components/Viewport', async () =>
  (await import('@/__tests__/test-utils')).viewportMockModule({
    captureScreenshotForSaving: h.capture,
  }))

function renderPart(path: string, route: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path={route} element={<Part />} />
      </Routes>
    </MemoryRouter>,
    { wrapper: Wrapper },
  )
}

describe('Part - the first solve writes a preview', () => {
  beforeEach(() => {
    resetWorkspaceIdb()
    vi.clearAllMocks()
    h.capture.mockResolvedValue('data:image/png;base64,UEFSVA==')
    useUnsavedChangesStore.getState().setDirty(false)
    partDocStoreMock()
  })

  it('stores the capture under (workspace, entry) without saving the document', async () => {
    const store = partDocStoreMock()
    renderPart('/workspaces/ws-1/entries/entry-1', '/workspaces/:workspaceId/entries/:entryId')

    await waitFor(async () => {
      expect(await getPreviewStore().get('ws-1', 'entry-1')).toBe('UEFSVA==')
    })
    // The capture is not a save, and it is not an edit.
    expect(store.save).not.toHaveBeenCalled()
    expect(useUnsavedChangesStore.getState().dirty).toBe(false)
  })

  it('falls back to the entry id as the workspace on the legacy document route', async () => {
    renderPart('/documents/entry-1', '/documents/:uuid')

    await waitFor(async () => {
      expect(await getPreviewStore().get('entry-1', 'entry-1')).toBe('UEFSVA==')
    })
  })

  it('a capture that yields nothing is a miss, not an error', async () => {
    h.capture.mockResolvedValue(null)
    const { container } = renderPart('/workspaces/ws-1/entries/entry-1', '/workspaces/:workspaceId/entries/:entryId')

    await waitFor(() => expect(h.capture).toHaveBeenCalled())
    expect(await getPreviewStore().get('ws-1', 'entry-1')).toBeUndefined()
    expect(container.querySelector('.error-banner')).toBeNull()
  })
})
