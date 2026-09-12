import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { resetWorkspaceIdb } from '@/workspace/__tests__/idbHarness'
import { getWorkspaceStore } from '@/workspace/store'
import { useCarrierChangeStore } from '@/stores/carrierChangeStore'
import { useRecoveryStore } from '@/stores/recoveryStore'
import { parseManifest, serializeManifest } from '@/workspace/manifest'
import { MANIFEST_PATH } from '@/workspace/paths'
import { forgetWorkspaceHandle } from '@/workspace/workspaceHandleRegistry'
import { fakeDirectory, type FakeDirectoryHandle } from '@/stores/documentStore/__tests__/fakeFileSystemDirectory'

// P4b at the page level. A carrier change and a crash-ahead working copy can be
// true at once; the carrier dialog must own the first decision and U7 must wait
// for a non-reload resolution, while an unavailable carrier stays neutral.

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

const text = (v: string) => `kind: part\n# ${v}\n`

function folderBinding(dir: FakeDirectoryHandle) {
  return { kind: 'folder' as const, label: dir.name, handle: dir as unknown as FileSystemDirectoryHandle }
}

function foreignChange(dir: FakeDirectoryHandle, entryId: string) {
  const held = parseManifest(dir.snapshot()[MANIFEST_PATH])
  const changed = { ...held, entries: { ...held.entries } }
  delete changed.entries[entryId]
  dir.putText(MANIFEST_PATH, serializeManifest(changed))
}

// A folder-bound workspace that is dirty versus its checkpoint and whose carrier
// has been rewritten behind it: both the carrier prompt and U7 are eligible.
async function changedAndDirty() {
  const store = getWorkspaceStore()
  const dir = fakeDirectory('cad')
  const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
  await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('saved') })
  await store.save(workspace, (await store.open(workspace)).tree)
  await store.writeEntry(workspace, { id: workspace, kind: 'document', name: 'Doc', docKind: 'part', text: text('dirty') })
  foreignChange(dir, workspace)
  return { store, dir, workspace }
}

beforeEach(() => {
  resetWorkspaceIdb()
  act(() => {
    useCarrierChangeStore.getState().reset()
    useRecoveryStore.getState().reset()
  })
  load.mockReset()
  load.mockImplementation(async () => ({ content: text('dirty'), name: 'Doc', kind: 'part' }))
})

afterEach(() => {
  act(() => {
    useCarrierChangeStore.getState().reset()
    useRecoveryStore.getState().reset()
  })
})

function wrap(workspace: string) {
  return render(
    <MemoryRouter initialEntries={[`/workspaces/${workspace}/entries/${workspace}`]}>
      <Routes>
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspacePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('WorkspacePage carrier change', () => {
  it('shows the carrier dialog first and holds U7 back', async () => {
    const { workspace } = await changedAndDirty()

    wrap(workspace)

    await waitFor(() => expect(screen.getByText('Workspace changed on disk')).toBeInTheDocument())
    expect(screen.queryByText('Recover unsaved edits?')).not.toBeInTheDocument()
  })

  it('does not resolve the change until the user chooses', async () => {
    const { store, workspace } = await changedAndDirty()

    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Workspace changed on disk')).toBeInTheDocument())

    expect((await store.readEntry(workspace, workspace)).text).toBe(text('dirty'))
    expect(screen.getByText('Reload from carrier')).toBeInTheDocument()
    expect(screen.getByText('Save over')).toBeInTheDocument()
    expect(screen.getByText('Keep my copy')).toBeInTheDocument()
  })

  it('arms U7 after Keep, the non-reload resolution', async () => {
    const { workspace } = await changedAndDirty()

    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Workspace changed on disk')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByText('Keep my copy')) })

    await waitFor(() => expect(screen.getByText('Recover unsaved edits?')).toBeInTheDocument())
    expect(screen.queryByText('Workspace changed on disk')).not.toBeInTheDocument()
  })

  it('reload resolves without asking U7 and replaces the working copy', async () => {
    const { store, workspace } = await changedAndDirty()

    wrap(workspace)
    await waitFor(() => expect(screen.getByText('Workspace changed on disk')).toBeInTheDocument())

    await act(async () => { fireEvent.click(screen.getByText('Reload from carrier')) })

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect(screen.queryByText('Recover unsaved edits?')).not.toBeInTheDocument()
    expect(await store.listEntries(workspace)).toEqual([])
  })

  it('treats an unavailable carrier as neutral and still opens the editor', async () => {
    const store = getWorkspaceStore()
    const dir = fakeDirectory('cad')
    const { workspace } = await store.create('Doc', { docKind: 'part', target: folderBinding(dir) })
    await forgetWorkspaceHandle(workspace)
    await store.close(workspace)

    wrap(workspace)

    await waitFor(() => expect(screen.getByText('PART EDITOR')).toBeInTheDocument())
    expect(screen.queryByText('Workspace changed on disk')).not.toBeInTheDocument()
  })
})
