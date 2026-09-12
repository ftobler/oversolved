import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor, fireEvent, act } from '@testing-library/react'
import { freshLocalDb, renderWorkspaces, seedStore } from './workspacesHarness'

// U1: one tile per workspace, listing only, no preview until a save writes one.
// Search is the interesting half of the header: it is debounced and runs in the
// store, not over the rendered list, so a test that filtered in JS would pass
// while the page showed stale tiles.
describe('Workspaces sidebar and search', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
    vi.useFakeTimers({ shouldAdvanceTime: true })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('offers exactly two views, Workspaces and Trash, under a Library header', async () => {
    renderWorkspaces()

    await waitFor(() => expect(screen.getByText('Workspaces', { selector: '.sidebar-item-label' })).toBeInTheDocument())
    expect(screen.getByText('Trash')).toBeInTheDocument()
    expect(document.querySelectorAll('.sidebar-item')).toHaveLength(2)
    expect(screen.getByText('Library', { selector: '.sidebar-section' })).toBeInTheDocument()
    expect(document.querySelectorAll('.sidebar-section')).toHaveLength(1)
  })

  it('Workspaces is the active view on load', async () => {
    renderWorkspaces()

    await waitFor(() => expect(screen.getByText('Workspaces', { selector: '.sidebar-item-label' })).toBeInTheDocument())
    const item = screen.getByText('Workspaces', { selector: '.sidebar-item-label' }).closest('.sidebar-item')
    expect(item).toHaveClass('active')
  })

  it('clicking Trash opens the trash view', async () => {
    renderWorkspaces()

    await waitFor(() => expect(screen.getByText('Trash')).toBeInTheDocument())
    const trash = screen.getByText('Trash').closest('.sidebar-item')!
    fireEvent.click(trash)

    expect(trash).toHaveClass('active')
    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeInTheDocument())
  })

  it('offers no cloud, sign-in or sharing affordance anywhere', async () => {
    renderWorkspaces()

    await waitFor(() => expect(screen.getByText('Trash')).toBeInTheDocument())
    expect(screen.queryByText(/cloud/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/sign in/i)).not.toBeInTheDocument()
    expect(screen.queryByText('Shared with me')).not.toBeInTheDocument()
    expect(screen.queryByText('Public Documents')).not.toBeInTheDocument()
  })

  async function seedTwo() {
    const store = seedStore()
    await store.create('Alpha', { docKind: 'part' })
    await store.create('Beta', { docKind: 'part' })
  }

  const type = async (value: string) => {
    fireEvent.change(screen.getByPlaceholderText('Search workspaces...'), { target: { value } })
    await act(async () => { vi.advanceTimersByTime(300) })
  }

  it('narrows the grid to matching workspaces after the debounce', async () => {
    await seedTwo()
    renderWorkspaces()
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())
    expect(screen.getByText('Beta')).toBeInTheDocument()

    await type('alpha')

    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument())
    expect(screen.getByText('Alpha')).toBeInTheDocument()
  })

  it('reports a search that matches nothing, naming the query', async () => {
    await seedTwo()
    renderWorkspaces()
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

    await type('gamma')

    await waitFor(() => expect(screen.getByText('No workspaces match "gamma"')).toBeInTheDocument())
  })

  it('clear button empties the box and restores the full list', async () => {
    await seedTwo()
    renderWorkspaces()
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument())

    await type('alpha')
    await waitFor(() => expect(screen.queryByText('Beta')).not.toBeInTheDocument())

    fireEvent.click(screen.getByTitle('Clear search'))
    const input = screen.getByPlaceholderText('Search workspaces...') as HTMLInputElement
    expect(input.value).toBe('')
    await act(async () => { vi.advanceTimersByTime(300) })

    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument())
  })
})
