import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import { freshLocalDb, renderWorkspaces, seedStore } from './workspacesHarness'
import { formatBytes } from '@/utils/formatBytes'

// U1 completion: the tile reports the workspace's payload bytes from the
// payload-free listing, without opening the workspace.
describe('Workspaces size tile', () => {
  beforeEach(() => {
    freshLocalDb()
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders the summed payload size and never opens the workspace to list', async () => {
    const store = seedStore()
    const { workspace } = await store.create('Sized', { docKind: 'part' })
    const text = 'kind: part\n# hello\n'
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Sized', docKind: 'part', text })
    const size = new TextEncoder().encode(text).byteLength

    const openSpy = vi.spyOn(store, 'open')
    renderWorkspaces()

    await waitFor(() => expect(screen.getByText('Sized')).toBeInTheDocument())
    expect(screen.getByText(formatBytes(size))).toBeInTheDocument()
    expect(openSpy).not.toHaveBeenCalled()
  })
})
