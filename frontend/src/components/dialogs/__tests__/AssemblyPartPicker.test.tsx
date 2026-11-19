import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { ComponentProps } from 'react'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'

// The picker browses the OPEN WORKSPACE only, but it does not fetch: the rows
// are the editor's one list, the same rows the add_part guard checks. These
// cases therefore shape `entries` directly, which is exactly what the page
// hands over.
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
    entries: [entry('part-1', 'Bracket', 5), entry('part-2', 'Bolt', 2)],
    refreshing: false,
    onRefresh: vi.fn(),
    onClose: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  }
  render(<AssemblyPartPicker {...props} />)
  return { props }
}

describe('AssemblyPartPicker (workspace scoped)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  // The fetch belongs to the editor, so opening the dialog is what freshens the
  // tiles and the guard together: a part added since mount is listed and legal.
  it('asks the editor for a fresh list when it opens', () => {
    const { props } = renderPicker()
    expect(props.onRefresh).toHaveBeenCalledTimes(1)
  })

  it('does not refresh while it is closed', () => {
    const { props } = renderPicker({ isOpen: false })
    expect(props.onRefresh).not.toHaveBeenCalled()
  })

  it('lists the rows it is handed as preview tiles, excluding the assembly itself', () => {
    renderPicker({ entries: [entry('part-1', 'Bracket', 5), entry('asm-1', 'The Assembly')] })
    expect(screen.getByText('Bracket')).toBeInTheDocument()
    expect(screen.queryByText('The Assembly')).not.toBeInTheDocument()
    expect(document.querySelector('.doc-tile-preview')).toBeInTheDocument()
  })

  it('lists parts and assemblies in their own groups', () => {
    renderPicker({
      entries: [entry('part-1', 'Bracket', 5, 'part'), entry('asm-2', 'Other Assembly', 1, 'assembly')],
    })
    expect(screen.getByLabelText('Parts')).toBeInTheDocument()
    expect(screen.getByLabelText('Assemblies')).toBeInTheDocument()
    expect(screen.getByText('Other Assembly')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
  })

  it('keeps an assembly tile pickable when no cycle forbids it', () => {
    renderPicker({ entries: [entry('asm-2', 'Other Assembly', 1, 'assembly')] })
    fireEvent.click(screen.getByText('Other Assembly'))
    expect(screen.getByRole('button', { name: 'Insert' })).toBeEnabled()
  })

  // I6: an unknown kind is refused, never treated as an insertable part.
  it('excludes a document with an unknown kind', () => {
    renderPicker({ entries: [entry('weird', 'Draft', 1, 'drawing')] })
    expect(screen.getByText('No parts or assemblies available.')).toBeInTheDocument()
    expect(screen.queryByText('Draft')).not.toBeInTheDocument()
  })

  it('shows the empty state when the editor holds no list and no workspace is bound', () => {
    renderPicker({ session: null, entries: null })
    expect(screen.getByText('No parts or assemblies available.')).toBeInTheDocument()
  })

  // A list that never lands must not leave the dialog spinning with no reason:
  // that is the same "the button did nothing" shape the insert path was fixed for.
  it('shows a failed list read instead of a spinner', () => {
    renderPicker({ entries: null, listError: 'Failed to list workspace documents: blocked' })
    expect(screen.getByText('Failed to list workspace documents: blocked')).toBeInTheDocument()
  })

  // The refresh an open starts is a pending answer: the previous rows are held
  // back (no tile, no confirm) until it lands, so a part deleted since the last
  // read cannot be inserted from the stale list.
  it('holds the previous rows back while a read is in flight', () => {
    renderPicker({ refreshing: true })
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    expect(screen.queryByText('Bracket')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
  })

  // A failed retry keeps the last good rows on screen, but they are not
  // confirmable: the list that vouches for them is exactly what failed.
  it('shows a failed read above the still-visible rows and refuses to confirm', () => {
    renderPicker({ listError: 'Failed to list workspace documents: blocked' })
    expect(screen.getByText('Failed to list workspace documents: blocked')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Bracket'))
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
  })

  it('titles itself with an icon, like every other dialog on the shell', () => {
    renderPicker()
    expect(document.querySelector('.dialog-component-icon')).toHaveTextContent('library_add')
  })

  it('shows no tile action buttons (browse and pick only)', () => {
    renderPicker()
    expect(document.querySelector('.btn-tile-action')).toBeNull()
    expect(document.querySelector('.btn-delete-tile')).toBeNull()
  })

  it('confirms the selected doc with its id and rev', () => {
    const { props } = renderPicker()
    const insert = screen.getByRole('button', { name: 'Insert' })
    expect(insert).toBeDisabled()
    fireEvent.click(screen.getByText('Bracket'))
    fireEvent.click(insert)
    expect(props.onPick).toHaveBeenCalledWith('part-1', 5)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('inserts directly on tile double-click', () => {
    const { props } = renderPicker()
    fireEvent.dblClick(screen.getByText('Bolt'))
    expect(props.onPick).toHaveBeenCalledWith('part-2', 2)
    expect(props.onClose).toHaveBeenCalled()
  })

  it('filters tiles by the search text', async () => {
    renderPicker()
    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bol' } })
    await waitFor(() => expect(screen.queryByText('Bracket')).not.toBeInTheDocument())
    expect(screen.getByText('Bolt')).toBeInTheDocument()
  })

  // A selection must never outlive its tile: Insert confirms by id, so a doc the
  // user can no longer see would otherwise still be insertable. The id is kept,
  // so clearing the search restores the same pick rather than dropping it.
  it('refuses to confirm a selection the search narrowed out of view, then restores it', async () => {
    const { props } = renderPicker()
    const insert = screen.getByRole('button', { name: 'Insert' })
    fireEvent.click(screen.getByText('Bracket'))
    expect(insert).toBeEnabled()

    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bolt' } })
    await waitFor(() => expect(insert).toBeDisabled())

    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: '' } })
    await waitFor(() => expect(insert).toBeEnabled())
    fireEvent.click(insert)
    expect(props.onPick).toHaveBeenCalledWith('part-1', 5)
  })

  // The debounce re-renders the grid after the click that selected a tile; the
  // selection must survive that and still be the value Insert confirms.
  it('confirms the selected id after the search debounce tick', async () => {
    const { props } = renderPicker()
    fireEvent.click(screen.getByText('Bracket'))
    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bra' } })
    await waitFor(() => expect(screen.queryByText('Bolt')).not.toBeInTheDocument(), { timeout: 1000 })
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(props.onPick).toHaveBeenCalledWith('part-1', 5)
  })

  it('has no category sidebar', () => {
    renderPicker()
    expect(document.querySelector('.doc-browser-sidebar')).toBeNull()
    expect(document.querySelector('.sidebar-item')).toBeNull()
  })
})
