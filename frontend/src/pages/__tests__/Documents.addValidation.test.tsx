import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Static build: no backend, IndexedDB-backed local store.
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

// Open the add dialog. The two add buttons pick the kind, but the empty-name
// validation lives in the shared handler and is identical for both, so either
// button exercises it.
async function openAddDialog() {
  wrap()
  await waitFor(() => expect(screen.getByText('Local Documents')).toBeInTheDocument())
  await act(async () => {
    fireEvent.click(screen.getByTitle('Add part'))
  })
  // The dialog renders the name field, so it is open.
  await waitFor(() => expect(screen.getByPlaceholderText('Document name')).toBeInTheDocument())
}

describe('Documents: add-form empty-name validation clears on valid input', () => {
  it('shows "Document name cannot be empty" when submitting an empty name', async () => {
    await openAddDialog()

    // Submit with the name still blank.
    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })

    expect(screen.getByText('Document name cannot be empty')).toBeInTheDocument()
  })

  it('clears the error once a non-empty name is typed', async () => {
    await openAddDialog()

    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })
    expect(screen.getByText('Document name cannot be empty')).toBeInTheDocument()

    // Typing a real name must clear the lingering validation message.
    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Document name'), { target: { value: 'bracket' } })
    })

    expect(screen.queryByText('Document name cannot be empty')).not.toBeInTheDocument()
  })

  it('creates the document and closes the form after the error cleared', async () => {
    await openAddDialog()

    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })
    expect(screen.getByText('Document name cannot be empty')).toBeInTheDocument()

    await act(async () => {
      fireEvent.change(screen.getByPlaceholderText('Document name'), { target: { value: 'bracket' } })
    })
    await act(async () => {
      fireEvent.click(screen.getByText('Create'))
    })

    // Document was created and the dialog closed (no longer asking for a name).
    await waitFor(() => expect(screen.getByTitle('local/bracket')).toBeInTheDocument())
    expect(screen.queryByText('Create New Part')).not.toBeInTheDocument()
    expect(screen.queryByText('Document name cannot be empty')).not.toBeInTheDocument()
  })
})
