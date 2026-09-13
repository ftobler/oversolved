import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { ReactNode } from 'react'

const carrierMock = vi.hoisted(() => ({
  readWorkspaceMeta: vi.fn(async (workspace: string) => ({ workspace, name: 'test' })),
}))
vi.mock('@/workspace/idbCarrier', () => carrierMock)

import Breadcrumb from '@/components/layout/Breadcrumb'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function renderAt(path: string, element: ReactNode) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/workspaces" element={element} />
        <Route path="/workspaces/:workspaceId" element={element} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={element} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('Breadcrumb', () => {
  beforeEach(() => {
    carrierMock.readWorkspaceMeta.mockClear()
    useUnsavedChangesStore.getState().setDirty(false)
  })

  // J2: one segment per route level, and the ancestors are the way back up.
  it('renders one crumb on the library route, with no link out', () => {
    renderAt('/workspaces', <Breadcrumb />)
    expect(screen.getByText('Workspaces')).toBeTruthy()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('renders the workspace crumb as plain text on the workspace route', async () => {
    renderAt('/workspaces/ws', <Breadcrumb />)
    await waitFor(() => expect(screen.getByText('test')).toBeTruthy())
    // Workspaces links out; the workspace itself is where you already are.
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe('/workspaces')
  })

  it('links both ancestors from an open document', async () => {
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={async () => true} />)
    await waitFor(() => expect(screen.getByText('test')).toBeTruthy())
    const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href'))
    expect(hrefs).toEqual(['/workspaces', '/workspaces/ws'])
    expect(screen.getByText('bracket')).toBeTruthy()
  })

  // The trail is the only way out of an editor, so it must not walk away from
  // unsaved edits without asking.
  it('holds an ancestor navigation back while the document is dirty', async () => {
    useUnsavedChangesStore.getState().setDirty(true)
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={async () => true} />)
    await waitFor(() => expect(screen.getByText('test')).toBeTruthy())
    fireEvent.click(screen.getAllByRole('link')[0])
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
  })

  // J3: the last crumb carries the editors' inline rename.
  it('commits a rename from the last crumb on Enter', async () => {
    const onRename = vi.fn(async () => true)
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={onRename} />)
    fireEvent.click(screen.getByLabelText('Edit document name'))
    const input = screen.getByLabelText('Document name') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  plate  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('plate'))
  })

  it('abandons the edit on Escape without renaming', async () => {
    const onRename = vi.fn(async () => true)
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={onRename} />)
    fireEvent.click(screen.getByLabelText('Edit document name'))
    const input = screen.getByLabelText('Document name')
    fireEvent.change(input, { target: { value: 'plate' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.getByText('bracket')).toBeTruthy())
    expect(onRename).not.toHaveBeenCalled()
  })

  it('restores the stored name when a rename is refused', async () => {
    const onRename = vi.fn(async () => false)
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={onRename} />)
    fireEvent.click(screen.getByLabelText('Edit document name'))
    const input = screen.getByLabelText('Document name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'plate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onRename).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByLabelText('Document name') as HTMLInputElement).value).toBe('bracket'))
  })

  // A document with no name yet still occupies the last crumb.
  it('shows the fallback name for an unnamed document', async () => {
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName={null} fallbackName="Untitled Assembly" onRename={async () => true} />)
    expect(screen.getByText('Untitled Assembly')).toBeTruthy()
  })

  // A workspace whose meta cannot be read still gets a trail.
  it('falls back to the workspace id when the meta read fails', async () => {
    carrierMock.readWorkspaceMeta.mockRejectedValueOnce(new Error('gone'))
    renderAt('/workspaces/ws', <Breadcrumb />)
    await waitFor(() => expect(screen.getByText('ws')).toBeTruthy())
  })
})
