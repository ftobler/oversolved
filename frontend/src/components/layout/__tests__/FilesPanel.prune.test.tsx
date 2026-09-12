import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { EntryMeta } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

const storeMock = vi.hoisted(() => ({
  removeEntry: vi.fn(async (_workspace: string, _entry: string) => {}),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

import { FilesPanel } from '@/components/layout/FilesPanel'
import { EntryReferencedError } from '@/workspace/errors'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'

const entries: EntryMeta[] = [
  { id: 'f2', path: 'files/old.step', kind: 'file', name: 'old.step', fileKind: 'step', mime: 'application/step', size: 4096, rev: 1 },
]

function installSession() {
  useWorkspaceSessionStore.setState({
    session: {
      workspace: 'ws',
      open: vi.fn(),
      listEntries: vi.fn(async () => entries),
      savedRevs: vi.fn(async () => new Map<string, number>()),
      readEntry: vi.fn(),
      writeEntry: vi.fn(),
      originOf: vi.fn(async () => undefined),
      resolveFile: vi.fn(),
      referencesOf: vi.fn(async () => []),
      referenceEdges: vi.fn(async () => ({})),
    } as unknown as WorkspaceSession,
  })
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  storeMock.removeEntry.mockClear()
  installSession()
})

describe('FilesPanel prune', () => {
  it('never prunes on mount or render', async () => {
    render(<FilesPanel />)
    await screen.findByText('old.step')
    expect(storeMock.removeEntry).not.toHaveBeenCalled()
  })

  it('asks first, names the orphans and states the in-memory undo consequence', async () => {
    render(<FilesPanel />)
    await screen.findByText('old.step')
    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    expect(screen.getByText('Prune Orphans')).toBeInTheDocument()
    expect(screen.getAllByText(/old\.step/).length).toBeGreaterThan(1)
    expect(screen.getByText(/in-memory history/)).toBeInTheDocument()
    expect(storeMock.removeEntry).not.toHaveBeenCalled()
  })

  it('confirm calls removeEntry per orphan', async () => {
    render(<FilesPanel />)
    await screen.findByText('old.step')
    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }))
    await waitFor(() => expect(storeMock.removeEntry).toHaveBeenCalledWith('ws', 'f2'))
  })

  it('cancel does not prune', async () => {
    render(<FilesPanel />)
    await screen.findByText('old.step')
    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(storeMock.removeEntry).not.toHaveBeenCalled()
    expect(screen.queryByText('Prune Orphans')).not.toBeInTheDocument()
  })

  it('surfaces a store refusal as a Cannot Prune dialog naming the referrer', async () => {
    storeMock.removeEntry.mockRejectedValueOnce(new EntryReferencedError('f2', [{ id: 'd1', name: 'Bracket' }]))
    render(<FilesPanel />)
    await screen.findByText('old.step')
    fireEvent.click(await screen.findByLabelText('Prune orphans'))
    fireEvent.click(screen.getByRole('button', { name: 'Prune' }))
    // A race made the orphan referenced between scan and delete: the guard
    // refuses and prune surfaces it instead of deleting.
    expect(await screen.findByText('Cannot Prune')).toBeInTheDocument()
    expect(screen.getByText(/still referenced and was not pruned/)).toBeInTheDocument()
    expect(screen.getByText('Bracket')).toBeInTheDocument()
    expect(screen.queryByText('Prune Orphans')).not.toBeInTheDocument()
  })
})
