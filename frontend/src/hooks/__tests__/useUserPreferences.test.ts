import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import { backendBundle } from '@/adapters/backend'

// Drives the hook against the real localStorage-backed adapter out of the
// bundle, so the "no loading pass" property below is a property of the wiring
// the app actually ships, not of a stub.
describe('useUserPreferences', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    localStorage.clear()
  })

  // The first render has the stored value, not the default followed by a
  // correction: no waitFor here on purpose, since a flicker would show up as
  // this assertion failing on the initial result.
  it('has the stored preference on the very first render', () => {
    localStorage.setItem('oversolved.preferences', JSON.stringify({ document_sort: 'alphabetical' }))
    const { result } = renderHook(() => useUserPreferences())
    expect(result.current.preferences.document_sort).toBe('alphabetical')
  })

  it('defaults to date_newest_first with nothing stored', () => {
    const { result } = renderHook(() => useUserPreferences())
    expect(result.current.preferences.document_sort).toBe('date_newest_first')
  })

  it('updatePreference persists and updates local state', async () => {
    const { result } = renderHook(() => useUserPreferences())
    await act(async () => { await result.current.updatePreference('document_sort', 'date_oldest_first') })
    expect(result.current.preferences.document_sort).toBe('date_oldest_first')
    expect(JSON.parse(localStorage.getItem('oversolved.preferences')!))
      .toEqual({ document_sort: 'date_oldest_first' })
  })

  it('does not let a stale revert stomp a later successful update (rapid toggles)', async () => {
    // Two saves go out back to back; we hold both open, then resolve the second
    // (later) call first and reject the first (earlier) call last -- reproducing
    // a revert that fires after a subsequent update has already landed. The final
    // state must reflect the second call's value, not a revert to the default.
    const saves: { resolve: () => void, reject: () => void }[] = []
    vi.spyOn(backendPreferences(), 'save').mockImplementation(() =>
      new Promise<void>((resolve, reject) => {
        saves.push({ resolve, reject: () => reject(new Error('save failed')) })
      }))

    const { result } = renderHook(() => useUserPreferences())

    let call1: Promise<void> | undefined
    let call2: Promise<void> | undefined
    await act(async () => {
      call1 = result.current.updatePreference('document_sort', 'alphabetical')
      await Promise.resolve()
      call2 = result.current.updatePreference('document_sort', 'date_oldest_first')
      await Promise.resolve()
    })

    expect(saves.length).toBe(2)
    expect(result.current.preferences.document_sort).toBe('date_oldest_first')  // second toggle's optimistic write

    await act(async () => {
      saves[1].resolve()  // second (later) call succeeds
      await call2
      saves[0].reject()  // first (earlier) call fails and reverts, after the fact
      await call1
    })

    expect(result.current.preferences.document_sort).toBe('date_oldest_first')
  })

  it('a failed save reverts the optimistic value and warns about the reverted key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(backendPreferences(), 'save').mockRejectedValue(new Error('storage full'))

    const { result } = renderHook(() => useUserPreferences())
    await act(async () => { await result.current.updatePreference('document_sort', 'alphabetical') })

    expect(result.current.preferences.document_sort).toBe('date_newest_first')  // reverted
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('document_sort')
    expect(String(warn.mock.calls[0][0])).toContain('reverted')
  })
})

// The adapter instance the hook will read, so a spy installed on it is the one
// the hook calls. Resolved lazily inside each test rather than at import time so
// the spy lands after vi.restoreAllMocks() has run.
function backendPreferences() {
  return backendBundle.preferences
}
