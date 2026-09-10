import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The picker browses the one document library through the bundle, so the store
// is the only fixture a case has to shape.
const h = vi.hoisted(() => ({
  list: vi.fn(),
  bundle: {
    documents: { list: (...args: unknown[]) => h.list(...args), thumbnailUrl: () => null },
  },
}))

vi.mock('@/adapters/backend', () => ({ backendBundle: h.bundle }))

import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'

const doc = (uuid: string, name: string, rev?: number) => ({
  uuid,
  name,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-02T00:00:00Z',
  is_owner: true,
  owner_username: 'me',
  is_public: false,
  ...(rev !== undefined ? { meta: { id: uuid, rev, updatedAt: 0, dirty: false } } : {}),
})

function renderPicker(overrides: Partial<Parameters<typeof AssemblyPartPicker>[0]> = {}) {
  const props = {
    isOpen: true,
    selfUuid: 'asm-1',
    onClose: vi.fn(),
    onPick: vi.fn(),
    ...overrides,
  }
  render(<AssemblyPartPicker {...props} />)
  return props
}

describe('AssemblyPartPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.list.mockResolvedValue([doc('part-1', 'Bracket', 5), doc('part-2', 'Bolt', 2)])
  })

  it('lists the local library as preview tiles, excluding the assembly itself', async () => {
    h.list.mockResolvedValue([doc('part-1', 'Bracket', 5), doc('asm-1', 'The Assembly')])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(screen.queryByText('The Assembly')).not.toBeInTheDocument()
    // Tiles carry a preview slot (thumbnail or placeholder), like the documents grid.
    expect(document.querySelector('.doc-tile-preview')).toBeInTheDocument()
    expect(h.list).toHaveBeenCalledWith({ sort: 'name', search: '' })
  })

  // An assembly is not an insert source: instancing one yields a tree row with
  // no geometry and no message. The picker filters on the summary's kind, and a
  // legacy summary with no kind stays insertable (the safe default).
  it('shows only parts, never assemblies', async () => {
    h.list.mockResolvedValue([
      { ...doc('part-1', 'Bracket', 5), kind: 'part' },
      { ...doc('asm-2', 'Other Assembly', 1), kind: 'assembly' },
    ])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(screen.queryByText('Other Assembly')).not.toBeInTheDocument()
    // The only visible tile is the part, so the Insert button cannot target the
    // assembly.
    expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled()
  })

  it('shows the parts empty state when the filter leaves no tiles', async () => {
    h.list.mockResolvedValue([{ ...doc('asm-2', 'Other Assembly', 1), kind: 'assembly' }])
    renderPicker()
    await waitFor(() => expect(screen.getByText('No parts available.')).toBeInTheDocument())
    expect(screen.queryByText('Other Assembly')).not.toBeInTheDocument()
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

  it('confirms the selected doc with its uuid and rev', async () => {
    const props = renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    const insert = screen.getByRole('button', { name: 'Insert' })
    expect(insert).toBeDisabled()  // nothing selected yet
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

  it('forwards the search text to the store after the debounce', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bra' } })
    await waitFor(() =>
      expect(h.list).toHaveBeenCalledWith({ sort: 'name', search: 'bra' }))
  })

  // A selection must never outlive its tile: Insert confirms by id, so a doc the
  // user can no longer see would otherwise still be insertable.
  it('drops a selection that a search narrowed out of view', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Bracket'))
    expect(screen.getByRole('button', { name: 'Insert' })).toBeEnabled()

    h.list.mockResolvedValue([doc('part-2', 'Bolt', 2)])
    fireEvent.change(screen.getByPlaceholderText('Search documents...'), { target: { value: 'bolt' } })
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled())
  })

  // There is one library, so the dialog is a search box over a grid: a sidebar
  // with a single entry would be navigation to nowhere.
  it('has no category sidebar', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(document.querySelector('.doc-browser-sidebar')).toBeNull()
    expect(document.querySelector('.sidebar-item')).toBeNull()
  })
})
