import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'

// The real editors mount workers, three.js and a canvas. Routing is all that is
// under test here, so stub both sides and assert which one was chosen.
vi.mock('@/pages/AssemblyEditor', () => ({ default: () => <div>ASSEMBLY EDITOR</div> }))
vi.mock('@/pages/Part', () => ({ default: () => <div>PART EDITOR</div> }))

const load = vi.fn()
vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    get documents() { return { load } },
    cloudDocuments: null,
  },
}))

import DocumentPage from '@/pages/DocumentPage'

beforeEach(() => {
  load.mockReset()
})

function wrap() {
  return render(
    <MemoryRouter initialEntries={['/documents/abc']}>
      <Routes>
        <Route path="/documents/:uuid" element={<DocumentPage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('DocumentPage kind routing', () => {
  // The contract the "Add assembly" button relies on: seeded `kind: assembly`
  // content reaches the assembly editor.
  it('routes kind: assembly to the assembly editor', async () => {
    load.mockResolvedValue({ content: 'kind: assembly\nfeatures: []\n' })
    wrap()
    await waitFor(() => expect(screen.getByText('ASSEMBLY EDITOR')).toBeInTheDocument())
  })

  // The contract the "Add part" button relies on: `create` writes empty content,
  // which must not land in the assembly editor.
  it('routes empty content to the part editor', async () => {
    load.mockResolvedValue({ content: '' })
    wrap()
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
  })

  it('routes an explicit kind: part to the part editor', async () => {
    load.mockResolvedValue({ content: 'kind: part\nfeatures: []\n' })
    wrap()
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
  })

  // Fail-safe: an unrecognised kind is a part, not a crash and not an assembly.
  it('routes an unknown kind to the part editor', async () => {
    load.mockResolvedValue({ content: 'kind: sketch\n' })
    wrap()
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
  })

  it('surfaces a load failure instead of routing anywhere', async () => {
    load.mockRejectedValue(new Error('boom'))
    wrap()
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
    expect(screen.queryByText('ASSEMBLY EDITOR')).not.toBeInTheDocument()
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
  })
})
