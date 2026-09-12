import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'

// The picker browses the OPEN WORKSPACE session only, so the session is the
// only fixture a case has to shape: a doc in another workspace is unreachable
// by construction.
const h = vi.hoisted(() => ({ listEntries: vi.fn() }))

vi.mock('@/stores/previewStore', () => ({ usePreview: () => undefined }))

import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'

const entry = (id: string, name: string, rev?: number, docKind: string | undefined = 'part'): EntryMeta => ({
  id,
  path: `documents/${name}.yaml`,
  kind: 'document',
  name,
  docKind,
  ...(rev !== undefined ? { rev, updatedAt: 0 } : {}),
})

function session(): WorkspaceSession {
  return {
    workspace: 'ws-1',
    open: vi.fn(),
    listEntries: (...args: unknown[]) => h.listEntries(...args),
    readEntry: vi.fn(),
    writeEntry: vi.fn(),
    resolveFile: vi.fn(),
    referencesOf: vi.fn(),
  } as unknown as WorkspaceSession
}

function renderPicker(overrides: Partial<ComponentProps<typeof AssemblyPartPicker>> = {}) {
  const props: ComponentProps<typeof AssemblyPartPicker> = {
    isOpen: true,
    selfUuid: 'asm-1',
    session: session(),
    onClose: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  }
  render(<AssemblyPartPicker {...props} />)
  return props
}

describe('AssemblyPartPicker (workspace scoped)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.listEntries.mockResolvedValue([entry('part-1', 'Bracket', 5), entry('part-2', 'Bolt', 2)])
  })

  it('lists the open workspace as preview tiles, excluding the assembly itself', async () => {
    h.listEntries.mockResolvedValue([entry('part-1', 'Bracket', 5), entry('asm-1', 'The Assembly')])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(screen.queryByText('The Assembly')).not.toBeInTheDocument()
    expect(document.querySelector('.doc-tile-preview')).toBeInTheDocument()
    expect(h.listEntries).toHaveBeenCalled()
  })

  it('shows only parts, never assemblies', async () => {
    h.listEntries.mockResolvedValue([
      entry('part-1', 'Bracket', 5, 'part'),
      entry('asm-2', 'Other Assembly', 1, 'assembly'),
    ])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(screen.queryByText('Other Assembly')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
  })

  it('shows the parts empty state when the filter leaves no tiles', async () => {
    h.listEntries.mockResolvedValue([entry('asm-2', 'Other Assembly', 1, 'assembly')])
    renderPicker()
    await waitFor(() => expect(screen.getByText('No parts available.')).toBeInTheDocument())
    expect(screen.queryByText('Other Assembly')).not.toBeInTheDocument()
  })

  // I6: an unknown kind is refused, never treated as an insertable part.
  it('excludes a document with an unknown kind', async () => {
    h.listEntries.mockResolvedValue([entry('weird', 'Draft', 1, 'drawing')])
    renderPicker()
    await waitFor(() => expect(screen.getByText('No parts available.')).toBeInTheDocument())
    expect(screen.queryByText('Draft')).not.toBeInTheDocument()
  })

  it('shows no workspace at all when the session is absent', async () => {
    renderPicker({ session: null })
    await waitFor(() => expect(h.listEntries).not.toHaveBeenCalled())
    expect(screen.getByText('No parts available.')).toBeInTheDocument()
  })

  it('titles itself with an icon, like every other dialog on the shell', () => {
    renderPicker()
    expect(document.querySelector('.dialog-component-icon')).toHaveTextContent('library_add')
  })

  it('shows no tile action buttons (browse and pick only)', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(document.querySelector('.btn-tile-action')).toBeNull()
    expect(document.querySelector('.btn-delete-tile')).toBeNull()
  })

  it('confirms the selected doc with its id and rev', async () => {
    const props = renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    const insert = screen.getByRole('button', { name: 'Insert' })
    expect(insert).toBeDisabled()
    fireEvent.click(screen.getByText('Bracket'))
    fireEvent.click(insert)
    expect(props.onPick).toHaveBeenCalledWith('part-1', 5)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('inserts directly on tile double-click', async () => {
    const props = renderPicker()
    await waitFor(() => expect(screen.getByText('Bolt')).toBeInTheDocument())
    fireEvent.dblClick(screen.getByText('Bolt'))
    expect(props.onPick).toHaveBeenCalledWith('part-2', 2)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('filters tiles by the search text', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bol' } })
    await waitFor(() => expect(screen.queryByText('Bracket')).not.toBeInTheDocument())
    expect(screen.getByText('Bolt')).toBeInTheDocument()
  })

  // A selection must never outlive its tile: Insert confirms by id, so a doc the
  // user can no longer see would otherwise still be insertable.
  it('drops a selection that a search narrowed out of view', async () => {
    h.listEntries.mockResolvedValue([entry('part-1', 'Bracket', 5), entry('part-2', 'Bolt', 2)])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Bracket'))
    expect(screen.getByRole('button', { name: 'Insert' })).toBeEnabled()

    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bolt' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled())
  })

  it('has no category sidebar', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(document.querySelector('.doc-browser-sidebar')).toBeNull()
    expect(document.querySelector('.sidebar-item')).toBeNull()
  })
})
