import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { freshLocalDb, renderWorkspaces, seedStore } from './workspacesHarness'

// Rename and export are the two tile verbs the other U1 suites do not drive.
// Both run against the real workspace store; the export's only fake is the
// browser download, which jsdom cannot perform.
const downloads = vi.hoisted(() => ({ calls: [] as { blob: Blob; filename: string }[] }))
vi.mock('@/utils/core/downloadBlob', () => ({
  downloadBlob: (blob: Blob, filename: string) => { downloads.calls.push({ blob, filename }) },
}))

function dialog(): HTMLElement {
  return document.querySelector('.dialog-component') as HTMLElement
}

async function waitForTile(name: string): Promise<void> {
  await waitFor(() => expect(screen.getByTitle(name)).toBeInTheDocument())
}

describe('Workspaces rename', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
    downloads.calls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renames the workspace and persists the new name', async () => {
    const store = seedStore()
    await store.create('Alpha', { docKind: 'part' })
    renderWorkspaces()
    await waitForTile('Alpha')

    fireEvent.click(screen.getByTitle('Rename'))
    const input = within(dialog()).getByRole('textbox')
    expect(input).toHaveValue('Alpha')

    fireEvent.change(input, { target: { value: 'Beta' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Rename' }))

    await waitForTile('Beta')
    expect(screen.queryByTitle('Alpha')).not.toBeInTheDocument()
    expect((await store.list()).map(summary => summary.name)).toEqual(['Beta'])
  })

  it('refuses a blank rename and leaves the dialog open', async () => {
    const store = seedStore()
    await store.create('Alpha', { docKind: 'part' })
    renderWorkspaces()
    await waitForTile('Alpha')

    fireEvent.click(screen.getByTitle('Rename'))
    const input = within(dialog()).getByRole('textbox')
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Rename' }))

    expect(dialog()).toBeInTheDocument()
    expect((await store.list()).map(summary => summary.name)).toEqual(['Alpha'])
  })

  it('reports a failed rename instead of dropping the dialog silently', async () => {
    const store = seedStore()
    await store.create('Alpha', { docKind: 'part' })
    renderWorkspaces()
    await waitForTile('Alpha')

    vi.spyOn(store, 'rename').mockRejectedValue(new Error('db is down'))
    fireEvent.click(screen.getByTitle('Rename'))
    fireEvent.change(within(dialog()).getByRole('textbox'), { target: { value: 'Beta' } })
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(screen.getByText('Error: db is down')).toBeInTheDocument())
  })
})

describe('Workspaces export', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    freshLocalDb()
    localStorage.clear()
    downloads.calls = []
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('downloads the workspace as a named zip', async () => {
    const store = seedStore()
    await store.create('Alpha', { docKind: 'part' })
    renderWorkspaces()
    await waitForTile('Alpha')

    fireEvent.click(screen.getByTitle('Export workspace'))

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    expect(downloads.calls[0].filename).toBe('Alpha.zip')
    expect(downloads.calls[0].blob.type).toBe('application/zip')
    expect(downloads.calls[0].blob.size).toBeGreaterThan(0)
  })

  it('reports a failed export instead of leaving the tile spinning', async () => {
    const store = seedStore()
    await store.create('Alpha', { docKind: 'part' })
    renderWorkspaces()
    await waitForTile('Alpha')

    vi.spyOn(store, 'export').mockRejectedValue(new Error('archive gone'))
    fireEvent.click(screen.getByTitle('Export workspace'))

    await waitFor(() => expect(screen.getByText('Error: archive gone')).toBeInTheDocument())
    expect(downloads.calls).toHaveLength(0)
  })
})
