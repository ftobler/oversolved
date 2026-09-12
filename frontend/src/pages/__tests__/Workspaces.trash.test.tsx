import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { freshLocalDb, renderWorkspaces, seedStore } from './workspacesHarness'

// The Trash view, end to end against the real store: trashing a workspace must
// be recoverable, because IndexedDB is the only copy there is -- a hard delete
// on a mis-click would be unrecoverable, not merely annoying.
describe('Workspaces trash', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const openTrash = async () => {
    await waitFor(() => expect(screen.getByText('Trash')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Trash'))
  }

  it('shows an empty trash on a fresh library', async () => {
    renderWorkspaces()
    await openTrash()
    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())
  })

  it('a trashed workspace leaves the grid and appears in the trash', async () => {
    const store = seedStore()
    await store.create('Gone', { docKind: 'part' })

    renderWorkspaces()
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Move to trash'))
    await waitFor(() => expect(screen.queryByText('Gone')).not.toBeInTheDocument())

    await openTrash()
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())
  })

  it('recover puts the workspace back in the library', async () => {
    const store = seedStore()
    const { workspace } = await store.create('Gone', { docKind: 'part' })
    await store.trash(workspace)

    renderWorkspaces()
    await openTrash()
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Recover workspace'))
    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())

    fireEvent.click(screen.getByText('Workspaces', { selector: '.sidebar-item-label' }))
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())
  })

  it('permanent delete asks first, then drops the workspace for good', async () => {
    const store = seedStore()
    const { workspace } = await store.create('Gone', { docKind: 'part' })
    await store.trash(workspace)

    renderWorkspaces()
    await openTrash()
    await waitFor(() => expect(screen.getByText('Gone')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Permanently delete'))
    // The confirmation is the last guard before an irreversible delete.
    await waitFor(() => expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())
    expect(await store.list()).toEqual([])
  })
})
