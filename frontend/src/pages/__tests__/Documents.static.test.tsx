import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Static build: no backend, no auth endpoint, IndexedDB-backed store.
vi.mock('@/config/capabilities', () => ({ hasBackend: false, backend: 'static' }))

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { render, screen, waitFor } from '@testing-library/react'
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

describe('Documents sidebar (static build)', () => {
  it('hides the whole Cloud section (no server, no identity)', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Local Documents')).toBeInTheDocument())
    expect(screen.queryByText('Cloud')).not.toBeInTheDocument()
    expect(screen.queryByText('My Documents')).not.toBeInTheDocument()
    expect(screen.queryByText('Shared with me')).not.toBeInTheDocument()
    expect(screen.queryByText('Public Documents')).not.toBeInTheDocument()
  })

  it('shows the Local section with documents and trash', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Local Documents')).toBeInTheDocument())
    expect(screen.getByText('Local Trash')).toBeInTheDocument()
  })
})

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
