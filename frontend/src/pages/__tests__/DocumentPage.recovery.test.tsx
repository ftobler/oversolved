import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
import { IdbWorkspaceStore } from '@/workspace/store'
import { useRecoveryStore } from '@/stores/recoveryStore'

// The real editors mount workers and a canvas; the recovery decision is the
// only thing under test, so the part editor is a label that proves mount order.
vi.mock('@/pages/AssemblyEditor', () => ({
  default: function AssemblyEditorMock() {
    return <div>ASSEMBLY EDITOR</div>
  },
}))
vi.mock('@/pages/Part', () => ({
  default: function PartMock() {
    return <div>PART EDITOR</div>
  },
}))

const load = vi.fn()
vi.mock('@/adapters/backend', () => ({
  backendBundle: {
    get documents() { return { load } },
    cloudDocuments: null,
  },
}))

import DocumentPage from '@/pages/DocumentPage'

const text = (v: string) => `kind: part\n# ${v}\n`

beforeEach(() => {
  resetWorkspaceIdb()
  act(() => { useRecoveryStore.getState().reset() })
  load.mockReset()
  load.mockImplementation(async () => ({ content: text('dirty'), name: 'Doc', kind: 'part' }))
})

afterEach(() => {
  act(() => { useRecoveryStore.getState().reset() })
})

function wrap(workspace: string) {
  return render(
    <MemoryRouter initialEntries={[`/documents/${workspace}`]}>
      <Routes>
        <Route path="/documents/:uuid" element={<DocumentPage />} />
      </Routes>
    </MemoryRouter>,
  )
}

async function dirtyWorkspace(store: IdbWorkspaceStore): Promise<string> {
  const { workspace } = await store.create('Doc', { docKind: 'part' })
  await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('dirty') })
  return workspace
}

describe('DocumentPage recovery prompt', () => {
  it('asks before mounting the editor when the working copy is ahead', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await dirtyWorkspace(store)

    wrap(workspace)

    await waitFor(() => expect(screen.getByText('Recover unsaved edits?')).toBeInTheDocument())
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
    expect(screen.getByText(/Keep them, or discard them/)).toBeInTheDocument()
  })

  it('does not ask for a clean workspace', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })

    wrap(workspace)

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect(screen.queryByText('Recover unsaved edits?')).not.toBeInTheDocument()
  })

  it('Keep adopts the working copy and mounts the editor', async () => {
    const store = new IdbWorkspaceStore()
    const workspace = await dirtyWorkspace(store)
    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Recover unsaved edits?')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByText('Keep edits')) })

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect((await store.open(workspace)).ahead).toBe(false)
    expect((await store.readEntry(workspace, workspace)).text).toBe(text('dirty'))
  })

  it('Discard resets the working copy and mounts the editor', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('saved') })
    await store.save(workspace, (await store.open(workspace)).tree)
    await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('dirty') })
    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Recover unsaved edits?')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByText('Discard edits')) })

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect((await store.readEntry(workspace, workspace)).text).toBe(text('saved'))
    expect((await store.open(workspace)).ahead).toBe(false)
  })
})
