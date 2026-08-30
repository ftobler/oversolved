import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { freshLocalDb, renderDocuments, seedStore } from './documentsHarness'

// The Trash view, end to end against the real store: deleting a document from
// the grid must be recoverable, because IndexedDB is the only copy there is --
// a hard delete on a mis-click would be unrecoverable, not merely annoying.
describe('Documents trash', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const openTrash = async () => {
    await waitFor(() => expect(screen.getByTitle('Trash')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Trash'))
  }

  it('shows an empty trash on a fresh library', async () => {
    renderDocuments()
    await openTrash()
    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())
  })

  it('a deleted document leaves the grid and appears in the trash', async () => {
    const store = seedStore()
    await store.create('Deleted Doc')

    renderDocuments()
    await waitFor(() => expect(screen.getByText('Deleted Doc')).toBeInTheDocument())
    fireEvent.click(screen.getByTitle('Delete document'))
    await waitFor(() => expect(screen.queryByText('Deleted Doc')).not.toBeInTheDocument())

    await openTrash()
    await waitFor(() => expect(screen.getByText('Deleted Doc')).toBeInTheDocument())
  })

  it('recover puts the document back in the library', async () => {
    const store = seedStore()
    const { uuid } = await store.create('Deleted Doc')
    await store.remove(uuid)

    renderDocuments()
    await openTrash()
    await waitFor(() => expect(screen.getByText('Deleted Doc')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Recover document'))
    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Documents'))
    await waitFor(() => expect(screen.getByText('Deleted Doc')).toBeInTheDocument())
  })

  it('permanent delete asks first, then drops the document for good', async () => {
    const store = seedStore()
    const { uuid } = await store.create('Deleted Doc')
    await store.remove(uuid)

    renderDocuments()
    await openTrash()
    await waitFor(() => expect(screen.getByText('Deleted Doc')).toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Permanently delete'))
    // The confirmation is the last guard before an irreversible delete.
    await waitFor(() => expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())
    expect(await store.list()).toEqual([])
  })
})
