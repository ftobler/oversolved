import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

const storeMock = vi.hoisted(() => ({
  list: vi.fn(async () => [{
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'p1',
  }]),
  addEntry: vi.fn(async (_w: string, _e: WorkspaceEntry) => 'new-id'),
  renameEntry: vi.fn(async () => {}),
  cloneEntry: vi.fn(async () => 'clone-id'),
  removeEntry: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  duplicate: vi.fn(async () => ({ workspace: 'ws2' })),
  trash: vi.fn(async () => {}),
  export: vi.fn(async () => []),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

const previewMock = vi.hoisted(() => ({ images: new Map<string, string>() }))
vi.mock('@/stores/previewStore', () => ({
  usePreview: (workspace: string, entry: string) => previewMock.images.get(`${workspace}:${entry}`),
}))

import WorkspaceView from '@/pages/WorkspaceView'
import { EntryReferencedError } from '@/workspace/errors'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part' }),
  meta('a1', 'Gearbox', { docKind: 'assembly' }),
  meta('f1', 'shaft.step', { kind: 'file', fileKind: 'step', size: 1024 }),
]

function installSession(all: EntryMeta[] = entries, edges: Record<string, string[]> = {}) {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => all),
    savedRevs: vi.fn(async () => new Map<string, number>(all.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    originOf: vi.fn(async () => undefined),
    provenance: vi.fn(async () => []),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => edges),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
  return session
}

const navigateSpy = vi.fn()
function renderView() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<div>EDITOR</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  previewMock.images.clear()
  navigateSpy.mockClear()
  Object.values(storeMock).forEach(fn => fn.mockClear())
  storeMock.list.mockResolvedValue([{
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'p1',
  }])
})

