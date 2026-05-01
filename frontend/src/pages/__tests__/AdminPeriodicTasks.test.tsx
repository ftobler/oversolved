import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { BrowserRouter } from 'react-router-dom'
import { AuthProvider } from '../../contexts/AuthContext'
import AdminPeriodicTasks from '../AdminPeriodicTasks'

describe('AdminPeriodicTasks', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  const mockFetch = (tasks: Record<string, unknown>[] = []) => {
    return vi.fn((url: string): Promise<Response> => {
      if (url === '/api/auth/me') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ user: { id: 1, username: 'admin', is_admin: true } }),
        } as Response)
      }
      if (url === '/api/admin/periodic-tasks') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tasks }),
        } as Response)
      }
      if (url.startsWith('/api/admin/periodic-tasks/') && url.endsWith('/run')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'success', duration_ms: 100 }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  it('renders periodic tasks page for admin', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        id: 1,
        task_key: 'document.empty_trash',
        last_run_at: null,
        last_run_status: null,
      },
    ]))

    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminPeriodicTasks />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('document.empty_trash')).toBeInTheDocument()
    })
  })

  it('shows task status indicators', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        id: 1,
        task_key: 'document.empty_trash',
        last_run_at: '2024-04-28T02:00:00Z',
        last_run_status: 'success',
      },
    ]))

    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminPeriodicTasks />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('document.empty_trash')).toBeInTheDocument()
    })

    expect(screen.getByText('success')).toBeInTheDocument()
  })

  it('run now button triggers task execution', async () => {
    const fetchMock = mockFetch([
      {
        id: 1,
        task_key: 'document.empty_trash',
        last_run_at: null,
        last_run_status: null,
      },
    ])
    vi.stubGlobal('fetch', fetchMock)

    render(
      <BrowserRouter>
        <AuthProvider>
          <AdminPeriodicTasks />
        </AuthProvider>
      </BrowserRouter>
    )

    await waitFor(() => {
      expect(screen.getByText('document.empty_trash')).toBeInTheDocument()
    })

    const runBtn = screen.getByTitle('Run now')
    fireEvent.click(runBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/periodic-tasks/document.empty_trash/run',
        expect.objectContaining({ method: 'POST' })
      )
    })
  })
})
