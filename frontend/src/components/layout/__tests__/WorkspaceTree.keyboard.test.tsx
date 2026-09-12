import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import type { EntryMeta, WorkspaceEntry } from '@/workspace/types'
import type { WorkspaceSession } from '@/workspace/session'

const storeMock = vi.hoisted(() => ({
  addEntry: vi.fn(async (_workspace: string, _entry: WorkspaceEntry) => 'new-id'),
  renameEntry: vi.fn(async () => {}),
  cloneEntry: vi.fn(async () => 'clone-id'),
  removeEntry: vi.fn(async () => {}),
}))
vi.mock('@/workspace/store', () => ({ getWorkspaceStore: () => storeMock }))

import { WorkspaceTree } from '@/components/layout/WorkspaceTree'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'

const entries: EntryMeta[] = [
  { id: 'p1', path: 'documents/Bracket.yaml', kind: 'document', name: 'Bracket', docKind: 'part', rev: 1 },
  { id: 'a1', path: 'documents/Gearbox.yaml', kind: 'document', name: 'Gearbox', docKind: 'assembly', rev: 1 },
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

function renderKeyboard() {
  return render(
    <MemoryRouter initialEntries={['/workspaces/ws']}>
      <Routes>
        <Route path="/workspaces/:workspaceId" element={<WorkspaceTree />} />
        <Route path="/workspaces/:workspaceId/entries/:entryId" element={<div>ENTRY</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  useWorkspaceSessionStore.setState({ session: null })
  installSession()
})

describe('WorkspaceTree keyboard reachability', () => {
  it('exposes the groups as listboxes and the rows as tabbable options', async () => {
    const { container } = renderKeyboard()
    await screen.findByText('Bracket')
    expect(container.querySelectorAll('[role="listbox"]')).toHaveLength(2)
    const options = container.querySelectorAll('[role="option"]')
    expect(options).toHaveLength(2)
    for (const option of options) expect(option.getAttribute('tabindex')).toBe('0')
  })

  it('opens the entry on Enter', async () => {
    renderKeyboard()
    await screen.findByText('Bracket')
    const row = screen.getByText('Bracket').closest('[role="option"]') as HTMLElement
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(await screen.findByText('ENTRY')).toBeInTheDocument()
  })

  it('opens the entry on Space', async () => {
    renderKeyboard()
    await screen.findByText('Gearbox')
    const row = screen.getByText('Gearbox').closest('[role="option"]') as HTMLElement
    fireEvent.keyDown(row, { key: ' ' })
    expect(await screen.findByText('ENTRY')).toBeInTheDocument()
  })

  // A key that bubbles out of a row control must not activate the row.
  it('ignores a key event bubbling from a control inside the row', async () => {
    renderKeyboard()
    await screen.findByText('Bracket')
    fireEvent.keyDown(screen.getByLabelText('Rename Bracket'), { key: 'Enter' })
    expect(screen.queryByText('ENTRY')).not.toBeInTheDocument()
  })
})
