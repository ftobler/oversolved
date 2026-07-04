import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Static build: no backend, no auth endpoint, IndexedDB-backed store.
vi.mock('@/config/capabilities', () => ({ hasBackend: false, backend: 'static' }))

import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { resetDbConnection } from '@/stores/documentStore/idb'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '@/contexts/AuthContext'
import Documents from '@/pages/Documents'

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory()
  resetDbConnection()
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

describe('Documents STEP import (static build)', () => {
  it('uploads a .step file into a new document tile', async () => {
    wrap()
    await waitFor(() => expect(screen.getByText('Local Documents')).toBeInTheDocument())

    const input = document.querySelector<HTMLInputElement>('.doc-controls input.file-upload-input')!
    expect(input.accept).toContain('.step')

    const bytes = 'ISO-10303-21;\nHEADER;\nENDSEC;\nEND-STEP;\n'
    const file = new File([bytes], 'bracket.step', { type: 'application/step' })

    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } })
    })

    await waitFor(() => expect(screen.getByTitle('local/bracket')).toBeInTheDocument())
  })
})