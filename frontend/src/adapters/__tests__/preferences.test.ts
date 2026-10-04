import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LocalPreferences, type PreferencesAdapter } from '@/adapters/preferences'

describe('preferences adapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  describe('localStorage', () => {
    beforeEach(() => {
      localStorage.clear()
      vi.stubGlobal('fetch', vi.fn(() => { throw new Error('preferences must not touch the network') }))
    })

    // A synchronous read that already has the stored value is what lets the
    // documents grid paint the right sort arrow on its FIRST render; anything
    // needing a load pass would flash the default and then correct itself.
    it('reads the stored value synchronously, without fetching', () => {
      localStorage.setItem('oversolved.preferences', JSON.stringify({ document_sort: 'alphabetical' }))
      expect(new LocalPreferences().read().document_sort).toBe('alphabetical')
      expect(globalThis.fetch).not.toHaveBeenCalled()
    })

    it('falls back to the default sort with nothing stored', () => {
      expect(new LocalPreferences().read().document_sort).toBe('date_newest_first')
    })

    // A stored record from an older shape may miss the sort key; the read still
    // has to answer a real sort rather than undefined.
    it('falls back to the default sort when the stored record omits the key', () => {
      localStorage.setItem('oversolved.preferences', JSON.stringify({}))
      expect(new LocalPreferences().read().document_sort).toBe('date_newest_first')
    })

    // A stale or corrupted localStorage value is not in the DocumentSort union;
    // passing it through would reach the grid's sort switch as a bogus member.
    it('falls back to the default sort when the stored value is not a known sort', () => {
      localStorage.setItem('oversolved.preferences', JSON.stringify({ document_sort: 'date_newest' }))
      expect(new LocalPreferences().read().document_sort).toBe('date_newest_first')

      localStorage.setItem('oversolved.preferences', JSON.stringify({ document_sort: 5 }))
      expect(new LocalPreferences().read().document_sort).toBe('date_newest_first')
    })

    it('round-trips through localStorage', async () => {
      // Typed as the port, so the call sites here are the ones the hook makes.
      const adapter: PreferencesAdapter = new LocalPreferences()
      await adapter.save({ document_sort: 'alphabetical' }, 'document_sort', 'alphabetical')
      expect(JSON.parse(localStorage.getItem('oversolved.preferences')!)).toEqual({ document_sort: 'alphabetical' })
      expect(new LocalPreferences().read().document_sort).toBe('alphabetical')
    })

    // A browser with site data disabled throws from getItem/setItem rather than
    // returning null, so both directions must swallow rather than take the page
    // down over a sort preference.
    it('survives a localStorage that throws', async () => {
      const boom = () => { throw new Error('SecurityError') }
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom)
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom)
      const adapter: PreferencesAdapter = new LocalPreferences()
      expect(adapter.read().document_sort).toBe('date_newest_first')
      await expect(adapter.save({ document_sort: 'alphabetical' }, 'document_sort', 'alphabetical')).resolves.toBeUndefined()
    })
  })
})
