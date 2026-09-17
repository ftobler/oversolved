import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom'

// The real editors mount workers, three.js and a canvas. Routing is all that is
// under test here, so stub both sides and assert which one was chosen. The Part
// and AssemblyEditor stubs record mount/unmount so the keyed-remount tests can
// assert the instances actually change when the entry does.
//
// Lifecycle is recorded in useEffect, a passive effect. RTL's waitFor runs
// outside act, so mount/unmount counts must be asserted INSIDE a waitFor.
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
  },
}))

import WorkspacePage from '@/pages/WorkspacePage'

beforeEach(() => {
  load.mockReset()
  partLifecycle.mockClear()
  assemblyLifecycle.mockClear()
})

// A load payload carries both kinds: the structural one the gate refuses a file
// by, and the open one that picks the editor. The helper spells the structural
// kind so a test that means "a document" cannot accidentally leave it out.
function doc(payload: { content: string; name?: string; docKind?: string }) {
  return { kind: 'document' as const, name: '', ...payload }
}

function wrap(entry = 'A') {
  return render(
    <MemoryRouter initialEntries={[`/workspaces/ws/entries/${entry}`]}>
      <Routes>
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>
  )
}

describe('WorkspacePage kind routing', () => {
  it('routes kind: assembly to the assembly editor', async () => {
    load.mockResolvedValue(doc({ content: 'kind: assembly\nfeatures: []\n' }))
    wrap()
    await waitFor(() => expect(screen.getByText('ASSEMBLY EDITOR')).toBeInTheDocument())
  })

  it('routes an empty body with kind: part to the part editor', async () => {
    load.mockResolvedValue(doc({ content: '', name: 'Bracket', docKind: 'part' }))
    wrap()
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
  })

  it('routes an explicit kind: part to the part editor', async () => {
    load.mockResolvedValue(doc({ content: 'kind: part\nfeatures: []\n' }))
    wrap()
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
  })

  // I6: an unrecognised kind refuses by name, never reading as a part.
  it('refuses an unknown kind by name instead of routing to the part editor', async () => {
    load.mockResolvedValue(doc({ content: 'kind: sketch\n', name: 'Draft', docKind: 'sketch' }))
    wrap()
    await waitFor(() => expect(screen.getByText(/unsupported kind 'sketch'/)).toBeInTheDocument())
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
    expect(screen.queryByText('ASSEMBLY EDITOR')).not.toBeInTheDocument()
  })

  it('refuses a document with no kind by name', async () => {
    load.mockResolvedValue(doc({ content: 'features: []\n', name: 'Legacy' }))
    wrap()
    await waitFor(() => expect(screen.getByText(/has no kind/)).toBeInTheDocument())
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
  })

  // The entry route is reachable by typed URL, so a file id can arrive here. It
  // must refuse as what it is: the structural kind travels on the payload, and
  // asserting `'document'` at this call site made the gate's not-a-document
  // branch dead and mislabelled every file as a document with no kind.
  it('refuses a file entry as a file, not as a document with no kind', async () => {
    load.mockResolvedValue({ kind: 'file', name: 'bracket.step', content: '' })
    wrap()
    await waitFor(() => expect(screen.getByText(/'bracket.step' is not a document/)).toBeInTheDocument())
    expect(screen.queryByText(/has no kind/)).not.toBeInTheDocument()
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
    expect(screen.queryByText('ASSEMBLY EDITOR')).not.toBeInTheDocument()
  })

  // A file whose bytes happen to parse as YAML with a known kind is the sharp
  // case: the content fallback would read it as a part if the structural kind
  // were not consulted first.
  it('refuses a file entry even when its content parses as a known kind', async () => {
    load.mockResolvedValue({ kind: 'file', name: 'notes.yaml', content: 'kind: part\nfeatures: []\n' })
    wrap()
    await waitFor(() => expect(screen.getByText(/'notes.yaml' is not a document/)).toBeInTheDocument())
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
  })

  it('surfaces a load failure instead of routing anywhere', async () => {
    load.mockRejectedValue(new Error('boom'))
    wrap()
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())
    expect(screen.queryByText('ASSEMBLY EDITOR')).not.toBeInTheDocument()
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
  })

  // The undo-document-reset contract: an entry change must NOT keep the old Part
  // instance, because the old instance carries the previous document's undo
  // stacks and edit-session refs. The page keys Part by entry id.
  it('remounts the part editor when the entry changes', async () => {
    load.mockImplementation(async () => doc({ content: 'kind: part\nfeatures: []\n' }))

    function GoToB() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/workspaces/ws/entries/B')}>to B</button>
    }

    render(
      <MemoryRouter initialEntries={['/workspaces/ws/entries/A']}>
        <Routes>
          <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
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
    const sequence = partLifecycle.mock.calls.map(c => c[0])
    expect(sequence.indexOf('unmount')).toBeGreaterThan(-1)
    expect(sequence.indexOf('unmount')).toBeLessThan(sequence.lastIndexOf('mount'))
  })

  it('remounts the assembly editor when the entry changes', async () => {
    load.mockImplementation(async () => doc({ content: 'kind: assembly\nfeatures: []\n' }))

    function GoToB() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/workspaces/ws/entries/B')}>to B</button>
    }

    render(
      <MemoryRouter initialEntries={['/workspaces/ws/entries/A']}>
        <Routes>
          <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
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

  // Cross-kind navigation is the sharp edge: while B's load is pending, neither
  // editor may be mounted.
  it('never mounts the wrong editor while a cross-kind navigation loads', async () => {
    load.mockImplementation(async () => doc({ content: 'kind: part\nfeatures: []\n' }))

    function GoToB() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/workspaces/ws/entries/B')}>to B</button>
    }

    render(
      <MemoryRouter initialEntries={['/workspaces/ws/entries/A']}>
        <Routes>
          <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
        </Routes>
        <GoToB />
      </MemoryRouter>
    )
    await waitFor(() => {
      expect(screen.getByText('PART EDITOR')).toBeInTheDocument()
      expect(partLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(1)
    })

    let resolveB!: (value: ReturnType<typeof doc>) => void
    const pendingB = new Promise<ReturnType<typeof doc>>(resolve => { resolveB = resolve })
    load.mockImplementation(async (entry: string) => {
      if (entry === 'B') return pendingB
      return doc({ content: 'kind: part\nfeatures: []\n' })
    })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument()
      expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
      expect(screen.queryByText('ASSEMBLY EDITOR')).not.toBeInTheDocument()
      expect(assemblyLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(0)
    })

    resolveB(doc({ content: 'kind: assembly\nfeatures: []\n' }))

    await waitFor(() => {
      expect(screen.getByText('ASSEMBLY EDITOR')).toBeInTheDocument()
      expect(assemblyLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(1)
      expect(partLifecycle.mock.calls.filter(c => c[0] === 'mount')).toHaveLength(1)
    })
  })

  it('clears a stale load error when the entry changes', async () => {
    load.mockRejectedValue(new Error('boom'))

    function GoToB() {
      const navigate = useNavigate()
      return <button onClick={() => navigate('/workspaces/ws/entries/B')}>to B</button>
    }

    render(
      <MemoryRouter initialEntries={['/workspaces/ws/entries/A']}>
        <Routes>
          <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
        </Routes>
        <GoToB />
      </MemoryRouter>
    )
    await waitFor(() => expect(screen.getByText(/boom/)).toBeInTheDocument())

    let resolveB!: (value: ReturnType<typeof doc>) => void
    const pendingB = new Promise<ReturnType<typeof doc>>(resolve => { resolveB = resolve })
    load.mockImplementation(async (entry: string) => {
      if (entry === 'B') return pendingB
      throw new Error('boom')
    })

    fireEvent.click(screen.getByRole('button', { name: 'to B' }))

    await waitFor(() => {
      expect(screen.getByText('Loading...')).toBeInTheDocument()
      expect(screen.queryByText(/boom/)).not.toBeInTheDocument()
    })

    resolveB(doc({ content: 'kind: part\nfeatures: []\n' }))
    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
  })
})
