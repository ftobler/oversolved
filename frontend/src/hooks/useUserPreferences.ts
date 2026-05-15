import { useState, useEffect } from 'react'
import { http } from '@/utils/httpClient'

export type DocumentSort = 'alphabetical' | 'date_newest_first' | 'date_oldest_first'

export interface UserPreferences {
  document_sort: DocumentSort
}

const DEFAULT_PREFS: UserPreferences = { document_sort: 'alphabetical' }

export function useUserPreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    http.getJson<{ document_sort?: DocumentSort }>('/api/users/me/preferences')
      .then(data => setPreferences({ document_sort: data.document_sort ?? 'alphabetical' }))
      .catch(() => { /* fall back to defaults */ })
      .finally(() => setLoading(false))
  }, [])

  const updatePreference = async (key: keyof UserPreferences, value: string) => {
    const next = { ...preferences, [key]: value } as UserPreferences
    setPreferences(next)
    try {
      await http.putJson('/api/users/me/preferences', { [key]: value })
    } catch {
      setPreferences(preferences)  // revert on failure
    }
  }

  return { preferences, loading, updatePreference }
}
