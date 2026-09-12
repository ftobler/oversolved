import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

const storeMock = vi.hoisted(() => ({
  addEntry: vi.fn(async (_workspace: string, _entry: WorkspaceEntry) => 'new-id'),
  renameEntry: vi.fn(async (_workspace: string, _entry: string, _name: string) => {}),
  cloneEntry: vi.fn(async (_workspace: string, _entry: string) => 'clone-id'),
  removeEntry: vi.fn(async (_workspace: string, _entry: string) => {}),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

import { WorkspaceTree } from '@/components/layout/WorkspaceTree'
import { EntryReferencedError } from '@/workspace/errors'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

function meta(id: string, name: string, extra: Partial<EntryMeta>): EntryMeta {
  return { id, path: `documents/${name}.yaml`, kind: 'document', name, rev: 1, ...extra }
}

const entries: EntryMeta[] = [
  meta('p1', 'Bracket', { docKind: 'part' }),
  meta('a1', 'Gearbox', { docKind: 'assembly' }),
  meta('f1', 'shaft.step', { kind: 'file', mime: 'application/step', fileKind: 'step', size: 10 }),
  meta('gone', 'Retired', { docKind: 'part' }),
]

function installSession(
  all: EntryMeta[] = entries,
  trashed: string[] = ['gone'],
  edges: Record<string, string[]> = {},
  savedRevs = new Map<string, number>(),
): WorkspaceSession {
  const session = {
    workspace: 'ws',
    open: vi.fn(),
    listEntries: vi.fn(async (opts?: { includeTrashed?: boolean }) =>
      all.filter(entry => opts?.includeTrashed || !trashed.includes(entry.id))),
    savedRevs: vi.fn(async () => savedRevs),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    originOf: vi.fn(async () => undefined),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(async () => []),
    referenceEdges: vi.fn(async () => edges),
  }
  useWorkspaceSessionStore.setState({ session: session as unknown as WorkspaceSession })
  return session as unknown as WorkspaceSession
}

function renderTree(entryId = 'z') {
  return render(
    <MemoryRouter initialEntries={[`/workspaces/ws/entries/${entryId}`]}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<div>ROOT</div>} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<WorkspaceTree />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  useUnsavedChangesStore.getState().setDirty(false)
  useUnsavedChangesStore.getState().dismissConfirm()
  storeMock.addEntry.mockClear()
  storeMock.renameEntry.mockClear()
  storeMock.cloneEntry.mockClear()
  storeMock.removeEntry.mockClear()
})

describe('WorkspaceTree listing', () => {
  it('lists the session entries and excludes trashed ones', async () => {
    const session = installSession()
    const { container } = renderTree()
    await screen.findByText('Bracket')
    expect(session.listEntries).toHaveBeenCalledWith()
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(3)
    expect(screen.queryByText('Retired')).not.toBeInTheDocument()
    expect(screen.getByText('shaft.step')).toBeInTheDocument()
  })

  it('groups parts, assemblies and files under labelled listboxes', async () => {
    installSession()
    const { container } = renderTree()
    await screen.findByText('Bracket')
    const labels = [...container.querySelectorAll('[role="listbox"]')].map(list => list.getAttribute('aria-label'))
    expect(labels).toEqual(['Parts', 'Assemblies', 'Files'])
  })

  it('does not render a group with no entries', async () => {
    installSession([meta('p1', 'Bracket', { docKind: 'part' })])
    const { container } = renderTree()
    await screen.findByText('Bracket')
    expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(1)
  })

  it('marks the open entry', async () => {
    installSession()
    const { container } = renderTree('p1')
    await screen.findByText('Bracket')
    const rows = [...container.querySelectorAll('[role="option"]')]
    const open = rows.find(row => row.textContent?.includes('Bracket'))
    const other = rows.find(row => row.textContent?.includes('Gearbox'))
    expect(open?.getAttribute('aria-selected')).toBe('true')
    expect(other?.getAttribute('aria-selected')).toBe('false')
  })

  it('labels an entry with the names that use it', async () => {
    installSession(entries, ['gone'], { a1: ['p1'] })
    renderTree()
    await screen.findByText('Bracket')
    expect(await screen.findByText('used by Gearbox')).toBeInTheDocument()
  })
})

describe('WorkspaceTree mutations', () => {
  it('renames through the store verb', async () => {
    installSession()
    renderTree()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Rename Bracket'))
    const input = screen.getByDisplayValue('Bracket')
    fireEvent.change(input, { target: { value: 'Bracket A' } })
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    await waitFor(() => expect(storeMock.renameEntry).toHaveBeenCalledWith('ws', 'p1', 'Bracket A'))
  })

  it('duplicates through the store verb', async () => {
    installSession()
    renderTree()
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Duplicate Bracket'))
    await waitFor(() => expect(storeMock.cloneEntry).toHaveBeenCalledWith('ws', 'p1'))
  })

  it('deletes through the store verb and leaves the open entry', async () => {
    installSession()
    renderTree('p1')
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Delete Bracket'))
    await waitFor(() => expect(storeMock.removeEntry).toHaveBeenCalledWith('ws', 'p1'))
    expect(await screen.findByText('ROOT')).toBeInTheDocument()
  })

  it('presents the refusal with its referrers and stays put when a delete is blocked', async () => {
    installSession()
    storeMock.removeEntry.mockRejectedValueOnce(new EntryReferencedError('p1', [{ id: 'a1', name: 'Gearbox' }]))
    renderTree('p1')
    await screen.findByText('Bracket')
    fireEvent.click(screen.getByLabelText('Delete Bracket'))
    expect(await screen.findByText('Cannot Delete')).toBeInTheDocument()
    expect(screen.getByText(/Bracket is still referenced/)).toBeInTheDocument()
    // The refusal names the live referrer and offers it as a jump target.
    expect(screen.getByRole('button', { name: 'Gearbox' })).toBeInTheDocument()
    // The refusal waits for the store verdict; it must not navigate away first.
    expect(screen.queryByText('ROOT')).not.toBeInTheDocument()
  })
})

describe('WorkspaceTree unsaved-changes guard', () => {
  const openRow = (container: HTMLElement) =>
    [...container.querySelectorAll('[role="option"]')]
      .find(row => row.getAttribute('aria-selected') === 'true')

  it('holds navigation to another entry while the open entry is dirty', async () => {
    installSession()
    useUnsavedChangesStore.setState({ dirty: true, workspace: 'ws' })
    const { container } = renderTree('p1')
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByText('Gearbox'))

    // The discard prompt is armed and the navigation has not happened.
    expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull()
    expect(openRow(container)?.textContent).toContain('Bracket')

    // Confirming the discard clears the flag and navigates to the target.
    act(() => { useUnsavedChangesStore.getState().pendingCallback!() })
    await waitFor(() => expect(openRow(container)?.textContent).toContain('Gearbox'))
  })

  it('holds the add navigation while the open entry is dirty', async () => {
    installSession()
    useUnsavedChangesStore.setState({ dirty: true, workspace: 'ws' })
    const { container } = renderTree('p1')
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByLabelText('Add entry'))
    fireEvent.change(screen.getByPlaceholderText('Entry name'), { target: { value: 'New' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(useUnsavedChangesStore.getState().pendingCallback).not.toBeNull())
    expect(openRow(container)?.textContent).toContain('Bracket')
  })

  it('navigates immediately when the open entry is clean', async () => {
    installSession()
    const { container } = renderTree('p1')
    await screen.findByText('Bracket')

    fireEvent.click(screen.getByText('Gearbox'))

    expect(useUnsavedChangesStore.getState().pendingCallback).toBeNull()
    await waitFor(() => expect(openRow(container)?.textContent).toContain('Gearbox'))
  })
})

describe('WorkspaceTree dirty dot', () => {
  it("lights the open entry's dot from the header flag while every entry is saved", async () => {
    const savedRevs = new Map(entries.filter(e => e.id !== 'gone').map(e => [e.id, e.rev ?? 1]))
    installSession(entries, ['gone'], {}, savedRevs)
    useUnsavedChangesStore.setState({ dirty: true, workspace: 'ws' })
    const { container } = renderTree('p1')
    await screen.findByText('Bracket')

    const open = [...container.querySelectorAll('[role="option"]')]
      .find(row => row.getAttribute('aria-selected') === 'true')
    expect(open?.querySelector('.workspace-dirty-dot')).toBeInTheDocument()
    // The clean siblings stay dotless.
    const gearbox = [...container.querySelectorAll('[role="option"]')]
      .find(row => row.textContent?.includes('Gearbox'))
    expect(gearbox?.querySelector('.workspace-dirty-dot')).toBeNull()
  })
})
