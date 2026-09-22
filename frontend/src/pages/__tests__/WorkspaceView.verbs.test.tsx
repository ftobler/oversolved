import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

// The identity card's own verbs and the two guards on the row-level delete. The
// other WorkspaceView suites drive the entry rows; these drive add, rename,
// duplicate, export and trash on THIS level, plus the referrer jump from the
// delete refusal. Each one is a real user gesture with an observable outcome.
const storeMock = vi.hoisted(() => ({
  list: vi.fn(),
  addEntry: vi.fn(async () => 'new-id'),
  renameEntry: vi.fn(async () => {}),
  cloneEntry: vi.fn(async () => 'clone-id'),
  removeEntry: vi.fn(async () => {}),
  rename: vi.fn(async () => {}),
  duplicate: vi.fn(async () => ({ workspace: 'ws2' })),
  trash: vi.fn(async () => {}),
  export: vi.fn(),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

vi.mock('@/stores/previewStore', () => ({ usePreview: () => undefined }))

vi.mock('@/kernel/worker/workerFiles', async importOriginal => ({
  ...(await importOriginal<typeof import('@/kernel/worker/workerFiles')>()),
  dropWorkerFileId: vi.fn(),
}))

const downloads = vi.hoisted(() => ({ calls: [] as { blob: Blob; filename: string }[] }))
vi.mock('@/utils/core/downloadBlob', () => ({
  downloadBlob: (blob: Blob, filename: string) => { downloads.calls.push({ blob, filename }) },
}))

import WorkspaceView from '@/pages/WorkspaceView'
import { EntryReferencedError } from '@/workspace/errors'
import { emptyManifest, serializeManifest } from '@/workspace/manifest'
import { MANIFEST_PATH } from '@/workspace/paths'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

const SUMMARY = {
  workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
  createdAt: 0, updatedAt: 0, coverEntry: 'p1',
}

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part' }),
  meta('a1', 'Gearbox', { docKind: 'assembly' }),
]

function installSession(all: EntryMeta[] = entries) {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => all),
    savedRevs: vi.fn(async () => new Map<string, number>(all.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    originOf: vi.fn(async () => undefined),
    provenance: vi.fn(async () => []),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => ({})),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
  return session
}

function EntrySentinel() {
  const { entryId } = useParams<{ entryId: string }>()
  return <div>EDITOR {entryId}</div>
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
        <Route path="/workspaces/ws2" element={<div>WS2</div>} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<EntrySentinel />} />
        <Route path="/workspaces" element={<div>LIBRARY</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

const dialog = () => document.querySelector('.dialog-component') as HTMLElement

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  downloads.calls = []
  Object.values(storeMock).forEach(fn => fn.mockClear())
  storeMock.list.mockResolvedValue([SUMMARY])
  storeMock.duplicate.mockResolvedValue({ workspace: 'ws2' })
  // A real serialized manifest, so the export path runs deserializeTree and
  // buildZipBytes for real rather than over a stubbed archive.
  storeMock.export.mockResolvedValue([
    { path: MANIFEST_PATH, data: serializeManifest(emptyManifest('ws')) },
  ])
})

describe('WorkspaceView identity-card verbs', () => {
  it('adds an entry with the typed name and kind, then opens it', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Add entry'))
    fireEvent.change(within(dialog()).getByPlaceholderText('Entry name'), { target: { value: '  Plate  ' } })
    fireEvent.change(within(dialog()).getByLabelText('Entry kind'), { target: { value: 'assembly' } })
    fireEvent.click(within(dialog()).getByText('Add'))

    await waitFor(() => expect(storeMock.addEntry).toHaveBeenCalledTimes(1))
    const [workspace, entry] = storeMock.addEntry.mock.calls[0] as unknown as [string, WorkspaceEntry]
    expect(workspace).toBe('ws')
    // The name is trimmed before it reaches the store.
    expect(entry).toMatchObject({ kind: 'document', name: 'Plate', docKind: 'assembly', text: '' })
    // The new entry opens straight into its editor.
    await screen.findByText(new RegExp(`^EDITOR ${entry.id}$`))
  })

  it('refuses a blank add and leaves the dialog open', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Add entry'))
    await act(async () => { fireEvent.click(within(dialog()).getByText('Add')) })

    expect(storeMock.addEntry).not.toHaveBeenCalled()
    expect(screen.getByText('Add Entry')).toBeTruthy()
  })

  it('renames the workspace from the identity card', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Rename workspace'))
    const input = within(dialog()).getByLabelText('Workspace name') as HTMLInputElement
    expect(input.value).toBe('test')
    fireEvent.change(input, { target: { value: 'Renamed' } })
    fireEvent.click(within(dialog()).getByText('Rename'))

    await waitFor(() => expect(storeMock.rename).toHaveBeenCalledWith('ws', 'Renamed'))
    await waitFor(() => expect(screen.queryByText('Rename Workspace')).toBeNull())
  })

  it('duplicates the workspace and navigates to the copy', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Duplicate workspace'))

    await waitFor(() => expect(storeMock.duplicate).toHaveBeenCalledWith('ws'))
    await screen.findByText('WS2')
  })

  it('exports the workspace as a named zip', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Export workspace'))

    await waitFor(() => expect(downloads.calls).toHaveLength(1))
    expect(downloads.calls[0].filename).toBe('test.zip')
    expect(downloads.calls[0].blob.type).toBe('application/zip')
    expect(downloads.calls[0].blob.size).toBeGreaterThan(0)
  })

  it('moves the workspace to trash and returns to the library', async () => {
    installSession()
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Move workspace to trash'))
    // The move is irreversible from this view, so it confirms first.
    fireEvent.click(screen.getByRole('button', { name: 'Move to Trash' }))

    await waitFor(() => expect(storeMock.trash).toHaveBeenCalledWith('ws'))
    await screen.findByText('LIBRARY')
  })

  it('reports a failed identity-card verb in the banner', async () => {
    installSession()
    storeMock.duplicate.mockRejectedValueOnce(new Error('db locked'))
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Duplicate workspace'))

    await screen.findByText('db locked')
  })

  it('reports a failed add inside its own dialog, not behind it', async () => {
    installSession()
    storeMock.addEntry.mockRejectedValueOnce(new Error('quota exceeded'))
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Add entry'))
    fireEvent.change(within(dialog()).getByPlaceholderText('Entry name'), { target: { value: 'Plate' } })
    fireEvent.click(within(dialog()).getByText('Add'))

    await screen.findByText('quota exceeded')
    // The dialog stays up so the typed name survives the failure.
    expect(screen.getByText('Add Entry')).toBeTruthy()
  })
})

describe('WorkspaceView delete guards', () => {
  it('reports a plain delete failure in the banner', async () => {
    installSession()
    storeMock.removeEntry.mockRejectedValueOnce(new Error('index corrupt'))
    renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Delete Bracket'))

    await screen.findByText('index corrupt')
  })

  it('opens the referrer named by a refused delete', async () => {
    installSession()
    storeMock.removeEntry.mockRejectedValueOnce(
      new EntryReferencedError('p1', [{ id: 'a1', name: 'Gearbox' }]),
    )
    const { container } = renderView()
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Delete Bracket'))
    await screen.findByText('Cannot Delete')

    // The guard's own button is the jump: it must resolve the referrer id back
    // to the row and open that entry, not just name it.
    const open = container.querySelector('.where-used-open') as HTMLButtonElement
    fireEvent.click(open)

    await screen.findByText(/^EDITOR a1$/)
    expect(screen.queryByText('Cannot Delete')).toBeNull()
  })
})
