import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Static build: no backend, no auth endpoint, IndexedDB-backed store.
vi.mock('@/config/capabilities', () => ({ hasBackend: false, backend: 'static' }))

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { render, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
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
      <AuthProvider>
        <Documents />
      </AuthProvider>
    </BrowserRouter>
  )
}

describe('Documents preview tile (static build)', () => {
  it('renders a data: URL img when preview_image is present in the summary', async () => {
    const { IndexedDbDocumentStore } = await import('@/stores/documentStore/IndexedDbDocumentStore')
    const store = new IndexedDbDocumentStore()
    const { uuid } = await store.create('Widget')
    await store.save(uuid, { content: '', preview_image: 'abc123' })

    wrap()
    await waitFor(() => {
      const img = document.querySelector<HTMLImageElement>('.doc-tile-preview img')
      expect(img?.src).toContain('data:image/png;base64,abc123')
    })
  })
})
