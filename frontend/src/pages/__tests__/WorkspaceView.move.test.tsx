import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMovePlanResult } from '@/workspace/entryMove'
import type { EntryMoveReport } from '@/workspace/store'

// The row's "Move to workspace..." flow against a mocked store: the picker,
// the plan's refusal, the confirm step, and the report a finished move leaves.
const storeMock = vi.hoisted(() => ({
  list: vi.fn(),
  planMove: vi.fn(),
  moveEntry: vi.fn(),
  readEntry: vi.fn(),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))
vi.mock('@/hooks/usePreview', () => ({ usePreview: () => undefined }))

import WorkspaceView from '@/pages/WorkspaceView'
import { entryMoveReportText } from '@/workspace/entryMove'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { bumpWorkspaceStoreRevision } from '@/workspace/storeEvents'

const summary = (workspace: string, name: string) => ({
  workspace, name, entryCount: 1, size: 0, rev: 1, createdAt: 0, updatedAt: 0,
})

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, updatedAt: 0, ...extra }
}

let entries: EntryMeta[] = []

function installSession() {
  const session = {
    workspace: 'ws',
    listEntries: vi.fn(async () => entries),
    savedRevs: vi.fn(async () => new Map<string, number>(entries.map(e => [e.id, e.rev ?? 0]))),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
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
      </Routes>
    </MemoryRouter>,
  )
}

const dialog = () => document.querySelector('.dialog-component') as HTMLElement

beforeEach(() => {
  entries = [
    meta('p1', 'stud', { docKind: 'part' }),
    meta('p2', 'plate', { docKind: 'part' }),
    meta('a1', 'frame', { docKind: 'assembly' }),
    meta('f1', 'stud.step', { kind: 'file', fileKind: 'step', mime: 'application/step', size: 3 }),
  ]
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  Object.values(storeMock).forEach(fn => fn.mockReset())
  storeMock.list.mockResolvedValue([summary('ws', 'Bench'), summary('shop', 'Shop')])
})

async function openMove(name: string) {
  fireEvent.click(await screen.findByRole('button', { name: `Move ${name} to workspace` }))
  await within(dialog()).findByText('Shop')
}

