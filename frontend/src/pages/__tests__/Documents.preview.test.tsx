import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { resetPreviewDbConnection, getPreviewStore } from '@/stores/previewStore'
import { IdbWorkspaceStore } from '@/workspace/store'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import Documents from '@/pages/Documents'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
  resetPreviewDbConnection()
  vi.useFakeTimers({ shouldAdvanceTime: true })
})

afterEach(() => {
  vi.useRealTimers()
})

function wrap() {
  return render(
    <BrowserRouter>
      <Documents />
    </BrowserRouter>
  )
}

// The tile thumbnail comes from the preview store keyed by (workspace, entry),
// not from the document record (A9). In C2 both key parts are the document's
// uuid, so a seeded workspace and preview paint the tile.
describe('Documents preview tile', () => {
  it('renders a data: URL img from the preview store', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Widget', { docKind: 'part' })
    await getPreviewStore().put(workspace, workspace, 'abc123')

    wrap()
    await waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('.doc-tile-preview img')
      expect(img?.src).toContain('data:image/png;base64,abc123')
    })
    expect(screen.getByText('Widget')).toBeInTheDocument()
  })
})
