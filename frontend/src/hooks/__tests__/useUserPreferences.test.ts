import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { useUserPreferences } from '@/hooks/useUserPreferences'

describe('useUserPreferences', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('loads preferences on mount and defaults to date_newest_first', async () => {
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

  it('falls back to date_newest_first on fetch failure', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false } as Response)))

    const { result } = renderHook(() => useUserPreferences())

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preferences.document_sort).toBe('date_newest_first')
  })

  it('does not fetch cloud preferences for a guest (signedIn=false)', async () => {
    const mockFetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response))
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useUserPreferences(false))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(mockFetch).not.toHaveBeenCalled()
    expect(result.current.preferences.document_sort).toBe('date_newest_first')
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
          json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
          text: () => Promise.resolve(JSON.stringify({ document_sort: 'date_newest_first' })),
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

  it('a logout mid-fetch does not let the stale cloud load overwrite the now-guest preferences', async () => {
    let resolveFetch: ((res: Response) => void) | undefined
    const mockFetch = vi.fn(() => new Promise<Response>(resolve => { resolveFetch = resolve }))
    vi.stubGlobal('fetch', mockFetch)

    const { result, rerender } = renderHook(
      ({ signedIn }) => useUserPreferences(signedIn),
      { initialProps: { signedIn: true } }
    )
    expect(mockFetch).toHaveBeenCalledTimes(1)  // the cloud load fired while signed in

    // The user logs out before the fetch resolves; the page does not remount.
    rerender({ signedIn: false })

    // The stale response now lands, carrying the logged-out user's server prefs.
    await act(async () => {
      resolveFetch!({
        ok: true,
        json: () => Promise.resolve({ document_sort: 'alphabetical' }),
      } as Response)
      await Promise.resolve()
      await Promise.resolve()
    })

    // Must not have adopted the stale response; the guest default stands.
    expect(result.current.preferences.document_sort).toBe('date_newest_first')
  })

  it('does not let a stale revert stomp a later successful update (rapid toggles)', async () => {
    // Two PUTs go out back to back; we hold both open, then resolve the
    // second (later) call first and reject the first (earlier) call last --
    // reproducing a revert that fires after a subsequent update has already
    // landed. The final state must reflect the second call's value, not a
    // revert to the pre-first-call default.
    const puts: { resolve: () => void, reject: () => void }[] = []
    const mockFetch = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        return new Promise<Response>((resolve, reject) => {
          puts.push({
            resolve: () => resolve({ ok: true, text: () => Promise.resolve('{}') } as Response),
            reject: () => reject(new Error('put failed')),
          })
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ document_sort: 'date_newest_first' }),
        text: () => Promise.resolve(JSON.stringify({ document_sort: 'date_newest_first' })),
      } as Response)
    })
    vi.stubGlobal('fetch', mockFetch)

    const { result } = renderHook(() => useUserPreferences())
    await waitFor(() => expect(result.current.loading).toBe(false))

    let call1: Promise<void> | undefined
    let call2: Promise<void> | undefined
    await act(async () => {
      call1 = result.current.updatePreference('document_sort', 'alphabetical')
      await Promise.resolve()
      call2 = result.current.updatePreference('document_sort', 'date_oldest_first')
      await Promise.resolve()
    })

    expect(puts.length).toBe(2)
    expect(result.current.preferences.document_sort).toBe('date_oldest_first')  // second toggle's optimistic write

    await act(async () => {
      puts[1].resolve()  // second (later) call succeeds
      await call2
      puts[0].reject()  // first (earlier) call fails and reverts, after the fact
      await call1
    })

    expect(result.current.preferences.document_sort).toBe('date_oldest_first')
  })
})
