import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { IndexedDbDocumentStore } from '@/stores/documentStore/IndexedDbDocumentStore'
import { render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import Documents from '@/pages/Documents'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
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

// The tile thumbnail comes back inline on the summary as base64, not from a
// separate URL the grid would have to fetch (`thumbnailUrl` returns null). This
// pins that the grid renders the inline form, since a store that served
// thumbnails as resources would need the other branch.
describe('Documents preview tile', () => {
  it('renders a data: URL img from the summary preview_image', async () => {
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Widget')
    await store.save(uuid, { content: '', preview_image: 'abc123' })

    wrap()
    await waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('.doc-tile-preview img')
      expect(img?.src).toContain('data:image/png;base64,abc123')
    })
    expect(screen.getByText('Widget')).toBeInTheDocument()
  })
})
