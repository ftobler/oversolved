import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

// The regression for the 2026-11-16 report: a part row used to offer an origin
// chip, a status and an Update control, and the workspace card a Check button.
// An import is a plain copy now, so the row shows its name, its meta, who uses
// it and the dirty dot, and nothing about a source.

const storeMock = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

vi.mock('@/hooks/usePreview', () => ({ usePreview: () => undefined }))

import WorkspaceView from '@/pages/WorkspaceView'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

const SUMMARY = {
  workspace: 'ws', name: 'test', entryCount: 2, size: 1024, rev: 2,
  createdAt: 0, updatedAt: 0, coverEntry: 'p1',
}

const entries: EntryMeta[] = [
  { id: 'p1', path: 'documents/Bracket.yaml', kind: 'document', name: 'Bracket', docKind: 'part', rev: 2, updatedAt: 0, contentHash: 'h' },
  { id: 'a1', path: 'documents/Gearbox.yaml', kind: 'document', name: 'Gearbox', docKind: 'assembly', rev: 1, updatedAt: 0, contentHash: 'g' },
]

function installSession() {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => entries),
    // p1 is one rev ahead of the checkpoint, so it carries the dirty dot.
    savedRevs: vi.fn(async () => new Map<string, number>([['p1', 1], ['a1', 1]])),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    resolveFile: vi.fn(async () => undefined),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => ({ a1: ['p1'] })),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
}

function renderView() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceView />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  storeMock.list.mockReset()
  storeMock.list.mockResolvedValue([SUMMARY])
})

describe('WorkspaceView imported row', () => {
  it('shows name, meta, used-by and the dirty dot, and no origin signal', async () => {
    installSession()
    renderView()

    await screen.findByText('Bracket')
    expect(await screen.findByText('used by Gearbox')).toBeInTheDocument()
    expect(screen.getByText('part')).toBeInTheDocument()
    expect(screen.getByLabelText('Changed since last save')).toBeInTheDocument()
    // The open surface is still the row's verb and it is named after the entry,
    // not after the meta text inside it.
    expect(screen.getByRole('button', { name: 'Bracket' })).toBeInTheDocument()

    // Nothing the origin system used to draw: no status chip, no source name,
    // no local-edit badge and no pull control on the row.
    expect(screen.queryByText('Not checked')).toBeNull()
    expect(screen.queryByText('edited locally')).toBeNull()
    expect(screen.queryByLabelText('Update Bracket')).toBeNull()

    // The card's workspace-wide Check verb is gone with them.
    expect(screen.queryByTitle('Check for updates')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Check for updates' })).toBeNull()
  })
})
