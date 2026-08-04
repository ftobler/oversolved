import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

// The real editors mount workers, three.js and a canvas. Routing is all that is
// under test here, so stub both sides and assert which one was chosen. The Part
// and AssemblyEditor stubs record mount/unmount so the keyed-remount tests can
// assert the instances actually change when the uuid does.
//
// Lifecycle is recorded in useEffect, a passive effect. RTL's waitFor runs
// outside act (it disables IS_REACT_ACT_ENVIRONMENT for the whole poll), so a
// text waitFor can resolve while the effect flush still lags behind the
// committed DOM. Mount/unmount counts must therefore be asserted INSIDE a
// waitFor, never synchronously right after a text waitFor.
const partLifecycle = vi.hoisted(() => vi.fn())
const assemblyLifecycle = vi.hoisted(() => vi.fn())
vi.mock('@/pages/AssemblyEditor', async () => {
  const { useEffect } = await import('react')
  return {
    default: function AssemblyEditorMock() {
      useEffect(() => {
        assemblyLifecycle('mount')
        return () => assemblyLifecycle('unmount')
      }, [])
      return <div>ASSEMBLY EDITOR</div>
    },
  }
})
vi.mock('@/pages/Part', async () => {
  const { useEffect } = await import('react')
  return {
    default: function PartMock() {
      useEffect(() => {
        partLifecycle('mount')
        return () => partLifecycle('unmount')
      }, [])
      return <div>PART EDITOR</div>
    },
  }
})

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
  partLifecycle.mockClear()
  assemblyLifecycle.mockClear()
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

  // The undo-document-reset contract: a uuid change (clone, browser back/forward)
  // must NOT keep the old Part instance, because the old instance carries the
  // previous document's undo stacks and edit-session refs. DocumentPage keys Part
  // by uuid so the swap is a fresh instance by construction.
  it('remounts the part editor when the uuid changes', async () => {
    load.mockImplementation(async () => ({ content: 'kind: part\nfeatures: []\n' }))

    function GoToB() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/documents/B')}>to B</button>
    }

    render(
      <MemoryRouter initialEntries={['/documents/A']}>
        <Routes>
          <Route path="/documents/:uuid" element={<DocumentPage />} />
        </Routes>
        <GoToB />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    await waitFor(() => {
      expect(partLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    await waitFor(() => {
      expect(partLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(2)
    })
    // The old instance is torn down before the new one mounts. An in-place update
    // (no keying) would leave the mount count at 1.
    const sequence = partLifecycle.mock.calls.map(c => c[0])
    expect(sequence.indexOf('unmount')).toBeGreaterThan(-1)
    expect(sequence.indexOf('unmount')).toBeLessThan(sequence.lastIndexOf('mount'))
  })

  // The undo-document-reset contract applied to the assembly editor: a uuid
  // change must NOT reuse the previous AssemblyEditor instance, because the
  // hook-local pendingSession / mateSnapshot / instanceSnapshot refs survive an
  // in-place update and would push the old document's pre-doc into the new one's
  // undo stack. DocumentPage keys the editor by uuid so the swap is a fresh
  // instance by construction.
  it('remounts the assembly editor when the uuid changes', async () => {
    load.mockImplementation(async () => ({ content: 'kind: assembly\nfeatures: []\n' }))

    function GoToB() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/documents/B')}>to B</button>
    }

    render(
      <MemoryRouter initialEntries={['/documents/A']}>
        <Routes>
          <Route path="/documents/:uuid" element={<DocumentPage />} />
        </Routes>
        <GoToB />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByText('ASSEMBLY EDITOR')).toBeInTheDocument()
      expect(assemblyLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(1)
    })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    await waitFor(() => {
      expect(assemblyLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(2)
    })
    const sequence = assemblyLifecycle.mock.calls.map(c => c[0])
    expect(sequence.indexOf('unmount')).toBeGreaterThan(-1)
    expect(sequence.indexOf('unmount')).toBeLessThan(sequence.lastIndexOf('mount'))
  })
})
