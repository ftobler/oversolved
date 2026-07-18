import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

// The picker reads both document domains and the auth session; all three are
// mutable test fixtures so each case can shape the world it needs.
const h = vi.hoisted(() => ({
  localList: vi.fn(),
  cloudList: vi.fn(),
  bundle: {
    documents: { list: (...args: unknown[]) => h.localList(...args), thumbnailUrl: () => null },
    cloudDocuments: null as null | { list: (...args: unknown[]) => unknown; thumbnailUrl: () => null },
  },
  auth: { user: null as null | { username: string }, online: true },
}))

vi.mock('@/adapters/backend', () => ({ backendBundle: h.bundle }))
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => h.auth }))

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

const cloudStore = () => ({ list: (...args: unknown[]) => h.cloudList(...args), thumbnailUrl: () => null })

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
    h.bundle.cloudDocuments = null
    h.auth.user = null
    h.auth.online = true
    h.localList.mockResolvedValue([doc('part-1', 'Bracket', 5), doc('part-2', 'Bolt', 2)])
    h.cloudList.mockResolvedValue([])
  })

  it('lists the local library as preview tiles, excluding the assembly itself', async () => {
    h.localList.mockResolvedValue([doc('part-1', 'Bracket', 5), doc('asm-1', 'The Assembly')])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    expect(screen.queryByText('The Assembly')).not.toBeInTheDocument()
    // Tiles carry a preview slot (thumbnail or placeholder), like the documents grid.
    expect(document.querySelector('.doc-tile-preview')).toBeInTheDocument()
    expect(h.localList).toHaveBeenCalledWith({ sort: 'name', filter: 'owned', search: '' })
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
      expect(h.localList).toHaveBeenCalledWith({ sort: 'name', filter: 'owned', search: 'bra' }))
  })

  it('offers only the local category as a guest', async () => {
    h.bundle.cloudDocuments = cloudStore()  // server exists, but no session
    renderPicker()
    await waitFor(() => expect(screen.getByText('Local Documents')).toBeInTheDocument())
    expect(screen.queryByText('My Documents')).not.toBeInTheDocument()
    expect(screen.queryByText('Public Documents')).not.toBeInTheDocument()
  })

  it('offers the cloud categories when signed in and online, but never trash', async () => {
    h.bundle.cloudDocuments = cloudStore()
    h.auth.user = { username: 'flo' }
    renderPicker()
    await waitFor(() => expect(screen.getByText('My Documents')).toBeInTheDocument())
    expect(screen.getByText('Shared with me')).toBeInTheDocument()
    expect(screen.getByText('Public Documents')).toBeInTheDocument()
    expect(screen.queryByText(/Trash/)).not.toBeInTheDocument()
  })

  it('lists a cloud category from the cloud store with its filter', async () => {
    h.bundle.cloudDocuments = cloudStore()
    h.auth.user = { username: 'flo' }
    h.cloudList.mockResolvedValue([doc('pub-1', 'Public Gear')])
    const props = renderPicker()
    await waitFor(() => expect(screen.getByText('Public Documents')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Public Documents'))
    await waitFor(() => expect(screen.getByText('Public Gear')).toBeInTheDocument())
    expect(h.cloudList).toHaveBeenCalledWith({ sort: 'name', filter: 'public', search: '' })
    // A cloud summary has no sync meta; its rev defaults to 0.
    fireEvent.dblClick(screen.getByText('Public Gear'))
    expect(props.onPick).toHaveBeenCalledWith('pub-1', 0)
  })

  it('drops a selection that a category switch removed from view', async () => {
    h.bundle.cloudDocuments = cloudStore()
    h.auth.user = { username: 'flo' }
    h.cloudList.mockResolvedValue([])
    renderPicker()
    await waitFor(() => expect(screen.getByText('Bracket')).toBeInTheDocument())
    fireEvent.click(screen.getByText('Bracket'))
    expect(screen.getByRole('button', { name: 'Insert' })).toBeEnabled()
    fireEvent.click(screen.getByText('My Documents'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Insert' })).toBeDisabled())
  })
})
