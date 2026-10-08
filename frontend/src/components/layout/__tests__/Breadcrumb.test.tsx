import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
    useUnsavedChangesStore.getState().dismissConfirm()
  })

  // J2: one segment per route level, and the ancestor is the way back up. The
  // library gets no crumb of its own -- a constant word on every route says
  // nothing about where you are, and the burger already goes there.
  it('renders no trail at all on the library route', () => {
    const { container } = renderAt('/workspaces', <Breadcrumb />)
    expect(container.querySelector('.breadcrumb')).toBeNull()
    expect(screen.queryByText('Workspaces')).toBeNull()
  })

  it('renders the workspace crumb as plain text on the workspace route', async () => {
    renderAt('/workspaces/ws', <Breadcrumb />)
    await waitFor(() => expect(screen.getByText('test')).toBeTruthy())
    // The workspace is where you already are, so nothing in the trail links.
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('links the workspace from an open document', async () => {
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={async () => true} />)
    await waitFor(() => expect(screen.getByText('test')).toBeTruthy())
    const hrefs = screen.getAllByRole('link').map(link => link.getAttribute('href'))
    expect(hrefs).toEqual(['/workspaces/ws'])
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
    fireEvent.click(screen.getByRole('button', { name: 'bracket' }))
    const input = screen.getByLabelText('Document name') as HTMLInputElement
    fireEvent.change(input, { target: { value: '  plate  ' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('plate'))
  })

  it('abandons the edit on Escape without renaming', async () => {
    const onRename = vi.fn(async () => true)
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={onRename} />)
    fireEvent.click(screen.getByRole('button', { name: 'bracket' }))
    const input = screen.getByLabelText('Document name')
    fireEvent.change(input, { target: { value: 'plate' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    await waitFor(() => expect(screen.getByText('bracket')).toBeTruthy())
    expect(onRename).not.toHaveBeenCalled()
  })

  it('restores the stored name when a rename is refused', async () => {
    const onRename = vi.fn(async () => false)
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={onRename} />)
    fireEvent.click(screen.getByRole('button', { name: 'bracket' }))
    const input = screen.getByLabelText('Document name') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'plate' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(onRename).toHaveBeenCalled())
    await waitFor(() => expect((screen.getByLabelText('Document name') as HTMLInputElement).value).toBe('bracket'))
  })

  // A document with no name yet still occupies the last crumb.
  // WCAG 2.5.3: the crumb's accessible name must BE the document name, or voice
  // control cannot reach it and the trail stops saying what is open.
  it('names the rename control after the document, not after the action', async () => {
    renderAt('/workspaces/ws/entries/e1', <Breadcrumb docName="bracket" onRename={async () => true} />)
    expect(screen.getByRole('button', { name: 'bracket' })).toBeTruthy()
  })

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

  // The guarded crumb defers its navigation to the unsaved-changes dialog. The
  // rendered href already carries the router basename, so navigating to it
  // prefixed the base twice and confirming landed on a blank, unmatched route.
  it('confirming the guard lands on the workspace under a non-root basename', async () => {
    useUnsavedChangesStore.getState().setDirty(true)
    render(
      <MemoryRouter basename="/oversolved" initialEntries={['/oversolved/workspaces/ws/entries/e1']}>
        <Routes>
          <Route path="/workspaces/:workspaceId" element={<p>workspace page</p>} />
          <Route path="/workspaces/:workspaceId/entries/:entryId" element={<Breadcrumb docName="Part" />} />
        </Routes>
      </MemoryRouter>,
    )
    fireEvent.click(await screen.findByRole('link'))
    act(() => {
      useUnsavedChangesStore.getState().pendingCallback!()
      useUnsavedChangesStore.getState().dismissConfirm()
    })
    expect(screen.getByText('workspace page')).toBeTruthy()
  })
})
