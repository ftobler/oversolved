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
      if (url.startsWith('/api/admin/periodic-tasks/')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'updated' }),
        } as Response)
      }
      return Promise.resolve({ ok: false, status: 404 } as Response)
    })
  }

  it('renders periodic tasks page for admin', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        id: 1,
        name: 'Empty Trash',
        task_key: 'document.empty_trash',
        description: 'Clean up old docs',
        schedule: '0 2 * * *',
        enabled: true,
        last_run_at: null,
        last_run_duration_ms: null,
        last_run_status: null,
        last_run_error: null,
        next_run_at: '2024-05-01T02:00:00Z',
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
      expect(screen.getByText('Periodic Tasks')).toBeInTheDocument()
    })

    await waitFor(() => {
      expect(screen.getByText('Empty Trash')).toBeInTheDocument()
    })

    expect(screen.getByText('Daily at 2:00 AM')).toBeInTheDocument()
  })

  it('shows task status indicators', async () => {
    vi.stubGlobal('fetch', mockFetch([
      {
        id: 1,
        name: 'Empty Trash',
        task_key: 'document.empty_trash',
        description: 'Clean up old docs',
        schedule: '0 2 * * *',
        enabled: true,
        last_run_at: '2024-04-28T02:00:00Z',
        last_run_duration_ms: 1500,
        last_run_status: 'success',
        last_run_error: null,
        next_run_at: '2024-04-29T02:00:00Z',
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
      expect(screen.getByText('Empty Trash')).toBeInTheDocument()
    })

    expect(screen.getByText('success')).toBeInTheDocument()
  })

  it('toggle button disables task', async () => {
    const fetchMock = mockFetch([
      {
        id: 1,
        name: 'Empty Trash',
        task_key: 'document.empty_trash',
        description: 'Clean up old docs',
        schedule: '0 2 * * *',
        enabled: true,
        last_run_at: null,
        last_run_duration_ms: null,
        last_run_status: null,
        last_run_error: null,
        next_run_at: '2024-05-01T02:00:00Z',
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
      expect(screen.getByText('Empty Trash')).toBeInTheDocument()
    })

    const toggleBtn = screen.getByTitle('Disable task')
    fireEvent.click(toggleBtn)

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/admin/periodic-tasks/document.empty_trash',
        expect.objectContaining({
          method: 'PATCH',
          body: JSON.stringify({ enabled: false }),
        })
      )
    })
  })

  it('run now button triggers task execution', async () => {
    const fetchMock = mockFetch([
      {
        id: 1,
        name: 'Empty Trash',
        task_key: 'document.empty_trash',
        description: 'Clean up old docs',
        schedule: '0 2 * * *',
        enabled: true,
        last_run_at: null,
        last_run_duration_ms: null,
        last_run_status: null,
        last_run_error: null,
        next_run_at: '2024-05-01T02:00:00Z',
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
      expect(screen.getByText('Empty Trash')).toBeInTheDocument()
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
