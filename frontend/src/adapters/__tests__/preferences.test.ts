import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPreferencesAdapter } from '@/adapters/preferences'

describe('preferences adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('HTTP', () => {
    it('loads from /api/users/me/preferences', async () => {
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ document_sort: 'alphabetical' }) } as Response),
      ))
      const adapter = createPreferencesAdapter('http')
      expect(adapter.async).toBe(true)
      expect(adapter.initial().document_sort).toBe('date_newest_first')
      const prefs = await adapter.load()
      expect(prefs.document_sort).toBe('alphabetical')
    })

    it('falls back to the default sort when the server omits it', async () => {
      vi.stubGlobal('fetch', vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response),
      ))
      const prefs = await createPreferencesAdapter('http').load()
      expect(prefs.document_sort).toBe('date_newest_first')
    })

    it('saves a single changed key via PUT', async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve({ ok: true, text: () => Promise.resolve('{}') } as Response),
      )
      vi.stubGlobal('fetch', fetchMock)
      const adapter = createPreferencesAdapter('http')
      await adapter.save({ document_sort: 'alphabetical' }, 'document_sort', 'alphabetical')
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/users/me/preferences',
        expect.objectContaining({
          method: 'PUT',
          body: JSON.stringify({ document_sort: 'alphabetical' }),
        }),
      )
    })
  })

  describe('static (localStorage)', () => {
    beforeEach(() => {
      localStorage.clear()
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('network must not be hit in static mode') }))
    })

    it('reads defaults synchronously without fetching', () => {
      const adapter = createPreferencesAdapter('static')
      expect(adapter.async).toBe(false)
      expect(adapter.initial().document_sort).toBe('date_newest_first')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('round-trips through localStorage', async () => {
      const adapter = createPreferencesAdapter('static')
      await adapter.save({ document_sort: 'alphabetical' }, 'document_sort', 'alphabetical')
      expect(JSON.parse(localStorage.getItem('oversolved.preferences')!)).toEqual({ document_sort: 'alphabetical' })
      expect(createPreferencesAdapter('static').initial().document_sort).toBe('alphabetical')
    })
  })
})
