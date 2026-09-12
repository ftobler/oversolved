import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { getPreviewStore } from '@/stores/previewStore'
import { freshLocalDb, seedStore } from './workspacesHarness'
import Workspaces from '@/pages/Workspaces'

// The tile thumbnail comes from the preview store keyed by
// (workspace, cover entry), not from a document record (A9). A fresh workspace
// paints a placeholder; a save writes the preview and the cover entry's tile
// paints it.
describe('Workspaces preview tile', () => {
  beforeEach(() => {
    freshLocalDb()
  })

  afterEach(() => {
    // no timers are faked here
  })

  it('renders a data: URL img from the preview store', async () => {
    const store = seedStore()
    const { workspace } = await store.create('Widget', { docKind: 'part' })
    const summary = (await store.list()).find(s => s.workspace === workspace)!
    await getPreviewStore().put(workspace, summary.coverEntry!, 'abc123')

    render(
      <BrowserRouter>
        <Workspaces />
      </BrowserRouter>,
    )
    await waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('.doc-tile-preview img')
      expect(img?.src).toContain('data:image/png;base64,abc123')
    })
    expect(screen.getByText('Widget')).toBeInTheDocument()
  })
})
