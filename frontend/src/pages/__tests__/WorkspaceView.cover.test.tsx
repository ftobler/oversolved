import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'
import type { WorkspaceSummary } from '@/workspace/store'

// The row's cover toggle and marker, and the identity card following the store:
// a document row can stand for the workspace, a file row cannot, and the row the
// automatic rule resolved says so even when nobody chose it.

const storeMock = vi.hoisted(() => ({
  list: vi.fn(),
  setCover: vi.fn(async (_workspace: string, _entry: string | null) => {}),
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

const previewMock = vi.hoisted(() => ({ images: new Map<string, string>() }))
vi.mock('@/stores/previewStore', () => ({
  usePreview: (workspace: string, entry: string) => previewMock.images.get(`${workspace}:${entry}`),
}))

import WorkspaceView from '@/pages/WorkspaceView'
import { bumpWorkspaceStoreRevision } from '@/workspace/storeEvents'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part' }),
  meta('a1', 'Gearbox', { docKind: 'assembly' }),
  meta('f1', 'shaft.step', { kind: 'file', fileKind: 'step', size: 1024 }),
]

function summary(over: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    workspace: 'ws', name: 'test', entryCount: 3, size: 2048, rev: 1,
    createdAt: 0, updatedAt: 0, coverEntry: 'a1', ...over,
  }
}

function installSession() {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => entries),
    savedRevs: vi.fn(async () => new Map<string, number>(entries.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    originOf: vi.fn(async () => undefined),
    provenance: vi.fn(async () => []),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => ({})),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
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

const rowOf = (name: string) => screen.getByText(name).closest('.workspace-entry-row') as HTMLElement
const cardImage = () => document.querySelector<HTMLImageElement>('.workspace-identity-preview img')

// The store answers as it would after setCover wrote and bumped the revision.
async function storeAnswers(next: WorkspaceSummary) {
  storeMock.list.mockResolvedValue([next])
  await act(async () => { bumpWorkspaceStoreRevision() })
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  previewMock.images.clear()
  Object.values(storeMock).forEach(fn => fn.mockClear())
  storeMock.list.mockResolvedValue([summary()])
})

describe('WorkspaceView cover entry', () => {
  it('marks the automatic cover row and paints it on the card', async () => {
    previewMock.images.set('ws:a1', 'QVVUTw==')
    previewMock.images.set('ws:p1', 'UEFSVA==')
    installSession()
    renderView()
    await screen.findByText('Gearbox')

    expect(within(rowOf('Gearbox')).getByText('cover')).toBeTruthy()
    expect(within(rowOf('Bracket')).queryByText('cover')).toBeNull()
    expect(cardImage()?.src).toContain('QVVUTw==')
    // The automatic row is not a pressed choice: nobody picked it.
    expect(screen.getByLabelText('Cover for Gearbox')).toHaveAttribute('aria-pressed', 'false')
  })

  it('offers a cover toggle on document rows only, never on a file row', async () => {
    installSession()
    renderView()
    await screen.findByText('Gearbox')

    expect(screen.getByLabelText('Cover for Bracket')).toBeTruthy()
    expect(screen.getByLabelText('Cover for Gearbox')).toBeTruthy()
    expect(rowOf('shaft.step').querySelector('.workspace-entry-cover')).toBeNull()
    expect(document.querySelectorAll('.workspace-entry-cover')).toHaveLength(2)
  })

  it('sets the cover from a row and clears it back to automatic', async () => {
    previewMock.images.set('ws:a1', 'QVVUTw==')
    previewMock.images.set('ws:p1', 'UEFSVA==')
    installSession()
    renderView()
    await screen.findByText('Gearbox')

    fireEvent.click(screen.getByLabelText('Cover for Bracket'))
    await waitFor(() => expect(storeMock.setCover).toHaveBeenCalledWith('ws', 'p1'))

    await storeAnswers(summary({ coverEntry: 'p1', coverChoice: 'p1' }))
    await waitFor(() => expect(screen.getByLabelText('Cover for Bracket')).toHaveAttribute('aria-pressed', 'true'))
    expect(within(rowOf('Bracket')).getByText('cover')).toBeTruthy()
    expect(within(rowOf('Gearbox')).queryByText('cover')).toBeNull()
    expect(cardImage()?.src).toContain('UEFSVA==')

    // The pressed toggle is the way back: pressing it clears the choice.
    fireEvent.click(screen.getByLabelText('Cover for Bracket'))
    await waitFor(() => expect(storeMock.setCover).toHaveBeenLastCalledWith('ws', null))

    await storeAnswers(summary({ coverEntry: 'a1' }))
    await waitFor(() => expect(screen.getByLabelText('Cover for Bracket')).toHaveAttribute('aria-pressed', 'false'))
    expect(within(rowOf('Gearbox')).getByText('cover')).toBeTruthy()
    expect(cardImage()?.src).toContain('QVVUTw==')
  })

  // A cover entry that is trashed leaves the live rows; the card and the marker
  // move to the automatic pick without the user doing anything.
  it('falls back to the automatic row when the explicit one is no longer live', async () => {
    installSession()
    renderView()
    await screen.findByText('Gearbox')

    await storeAnswers(summary({ coverEntry: 'p1', coverChoice: 'p1' }))
    await waitFor(() => expect(screen.getByLabelText('Cover for Bracket')).toHaveAttribute('aria-pressed', 'true'))

    await storeAnswers(summary({ coverEntry: 'a1' }))
    await waitFor(() => expect(screen.getByLabelText('Cover for Bracket')).toHaveAttribute('aria-pressed', 'false'))
    expect(within(rowOf('Gearbox')).getByText('cover')).toBeTruthy()
  })
})
