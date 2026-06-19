import { describe, it, expect, beforeEach, vi } from 'vitest'

// Static build: no backend. Hand the hook the static (localStorage) preferences
// adapter so it must live in localStorage and never touch the network.
vi.mock('@/adapters/backend', async () => {
  const { createPreferencesAdapter } = await import('@/adapters/preferences')
  return { backendBundle: { preferences: createPreferencesAdapter('static') } }
})

import { renderHook, act, waitFor } from '@testing-library/react'
import { useUserPreferences } from '../useUserPreferences'

describe('useUserPreferences (static / no backend)', () => {
  beforeEach(() => {
    localStorage.clear()
    globalThis.fetch = vi.fn(() => { throw new Error('network must not be hit in static mode') }) as unknown as typeof fetch
  })

  it('reads defaults when localStorage is empty, without fetching', async () => {
    const { result } = renderHook(() => useUserPreferences())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.preferences.document_sort).toBe('date_newest_first')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('persists an updated preference to localStorage', async () => {
    const { result } = renderHook(() => useUserPreferences())
    await act(async () => { await result.current.updatePreference('document_sort', 'alphabetical') })
    expect(result.current.preferences.document_sort).toBe('alphabetical')
    expect(JSON.parse(localStorage.getItem('oversolved.preferences')!)).toEqual({ document_sort: 'alphabetical' })
  })

  it('hydrates a previously stored preference', async () => {
    localStorage.setItem('oversolved.preferences', JSON.stringify({ document_sort: 'date_oldest_first' }))
    const { result } = renderHook(() => useUserPreferences())
    await waitFor(() => expect(result.current.preferences.document_sort).toBe('date_oldest_first'))
  })
})
