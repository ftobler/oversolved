import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react'
import ShareDialog from '@/components/dialogs/ShareDialog'

describe('ShareDialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('renders with correct title', async () => {
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
    await act(async () => {})
    expect(screen.getByText('Share "TestUser/TestDoc"')).toBeInTheDocument()
  })

  it('renders nothing when closed', async () => {
    // The shell owns the isOpen guard now; the dialog itself no longer has one.
    const { container } = render(
      <ShareDialog
        isOpen={false}
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner
        onClose={vi.fn()}
      />
    )
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  // The dialog used to carry a hand-rolled overlay, header and close button. It
  // must keep using the shared shell so its chrome cannot drift again.
  it('renders in the shared dialog shell with a topic icon', async () => {
    const onClose = vi.fn()
    const { container } = render(
      <ShareDialog
        isOpen
        documentUuid="doc-1"
        documentName="TestDoc"
        ownerUsername="TestUser"
        isOwner
        onClose={onClose}
      />
    )
    await act(async () => {})

    expect(container.querySelector('.dialog-component.share-dialog')).toBeInTheDocument()
    expect(container.querySelector('.dialog-component-icon')).toHaveTextContent('share')

    fireEvent.click(screen.getByRole('button', { name: /close/i }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('shows non-owner message when isOwner is false', async () => {
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
    await act(async () => {})
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

  // A proxy/load balancer can return an HTML error page instead of the app's
  // JSON error format; JSON.parse on that body must not throw out of the
  // catch block itself (that would surface as an unhandled rejection instead
  // of the fallback error text this test asserts).
  it('shows a fallback error message when the share request fails with a non-JSON body', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/documents/doc-1/shares') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ shares: [] }),
        } as Response)
      }
      if (url === '/api/documents/doc-1/share' && options?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 502,
          text: () => Promise.resolve('<html>Bad Gateway</html>'),
        } as unknown as Response)
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

    fireEvent.change(screen.getByPlaceholderText('Username'), { target: { value: 'otheruser' } })
    fireEvent.click(screen.getByText('Share'))

    await waitFor(() => {
      expect(screen.getByText('Failed to share')).toBeInTheDocument()
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

  it('refuses to remove a user row with a null username and shows an error instead', async () => {
    // The table filters on shared_with_user_id, not username, so a malformed
    // user-row carrying a null username still renders a remove button. The
    // adapter contract treats a falsy username as "revoke the LINK share",
    // so dispatching that row would revoke document-wide sharing; it must
    // surface an error and hit the API zero times instead.
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/documents/doc-1/shares') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            shares: [
              { id: 1, username: null, permission: 'view', shared_with_user_id: 3 },
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
      expect(screen.getByTitle('Remove share')).toBeInTheDocument()
    })

    fireEvent.click(screen.getByTitle('Remove share'))

    const unshareCalls = fetchMock.mock.calls.filter(
      ([url]) => url === '/api/documents/doc-1/share',
    )
    expect(unshareCalls).toHaveLength(0)
    expect(await screen.findByText('Malformed share row: no username')).toBeInTheDocument()
  })
})
