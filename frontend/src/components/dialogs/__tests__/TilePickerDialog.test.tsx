import { describe, it, expect, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { ComponentProps } from 'react'

vi.mock('@/hooks/usePreview', () => ({ usePreview: () => undefined }))

import TilePickerDialog, { type TilePickerItem } from '@/components/dialogs/TilePickerDialog'
import WorkspacePickerDialog from '@/components/dialogs/WorkspacePickerDialog'
import type { WorkspaceSummary } from '@/workspace/store'

const item = (id: string, name: string, group: string, extra: Partial<TilePickerItem> = {}): TilePickerItem => ({
  id, name, group, preview: { workspace: 'ws', entry: id }, updatedAt: 0, ...extra,
})

function renderTiles(overrides: Partial<ComponentProps<typeof TilePickerDialog>> = {}) {
  const props: ComponentProps<typeof TilePickerDialog> = {
    isOpen: true,
    title: 'Pick one',
    icon: 'library_add',
    confirmLabel: 'Take',
    searchPlaceholder: 'Search things...',
    emptyText: 'Nothing here.',
    itemNoun: 'things',
    items: [item('a', 'Apple', 'fruit'), item('c', 'Carrot', 'veg'), item('b', 'Banana', 'fruit')],
    groups: [{ key: 'veg', label: 'Vegetables' }, { key: 'fruit', label: 'Fruit', icon: 'eco' }],
    loading: false,
    onClose: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  }
  render(<TilePickerDialog {...props} />)
  return props
}

const confirmButton = (label: string) => screen.getByRole('button', { name: label })

describe('TilePickerDialog', () => {
  it('renders the items under their group headings, in the groups order', () => {
    renderTiles()
    const headings = screen.getAllByRole('heading', { level: 3 }).map(h => h.textContent)
    expect(headings).toEqual(['Vegetables', 'ecoFruit'])
    expect(screen.getByLabelText('Fruit')).toHaveTextContent('Apple')
    expect(screen.getByLabelText('Fruit')).toHaveTextContent('Banana')
    expect(screen.getByLabelText('Vegetables')).toHaveTextContent('Carrot')
  })

  it('filters by the search text after the debounce and names the items in the no-match line', () => {
    vi.useFakeTimers()
    try {
      renderTiles()
      fireEvent.change(screen.getByPlaceholderText('Search things...'), { target: { value: 'ban' } })
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('Banana')).toBeInTheDocument()
      expect(screen.queryByText('Apple')).not.toBeInTheDocument()
      expect(screen.queryByLabelText('Vegetables')).not.toBeInTheDocument()
      fireEvent.change(screen.getByPlaceholderText('Search things...'), { target: { value: 'zzz' } })
      act(() => { vi.advanceTimersByTime(300) })
      expect(screen.getByText('No things match "zzz"')).toBeInTheDocument()
    } finally {
      vi.useRealTimers()
    }
  })

  it('picks the selected item on confirm and on double-click', () => {
    const props = renderTiles()
    expect(confirmButton('Take')).toBeDisabled()
    fireEvent.click(screen.getByText('Carrot'))
    fireEvent.click(confirmButton('Take'))
    expect(props.onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }))
    fireEvent.doubleClick(screen.getByText('Apple'))
    expect(props.onPick).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }))
  })

  it('shows a notice without blocking the confirm, and a read error that blocks it', () => {
    const props = renderTiles({ notice: 'Not there.' })
    expect(screen.getByRole('alert')).toHaveTextContent('Not there.')
    fireEvent.click(screen.getByText('Apple'))
    expect(confirmButton('Take')).toBeEnabled()
    expect(props.onClose).not.toHaveBeenCalled()
  })

  it('keeps a disabled item listed with its reason and refuses to pick it', () => {
    const props = renderTiles({ items: [item('a', 'Apple', 'fruit', { disabledReason: 'Bruised' })] })
    const tile = screen.getByText('Apple').closest('button') as HTMLButtonElement
    expect(tile).toBeDisabled()
    expect(tile.title).toBe('Bruised')
    fireEvent.doubleClick(tile)
    expect(props.onPick).not.toHaveBeenCalled()
  })

  it('shows the empty text with no items', () => {
    renderTiles({ items: [] })
    expect(screen.getByText('Nothing here.')).toBeInTheDocument()
  })
})

const summary = (workspace: string, name: string, extra: Partial<WorkspaceSummary> = {}): WorkspaceSummary => ({
  workspace, name, entryCount: 1, size: 0, createdAt: 0, updatedAt: 0, ...extra,
})

describe('WorkspacePickerDialog', () => {
  it('lists every workspace but the current one and calls back with the picked id', () => {
    const onPick = vi.fn()
    render(
      <WorkspacePickerDialog
        isOpen
        currentWorkspace="here"
        workspaces={[
          summary('here', 'Bench'), summary('shop', 'Shop', { coverEntry: 'frame' }), summary('yard', 'Yard'),
          summary('old', 'Attic', { trashedAt: '2026-01-01T00:00:00Z' }),
        ]}
        onClose={vi.fn()}
        onPick={onPick}
      />,
    )
    expect(screen.getByText('Move to workspace')).toBeInTheDocument()
    expect(screen.queryByText('Bench')).not.toBeInTheDocument()
    expect(screen.queryByText('Attic')).not.toBeInTheDocument()
    expect(screen.getByLabelText('Workspaces')).toHaveTextContent('Shop')
    expect(screen.getByLabelText('Workspaces')).toHaveTextContent('Yard')
    fireEvent.click(screen.getByText('Yard'))
    fireEvent.click(screen.getByRole('button', { name: 'Move' }))
    expect(onPick).toHaveBeenCalledWith('yard')
  })

  it('says so when there is nowhere else to go, and spins while the list is out', () => {
    const { rerender } = render(
      <WorkspacePickerDialog isOpen currentWorkspace="here" workspaces={null} onClose={vi.fn()} onPick={vi.fn()} />,
    )
    expect(screen.getByText('Loading...')).toBeInTheDocument()
    rerender(
      <WorkspacePickerDialog isOpen currentWorkspace="here" workspaces={[summary('here', 'Bench')]} onClose={vi.fn()} onPick={vi.fn()} />,
    )
    expect(screen.getByText('There is no other workspace to move to.')).toBeInTheDocument()
  })
})
