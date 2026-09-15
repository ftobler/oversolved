import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
import { IdbWorkspaceStore } from '@/workspace/store'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

// Every branch of the entry route that is not an editor keeps the app header,
// so a refused entry is a wrong turn with a way back rather than a bare viewer
// holding the user in a corner -- and so an editor that unmounts into one lands
// somewhere its guarded links and its save button still exist. The flag's own
// behaviour on unmount is the guard hook's, and is asserted in
// hooks/__tests__/useUnsavedChangesGuard.test.tsx; these two cover the chrome.

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
  },
}))

import WorkspacePage from '@/pages/WorkspacePage'

beforeEach(() => {
  resetWorkspaceIdb()
  act(() => { useRecoveryStore.getState().reset() })
  act(() => { useUnsavedChangesStore.getState().setDirty(false) })
  load.mockReset()
  load.mockImplementation(async () => ({ content: 'kind: part\n', name: 'Doc', kind: 'part' }))
})

afterEach(() => {
  act(() => { useRecoveryStore.getState().reset() })
})

function wrap(workspace: string, entry: string) {
  return render(
    <MemoryRouter initialEntries={[`/workspaces/${workspace}/entries/${entry}`]}>
      <Routes>
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('WorkspacePage exits from the entry route', () => {
  it('gives a refused entry the header rather than a bare viewer', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    load.mockImplementation(async () => ({ content: '', name: 'Mystery', kind: 'spreadsheet' }))

    wrap(workspace, 'mystery')

    await waitFor(() => expect(screen.getByText(/^Error:/)).toBeInTheDocument())
    // The burger belongs to the header, so its presence is the way back out.
    expect(screen.getByTitle('Workspaces')).toBeInTheDocument()
  })

  it('gives the loading branch the header too, so the chrome does not flicker away', async () => {
    const store = new IdbWorkspaceStore()
    const { workspace } = await store.create('Doc', { docKind: 'part' })
    load.mockImplementation(() => new Promise(() => {}))  // never resolves

    wrap(workspace, workspace)

    expect(await screen.findByTitle('Workspaces')).toBeInTheDocument()
    expect(screen.queryByText('PART EDITOR')).not.toBeInTheDocument()
  })
})
