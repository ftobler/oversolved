import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta, ProvenanceRecord, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'
import type { OriginState, UpdateResult } from '@/workspace/import'

// R5, the origins half: what OriginsPanel showed is row meta now, and its two
// gestures are a card control and a row control.

const storeMock = vi.hoisted(() => ({
  list: vi.fn(async () => [{
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'p1',
  }]),
  addEntry: vi.fn(async (_w: string, _e: WorkspaceEntry) => 'new-id'),
  renameEntry: vi.fn(async () => {}),
  cloneEntry: vi.fn(async () => 'clone-id'),
  removeEntry: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  duplicate: vi.fn(async () => ({ workspace: 'ws2' })),
  trash: vi.fn(async () => {}),
  export: vi.fn(async () => []),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

vi.mock('@/stores/previewStore', () => ({ usePreview: () => undefined }))

// Only the two resolver-reading exports are replaced; the rest of the import
// module is what the store and the session pull in for themselves.
const originMock = vi.hoisted(() => ({
  originState: vi.fn<(record: ProvenanceRecord, localHash?: string) => Promise<OriginState>>(
    async () => ({ status: 'current', editedLocally: false }),
  ),
  updateFromOrigin: vi.fn<(workspace: string, localRoot: string) => Promise<UpdateResult>>(
    async () => ({ updated: 1, added: 0, unreachable: false, sourceMissing: false }),
  ),
}))
vi.mock('@/workspace/import', async importOriginal => ({
  ...(await importOriginal<typeof import('@/workspace/import')>()),
  originState: originMock.originState,
  updateFromOrigin: originMock.updateFromOrigin,
}))

import WorkspaceView from '@/pages/WorkspaceView'
import { bumpWorkspaceStoreRevision } from '@/workspace/storeEvents'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

// Bracket's local hash matches what was recorded, Gearbox's does not: one row
// is a clean copy and the other has drifted, which is the difference the pull
// control is allowed to act on before any check has run.
const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part', contentHash: 'h1' }),
  meta('a1', 'Gearbox', { docKind: 'assembly', contentHash: 'h2-local' }),
  meta('f1', 'shaft.step', { kind: 'file', fileKind: 'step', size: 1024 }),
]

const provenance: ProvenanceRecord[] = [
  { entry: 'p1', origin: 'folder:abc', originName: 'cad', originEntry: 's1', hash: 'h1', rev: 3 },
  { entry: 'a1', origin: 'zip:xyz', originName: 'lib.zip', originEntry: 's2', hash: 'h2' },
]

interface SessionOpts {
  all?: EntryMeta[]
  records?: ProvenanceRecord[]
}

function installSession({ all = entries, records = [] }: SessionOpts = {}) {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => all),
    savedRevs: vi.fn(async () => new Map<string, number>(all.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    originOf: vi.fn(async () => undefined),
    provenance: vi.fn(async () => records),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => ({})),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
  return session
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<div>EDITOR</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  Object.values(storeMock).forEach(fn => fn.mockClear())
  originMock.originState.mockReset()
  originMock.originState.mockResolvedValue({ status: 'current', editedLocally: false })
  originMock.updateFromOrigin.mockReset()
  originMock.updateFromOrigin.mockResolvedValue({ updated: 1, added: 0, unreachable: false, sourceMissing: false })
  storeMock.list.mockResolvedValue([{
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'p1',
  }])
})

describe('WorkspaceView origins', () => {
  it('names a row\'s source and calls it unchecked until a check runs', async () => {
    installSession({ records: provenance })
    renderView()
    await screen.findByText('Bracket')

    expect(screen.getByText('cad')).toBeTruthy()
    expect(screen.getByText('lib.zip')).toBeTruthy()
    expect(screen.getAllByText('Not checked')).toHaveLength(2)
    expect(screen.getByText('rev 3')).toBeTruthy()
    // Gearbox's local hash no longer matches the recorded source hash.
    expect(screen.getByText('edited locally')).toBeTruthy()
  })

  // Four more scraps of text landed inside the row's activate button, and an
  // unlabelled button is named by everything inside it.
  it('names the row\'s open button after the entry, not its whole contents', async () => {
    installSession({ records: provenance })
    renderView()
    await screen.findByText('Bracket')

    const open = screen.getByRole('button', { name: 'Bracket' })
    expect(open.classList.contains('workspace-entry-open')).toBe(true)
  })

  // I2: a mount, a render and a solve never resolve an origin. The check is the
  // only gesture that reaches for the source.
  it('resolves no origin until the check is clicked', async () => {
    installSession({ records: provenance })
    renderView()
    await screen.findByText('Bracket')
    expect(originMock.originState).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('Check for updates'))
    await waitFor(() => expect(originMock.originState).toHaveBeenCalledTimes(2))
    // The local hash rides along so the status can say "edited" without a
    // second read of the entry.
    expect(originMock.originState.mock.calls[0][1]).toBe('h1')
  })

  it('offers no check on a workspace that imported nothing', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')
    expect(screen.queryByLabelText('Check for updates')).toBeNull()
  })

  // A record outlives the copy it describes, and a record with no row is a
  // source nobody can see: checking it would resolve it for nothing.
  it('ignores a provenance record whose entry is gone', async () => {
    installSession({ records: [{ entry: 'deleted', origin: 'folder:abc', originEntry: 's9' }] })
    renderView()
    await screen.findByText('Bracket')
    expect(screen.queryByLabelText('Check for updates')).toBeNull()
    expect(screen.queryByText('Not checked')).toBeNull()
  })

  it('labels each row with what the check answered', async () => {
    installSession({ records: provenance })
    originMock.originState
      .mockResolvedValueOnce({ status: 'changed', editedLocally: false })
      .mockResolvedValueOnce({ status: 'current', editedLocally: true })
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Check for updates'))
    await screen.findByText('Origin changed')
    expect(screen.getByText('Up to date')).toBeTruthy()
  })

  // One unreachable source must not strand the rows behind it in the loop.
  it('checks the remaining rows when one resolver throws', async () => {
    installSession({ records: provenance })
    originMock.originState
      .mockRejectedValueOnce(new Error('handle revoked'))
      .mockResolvedValueOnce({ status: 'changed', editedLocally: false })
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Check for updates'))
    await screen.findByText('Origin unavailable')
    expect(screen.getByText('Origin changed')).toBeTruthy()
  })

  it('holds the pull back until a check has run, then pulls', async () => {
    installSession({ records: provenance })
    originMock.originState.mockResolvedValue({ status: 'changed', editedLocally: false })
    renderView()
    await screen.findByText('Bracket')

    const update = screen.getByLabelText('Update Bracket') as HTMLButtonElement
    expect(update).toBeDisabled()

    fireEvent.click(screen.getByLabelText('Check for updates'))
    await waitFor(() => expect(update).toBeEnabled())

    fireEvent.click(update)
    await waitFor(() => expect(originMock.updateFromOrigin).toHaveBeenCalledWith('ws', 'p1'))
  })

  // A pull rewrites the whole closure it reaches, not just the clicked row, so
  // EVERY status the check left is a comparison that no longer holds. The write
  // bumps the store revision, and the statuses are stamped with the revision
  // they were computed at.
  it('drops every row back to unchecked once a pull writes', async () => {
    installSession({ records: provenance })
    originMock.originState.mockResolvedValue({ status: 'changed', editedLocally: false })
    originMock.updateFromOrigin.mockImplementation(async () => {
      bumpWorkspaceStoreRevision()
      return { updated: 2, added: 0, unreachable: false, sourceMissing: false }
    })
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Check for updates'))
    await waitFor(() => expect(screen.getAllByText('Origin changed')).toHaveLength(2))

    fireEvent.click(screen.getByLabelText('Update Bracket'))
    await waitFor(() => expect(screen.getAllByText('Not checked')).toHaveLength(2))
  })

  // A pull that wrote nothing changed nothing, so it invalidates nothing.
  it('leaves the statuses standing when a pull writes nothing', async () => {
    installSession({ records: provenance })
    originMock.originState.mockResolvedValue({ status: 'changed', editedLocally: false })
    originMock.updateFromOrigin.mockResolvedValue(
      { updated: 0, added: 0, unreachable: false, sourceMissing: false },
    )
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Check for updates'))
    await waitFor(() => expect(screen.getAllByText('Origin changed')).toHaveLength(2))

    fireEvent.click(screen.getByLabelText('Update Bracket'))
    await waitFor(() => expect(originMock.updateFromOrigin).toHaveBeenCalled())
    expect(screen.getAllByText('Origin changed')).toHaveLength(2)
  })

  // A drifted copy can always be reset from its source, so that row does not
  // have to be checked first.
  it('offers the pull on a locally edited copy before any check', async () => {
    installSession({ records: provenance })
    renderView()
    await screen.findByText('Gearbox')
    expect(screen.getByLabelText('Update Gearbox')).toBeEnabled()
  })

  it('offers no pull on a row with no origin', async () => {
    installSession({ records: provenance })
    renderView()
    await screen.findByText('shaft.step')
    expect(screen.queryByLabelText('Update shaft.step')).toBeNull()
  })

  // A pull that wrote nothing has to say so: the click is otherwise
  // indistinguishable from a successful no-op update.
  it('says when a pull could not reach the source', async () => {
    installSession({ records: provenance })
    originMock.updateFromOrigin.mockResolvedValueOnce(
      { updated: 0, added: 0, unreachable: true, sourceMissing: false },
    )
    renderView()
    await screen.findByText('Gearbox')

    fireEvent.click(screen.getByLabelText('Update Gearbox'))
    await screen.findByText(/Origin unavailable; Gearbox was not updated\./)
  })

  it('says when the recorded source entry is gone', async () => {
    installSession({ records: provenance })
    originMock.updateFromOrigin.mockResolvedValueOnce(
      { updated: 0, added: 0, unreachable: false, sourceMissing: true },
    )
    renderView()
    await screen.findByText('Gearbox')

    fireEvent.click(screen.getByLabelText('Update Gearbox'))
    await screen.findByText(/The source entry is gone; Gearbox was not updated\./)
  })

  it('disables a pull while it is in flight', async () => {
    installSession({ records: provenance })
    let settle: (result: UpdateResult) => void = () => {}
    originMock.updateFromOrigin.mockReturnValueOnce(new Promise(resolve => { settle = resolve }))
    renderView()
    await screen.findByText('Gearbox')

    const update = screen.getByLabelText('Update Gearbox') as HTMLButtonElement
    fireEvent.click(update)
    expect(update).toBeDisabled()
    fireEvent.click(update)
    expect(originMock.updateFromOrigin).toHaveBeenCalledTimes(1)

    settle({ updated: 1, added: 0, unreachable: false, sourceMissing: false })
    await waitFor(() => expect(update).toBeEnabled())
  })
})
