import { useState, useEffect } from 'react'
import { http } from '@/utils/core/httpClient'
import { hasBackend } from '@/config/capabilities'

export type DocumentSort = 'alphabetical' | 'date_newest_first' | 'date_oldest_first'

export interface UserPreferences {
  document_sort: DocumentSort
}

const DEFAULT_PREFS: UserPreferences = { document_sort: 'date_newest_first' }

// In a static build preferences live in localStorage instead of on the server.
const LS_KEY = 'oversolved.preferences'

function readLocalPrefs(): UserPreferences {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return DEFAULT_PREFS
    const parsed = JSON.parse(raw) as Partial<UserPreferences>
    return { document_sort: parsed.document_sort ?? DEFAULT_PREFS.document_sort }
  } catch {
    return DEFAULT_PREFS
  }
}

export function useUserPreferences() {
  // Static build hydrates synchronously from localStorage via the lazy
  // initializer (no setState-in-effect); the HTTP build loads asynchronously.
  const [preferences, setPreferences] = useState<UserPreferences>(() =>
    hasBackend ? DEFAULT_PREFS : readLocalPrefs(),
  )
  const [loading, setLoading] = useState(hasBackend)

  useEffect(() => {
    if (!hasBackend) return  // already hydrated from localStorage
    http.getJson<{ document_sort?: DocumentSort }>('/api/users/me/preferences')
      .then(data => setPreferences({ document_sort: data.document_sort ?? 'date_newest_first' }))
      .catch(() => { /* fall back to defaults */ })
      .finally(() => setLoading(false))
  }, [])

  const updatePreference = async (key: keyof UserPreferences, value: string) => {
    const next = { ...preferences, [key]: value } as UserPreferences
    setPreferences(next)
    if (!hasBackend) {
      try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* quota / disabled */ }
      return
    }
    try {
      await http.putJson('/api/users/me/preferences', { [key]: value })
    } catch {
      setPreferences(preferences)  // revert on failure
    }
  }

  return { preferences, loading, updatePreference }
}
