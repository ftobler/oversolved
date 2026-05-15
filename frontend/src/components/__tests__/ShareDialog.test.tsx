import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import ShareDialog from '@/components/ShareDialog'

describe('ShareDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders with correct title', () => {
    render(
      <ShareDialog
        isOpen
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Share "TestUser/TestDoc"')).toBeInTheDocument()
  })

  it('shows non-owner message when isOwner is false', () => {
    render(
      <ShareDialog
        isOpen
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner={false}
        onClose={vi.fn()}
      />
    )
    expect(screen.getByText('Only the owner can manage shares.')).toBeInTheDocument()
  })

  it('creates share with username via API', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/documents/doc-1/shares') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ shares: [] }),
        } as Response)
      }
      if (url === '/api/documents/doc-1/share' && options?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'shared' }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ShareDialog
        isOpen
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByPlaceholderText('Username')).toBeInTheDocument()
    })

    const input = screen.getByPlaceholderText('Username')
    fireEvent.change(input, { target: { value: 'otheruser' } })

    const shareBtn = screen.getByText('Share')
    fireEvent.click(shareBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/documents/doc-1/share',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ username: 'otheruser', permission: 'view' }),
        })
      )
    })
  })

  it('displays existing shares with remove buttons', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/documents/doc-1/shares') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            shares: [
              { id: 1, username: 'otheruser', permission: 'view', shared_with_user_id: 2 },
            ],
          }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ShareDialog
        isOpen
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByText('otheruser')).toBeInTheDocument()
    })

    expect(screen.getByRole('combobox')).toHaveValue('view')
  })

  it('calls delete API when remove share button is clicked', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/documents/doc-1/shares') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            shares: [
              { id: 1, username: 'otheruser', permission: 'view', shared_with_user_id: 2 },
            ],
          }),
        } as Response)
      }
      if (url === '/api/documents/doc-1/share' && options?.method === 'DELETE') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'unshared' }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
    vi.stubGlobal('fetch', fetchMock)

    render(
      <ShareDialog
        isOpen
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner
        onClose={vi.fn()}
      />
    )

    await waitFor(() => {
      expect(screen.getByTitle('Remove share')).toBeInTheDocument()
    })

    const removeBtn = screen.getByTitle('Remove share')
    fireEvent.click(removeBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/documents/doc-1/share',
        expect.objectContaining({
          method: 'DELETE',
          body: JSON.stringify({ username: 'otheruser' }),
        })
      )
    })
  })
})