describe('WorkspaceView', () => {
  // J1: this level is an identity card beside a LIST, never a grid.
  it('renders the workspace identity beside a list of entry rows', async () => {
    installSession()
    const { container } = renderView()
    await screen.findByText('Bracket')
    expect(container.querySelector('.workspace-identity-card')).toBeTruthy()
    expect(container.querySelectorAll('.workspace-entry-row')).toHaveLength(3)
    // The grid is the level above; this one must not borrow it.
    expect(container.querySelector('.doc-tiles')).toBeNull()
  })

  it('shows the workspace name, entry count and size on the card', async () => {
    installSession()
    renderView()
    await screen.findByText('test')
    expect(screen.getByText('3 entries')).toBeTruthy()
    expect(screen.getByText('2.0 KB')).toBeTruthy()
  })

  it('groups the rows by kind and labels each group', async () => {
    installSession()
    const { container } = renderView()
    await screen.findByText('Bracket')
    const labels = [...container.querySelectorAll('.workspace-entry-group-label')].map(el => el.textContent)
    expect(labels).toEqual(['Parts', 'Assemblies', 'Files'])
  })

  // J5: the row's whole reason to exist is that it has a thumb slot.
  it('paints an entry thumbnail where one exists and a placeholder where none does', async () => {
    previewMock.images.set('ws:p1', 'QUJD')
    installSession()
    const { container } = renderView()
    await screen.findByText('Bracket')
    const rows = [...container.querySelectorAll('.workspace-entry-row')]
    expect(rows[0].querySelector('img')?.getAttribute('src')).toContain('QUJD')
    // Gearbox has no preview, so its row falls back rather than breaking.
    expect(rows[1].querySelector('.doc-tile-placeholder')).toBeTruthy()
  })

  it('opens a document row on click', async () => {
    installSession()
    renderView()
    const open = (await screen.findByText('Bracket')).closest('button') as HTMLElement
    fireEvent.click(open)
    await screen.findByText('EDITOR')
  })

  // The row holds three controls as well, so the openable surface is a real
  // button inside it rather than a role on the row: a role on the row would
  // swallow the list item and announce the controls as part of its own name.
  it('keeps the row a list item with the controls outside its open button', async () => {
    installSession()
    const { container } = renderView()
    await screen.findByText('Bracket')
    const row = screen.getByText('Bracket').closest('.workspace-entry-row') as HTMLElement
    expect(row.tagName).toBe('LI')
    expect(row.getAttribute('role')).toBeNull()
    expect(row.querySelector('button.workspace-entry-open')?.querySelector('.btn')).toBeNull()
    expect(container.querySelectorAll('li.workspace-entry-row')).toHaveLength(3)
  })

  // J9: a file is not a document. The tree this replaces routed file clicks to
  // the entry route, which refused them and stranded the user on an error page.
  it('does not open a file row', async () => {
    installSession()
    const { container } = renderView()
    const row = (await screen.findByText('shaft.step')).closest('.workspace-entry-row') as HTMLElement
    // No open button at all, so there is nothing to click or tab to.
    expect(row.querySelector('button.workspace-entry-open')).toBeNull()
    fireEvent.click(row.querySelector('.workspace-entry-open') as HTMLElement)
    expect(screen.queryByText('EDITOR')).toBeNull()
    // It is still listed, with its kind and size: the archive is what you ship.
    expect(container.textContent).toContain('step')
    expect(container.textContent).toContain('1.0 KB')
  })

  it('holds an open back while the current document is dirty', async () => {
    useUnsavedChangesStore.getState().setDirty(true)
    installSession()
    renderView()
    const open = (await screen.findByText('Bracket')).closest('button') as HTMLElement
    fireEvent.click(open)
    expect(screen.queryByText('EDITOR')).toBeNull()
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
  })

  it('renames an entry through the store', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Rename Bracket'))
    fireEvent.change(screen.getByLabelText('Entry name'), { target: { value: 'Plate' } })
    fireEvent.click(screen.getByText('Rename'))
    await waitFor(() => expect(storeMock.renameEntry).toHaveBeenCalledWith('ws', 'p1', 'Plate'))
  })

  it('duplicates an entry through the store', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Duplicate Bracket'))
    await waitFor(() => expect(storeMock.cloneEntry).toHaveBeenCalledWith('ws', 'p1'))
  })

  // The tree this replaces had six uncaught handlers and no error surface, so a
  // refused verb was an invisible no-op.
  it('surfaces a failed verb instead of swallowing it', async () => {
    installSession()
    storeMock.cloneEntry.mockRejectedValueOnce(new Error('disk full'))
    renderView()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Duplicate Bracket'))
    await screen.findByText(/disk full/)
  })

  it('names the referrers when a delete is refused', async () => {
    installSession()
    storeMock.removeEntry.mockRejectedValueOnce(
      new EntryReferencedError('p1', [{ id: 'a1', name: 'Gearbox' }]),
    )
    const { container } = renderView()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Delete Bracket'))
    await screen.findByText('Cannot Delete')
    // Scoped to the guard's own list: Gearbox is also an entry row behind it.
    const named = [...container.querySelectorAll('.where-used-open')].map(el => el.textContent)
    expect(named).toEqual(['Gearbox'])
  })

  it('marks a row changed since its last save', async () => {
    const session = installSession()
    session.savedRevs.mockResolvedValueOnce(new Map([['p1', 0], ['a1', 1], ['f1', 1]]))
    const { container } = renderView()
    await screen.findByText('Bracket')
    await waitFor(() => expect(container.querySelectorAll('.workspace-entry-dot')).toHaveLength(1))
  })

  it('shows an empty workspace as empty rather than blank', async () => {
    installSession([])
    renderView()
    await screen.findByText('This workspace is empty.')
  })

  // "Empty" is a claim about the workspace, so it must wait for an answer.
  // Asserting only the eventual message passes even if the load is deleted.
  it('does not claim the workspace is empty while it is still loading', async () => {
    const session = installSession()
    session.listEntries.mockReturnValueOnce(new Promise(() => {}))
    renderView()
    expect(screen.queryByText('This workspace is empty.')).toBeNull()
    // Nor a nameless zero-byte identity card standing in for the real one.
    expect(screen.queryByText('0 entries')).toBeNull()
  })

  // The wait is a claim too: while the load has not answered, the column says
  // so rather than reading as a finished empty workspace.
  it('shows a loading state while the workspace load is pending', async () => {
    const session = installSession()
    session.listEntries.mockReturnValueOnce(new Promise(() => {}))
    renderView()
    expect(screen.getByText('Loading workspace...')).toBeInTheDocument()
    expect(screen.queryByText('This workspace is empty.')).toBeNull()
  })

  // A failed load is not a wait: the error shows and the spinner must go, or the
  // two would sit together and the wait would read as endless.
  it('drops the loading state when the workspace load fails', async () => {
    const session = installSession()
    session.listEntries.mockRejectedValueOnce(new Error('index corrupt'))
    renderView()
    await screen.findByText(/index corrupt/)
    expect(screen.queryByText('Loading workspace...')).toBeNull()
  })

  // A delete is a slow round-trip, so a second click must not start a second
  // one: the row's own button goes disabled and shows the hourglass.
  it('disables a row delete while it is in flight and re-enables it after', async () => {
    installSession()
    let resolveDelete: () => void = () => {}
    storeMock.removeEntry.mockReturnValueOnce(new Promise<void>(resolve => { resolveDelete = resolve }))
    renderView()
    await screen.findByText('Bracket')

    const remove = screen.getByLabelText('Delete Bracket') as HTMLButtonElement
    fireEvent.click(remove)
    expect(remove).toBeDisabled()
    expect(remove.querySelector('.material-icons')?.textContent).toBe('hourglass_empty')

    fireEvent.click(remove)
    expect(storeMock.removeEntry).toHaveBeenCalledTimes(1)

    resolveDelete()
    await waitFor(() => expect(remove).toBeEnabled())
    expect(remove.querySelector('.material-icons')?.textContent).toBe('delete')
  })

  // The page above installs the session in an effect that runs AFTER this
  // component's, and a duplicate navigates workspaces without unmounting. Both
  // land a session and a route that disagree.
  it('renders nothing until the session answers for the route it is on', async () => {
    const session = {
      workspace: 'other',
      listEntries: vi.fn(async () => entries),
      savedRevs: vi.fn(async () => new Map<string, number>()),
      readEntry: vi.fn(), writeEntry: vi.fn(),
      originOf: vi.fn(async () => undefined), provenance: vi.fn(async () => []),
      resolveFile: vi.fn(), referencesOf: vi.fn(async () => []),
      referenceEdges: vi.fn(async () => ({})),
    }
    useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
    const { container } = renderView()
    await waitFor(() => expect(storeMock.list).not.toHaveBeenCalled())
    expect(session.listEntries).not.toHaveBeenCalled()
    expect(container.querySelectorAll('.workspace-entry-row')).toHaveLength(0)
    expect(screen.queryByText('This workspace is empty.')).toBeNull()
  })

  // The banner renders in the main column, which an open modal covers.
  it('reports a failed dialog verb inside the dialog, not behind it', async () => {
    installSession()
    storeMock.renameEntry.mockRejectedValueOnce(new Error('name taken'))
    renderView()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Rename Bracket'))
    fireEvent.change(screen.getByLabelText('Entry name'), { target: { value: 'Plate' } })
    fireEvent.click(screen.getByText('Rename'))
    await screen.findByText(/name taken/)
    // The dialog is still open, so the typed name is not lost.
    expect(screen.getByLabelText('Entry name')).toBeTruthy()
  })
})