describe('WorkspaceView move to workspace', () => {
  it('offers the move on document rows and not on file rows', async () => {
    installSession()
    renderView()
    await screen.findByText('stud.step')
    expect(screen.getByRole('button', { name: 'Move stud to workspace' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Move frame to workspace' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Move stud.step to workspace' })).not.toBeInTheDocument()
  })

  it('lists the other workspaces only, and keeps a refusal in the open dialog', async () => {
    installSession()
    storeMock.planMove.mockResolvedValue({
      ok: false, refused: 'stud is used by frame; move frame instead, or remove it from frame first.',
    } satisfies EntryMovePlanResult)
    renderView()
    await openMove('stud')

    expect(within(dialog()).queryByText('Bench')).not.toBeInTheDocument()
    fireEvent.doubleClick(within(dialog()).getByText('Shop'))

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('stud is used by frame; move frame instead')
    expect(storeMock.planMove).toHaveBeenCalledWith('ws', 'p1', 'shop')
    expect(storeMock.moveEntry).not.toHaveBeenCalled()
    expect(within(dialog()).getByText('Move to workspace')).toBeInTheDocument()
  })

  it('moves a lone part at once and shows the report', async () => {
    installSession()
    storeMock.planMove.mockResolvedValue({
      ok: true, entry: 'p2', move: ['p2'], copy: [], files: [], present: [], sharedWith: {},
    } satisfies EntryMovePlanResult)
    storeMock.moveEntry.mockImplementation(async () => {
      entries = entries.filter(entry => entry.id !== 'p2')
      bumpWorkspaceStoreRevision()  // what the real store does once the rows land
      return { target: 'Shop', moved: [{ id: 'p2', name: 'plate', kind: 'document' }], copied: [] } satisfies EntryMoveReport
    })
    renderView()
    await openMove('plate')
    fireEvent.click(within(dialog()).getByText('Shop'))
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Move' }))

    expect(await screen.findByText('Moved plate to Shop.')).toBeInTheDocument()
    expect(storeMock.moveEntry).toHaveBeenCalledWith('ws', 'p2', 'shop', expect.objectContaining({ move: ['p2'] }))
    await waitFor(() => expect(screen.queryByText('plate')).not.toBeInTheDocument())
    expect(screen.getByText('stud')).toBeInTheDocument()
  })

  it('asks before moving an assembly that takes its parts along, then reports what went', async () => {
    installSession()
    storeMock.planMove.mockResolvedValue({
      ok: true, entry: 'a1', move: ['a1', 'p2'], copy: ['p1', 'f1'], files: ['f1'], present: [],
      sharedWith: { p1: ['frame-2'], f1: ['stud'] },
    } satisfies EntryMovePlanResult)
    storeMock.moveEntry.mockResolvedValue({
      target: 'Shop',
      moved: [{ id: 'a1', name: 'frame', kind: 'document' }, { id: 'p2', name: 'plate', kind: 'document' }],
      copied: [{ id: 'p1', name: 'stud', kind: 'document' }, { id: 'f1', name: 'stud.step', kind: 'file' }],
    } satisfies EntryMoveReport)
    renderView()
    await openMove('frame')
    fireEvent.doubleClick(within(dialog()).getByText('Shop'))

    // The confirm step replaces the picker, so it is looked up afresh.
    expect(await screen.findByText('Move frame with plate and stud (stud is also used by frame-2 and is copied).'))
      .toBeInTheDocument()
    expect(storeMock.moveEntry).not.toHaveBeenCalled()
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Move' }))

    await waitFor(() => expect(storeMock.moveEntry).toHaveBeenCalledWith(
      'ws', 'a1', 'shop', expect.objectContaining({ move: ['a1', 'p2'], copy: ['p1', 'f1'] }),
    ))
    expect(await screen.findByText(
      'Moved frame with plate to Shop. stud is still used here, so it was copied. 1 file went along.',
    )).toBeInTheDocument()
  })

  it('goes back to the picker from the confirm step without moving', async () => {
    installSession()
    storeMock.planMove.mockResolvedValue({
      ok: true, entry: 'a1', move: ['a1', 'p2'], copy: [], files: [], present: [], sharedWith: {},
    } satisfies EntryMovePlanResult)
    renderView()
    await openMove('frame')
    fireEvent.doubleClick(within(dialog()).getByText('Shop'))
    await screen.findByText('Move frame with plate.')
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }))

    await waitFor(() => expect(within(dialog()).getByText('Shop')).toBeInTheDocument())
    expect(storeMock.moveEntry).not.toHaveBeenCalled()
  })

  it('shows a move that fails in the dialog rather than closing it', async () => {
    installSession()
    storeMock.planMove.mockResolvedValue({
      ok: true, entry: 'p2', move: ['p2'], copy: [], files: [], present: [], sharedWith: {},
    } satisfies EntryMovePlanResult)
    storeMock.moveEntry.mockRejectedValue(new Error('Shop already has plate; delete it there first.'))
    renderView()
    await openMove('plate')
    fireEvent.doubleClick(within(dialog()).getByText('Shop'))

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Shop already has plate')
  })
})

describe('entryMoveReportText', () => {
  it('names the documents, counts the files and says what was copied', () => {
    expect(entryMoveReportText({
      target: 'Shop',
      moved: [{ id: 'a', name: 'frame', kind: 'document' }, { id: 'f', name: 'a.step', kind: 'file' }, { id: 'g', name: 'b.step', kind: 'file' }],
      copied: [{ id: 'p', name: 'stud', kind: 'document' }, { id: 'q', name: 'bolt', kind: 'document' }],
    })).toBe('Moved frame to Shop. stud and bolt are still used here, so they were copied. 2 files went along.')
  })
})
