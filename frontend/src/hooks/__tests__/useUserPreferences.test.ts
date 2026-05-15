import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useUserPreferences } from '../useUserPreferences'

describe('useUserPreferences', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('loads preferences on mount and defaults to alphabetical', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ document_sort: 'alphabetical' }),
      } as Response)
    ))

    const { result } = renderHook(() => useUserPreferences())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preferences.document_sort).toBe('alphabetical')
  })

  it('loads custom preference from server', async () => {
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
      } as Response)
    ))

    const { result } = renderHook(() => useUserPreferences())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preferences.document_sort).toBe('date_newest_first')
  })

  it('falls back to alphabetical on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false } as Response)))

    const { result } = renderHook(() => useUserPreferences())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preferences.document_sort).toBe('alphabetical')
  })

  it('updatePreference calls PUT and updates local state', async () => {
    const mockFetch = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('{}'),
        } as Response)
      }
      if (url === '/api/users/me/preferences') {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ document_sort: 'alphabetical' }),
          text: () => Promise.resolve(JSON.stringify({ document_sort: 'alphabetical' })),
        } as Response)
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useUserPreferences())
    await waitFor(() => expect(result.current.loading).toBe(false))

    await act(async () => {
      await result.current.updatePreference('document_sort', 'date_oldest_first')
    })

    expect(result.current.preferences.document_sort).toBe('date_oldest_first')
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/users/me/preferences',
      expect.objectContaining({ method: 'PUT' })
    )
  })
})
