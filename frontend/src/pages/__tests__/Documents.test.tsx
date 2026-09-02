import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent } from '@testing-library/react'
import { act } from 'react'
import { freshLocalDb, renderDocuments, seedStore } from './documentsHarness'

// The sidebar and the search box, against the real IndexedDB store. Search is
// the interesting half: it is debounced and it runs in the store, not over the
// rendered list, so a test that filtered in JS would pass while the page showed
// stale tiles.
describe('Documents sidebar', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers exactly two views, Documents and Trash, under a Library header', async () => {
    renderDocuments()

    await waitFor(() => expect(screen.getByText('Documents', { selector: '.sidebar-item-label' })).toBeInTheDocument())
    expect(screen.getByText('Trash')).toBeInTheDocument()
    expect(document.querySelectorAll('.sidebar-item')).toHaveLength(2)
    // The single group is labelled Library; the Storage group only shows where
    // a folder or file can be opened, so here there is just the one header.
    expect(screen.getByText('Library', { selector: '.sidebar-section' })).toBeInTheDocument()
    expect(document.querySelectorAll('.sidebar-section')).toHaveLength(1)
  })

  it('Documents is the active view on load', async () => {
    renderDocuments()

    await waitFor(() => expect(screen.getByText('Documents', { selector: '.sidebar-item-label' })).toBeInTheDocument())
    const item = screen.getByText('Documents', { selector: '.sidebar-item-label' }).closest('.sidebar-item')
    expect(item).toHaveClass('active')
  })

  it('clicking Trash opens the trash view', async () => {
    renderDocuments()

    await waitFor(() => expect(screen.getByText('Trash')).toBeInTheDocument())
    const trash = screen.getByText('Trash').closest('.sidebar-item')!
    fireEvent.click(trash)

    expect(trash).toHaveClass('active')
    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())
  })

  // Sign-in, sharing and the owned/shared/public split all belonged to a server
  // that no longer exists. Their absence is structural: there is nothing to hide
  // and nothing to mark unavailable.
  it('offers no cloud, sign-in or sharing affordance anywhere', async () => {
    renderDocuments()

    await waitFor(() => expect(screen.getByText('Trash')).toBeInTheDocument())
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Shared with me')).not.toBeInTheDocument()
    expect(screen.queryByText('Public Documents')).not.toBeInTheDocument()
    expect(screen.queryByTitle('Share document')).not.toBeInTheDocument()
  })
})

describe('Documents search', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function seedTwoDocs() {
    const store = seedStore()
    await store.create('AlphaDoc')
    await store.create('BetaDoc')
  }

  const type = async (value: string) => {
    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value } })
    await act(async () => { vi.advanceTimersByTime(300) })
  }

  it('narrows the grid to matching documents after the debounce', async () => {
    await seedTwoDocs()
    renderDocuments()
    await waitFor(() => expect(screen.getByText('AlphaDoc')).toBeInTheDocument())
    expect(screen.getByText('BetaDoc')).toBeInTheDocument()

    await type('alpha')

    await waitFor(() => expect(screen.queryByText('BetaDoc')).not.toBeInTheDocument())
    expect(screen.getByText('AlphaDoc')).toBeInTheDocument()
  })

  it('reports a search that matches nothing, naming the query', async () => {
    await seedTwoDocs()
    renderDocuments()
    await waitFor(() => expect(screen.getByText('AlphaDoc')).toBeInTheDocument())

    await type('gamma')

    await waitFor(() => expect(screen.getByText('No documents match "gamma"')).toBeInTheDocument())
  })

  it('clear button empties the box and restores the full list', async () => {
    await seedTwoDocs()
    renderDocuments()
    await waitFor(() => expect(screen.getByText('AlphaDoc')).toBeInTheDocument())

    await type('alpha')
    await waitFor(() => expect(screen.queryByText('BetaDoc')).not.toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Clear search'))
    const input = screen.getByPlaceholderText('Search documents...') as HTMLInputElement
    expect(input.value).toBe('')
    await act(async () => { vi.advanceTimersByTime(300) })

    await waitFor(() => expect(screen.getByText('BetaDoc')).toBeInTheDocument())
  })
})
