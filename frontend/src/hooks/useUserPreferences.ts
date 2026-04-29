import { useState, useEffect } from 'react'

export type DocumentSort = 'alphabetical' | 'date_newest_first' | 'date_oldest_first'

export interface UserPreferences {
  document_sort: DocumentSort
}

const DEFAULT_PREFS: UserPreferences = { document_sort: 'alphabetical' }

export function useUserPreferences() {
  const [preferences, setPreferences] = useState<UserPreferences>(DEFAULT_PREFS)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch('/api/users/me/preferences')
      .then(r => {
        if (!r.ok) throw new Error('Failed to fetch preferences')
        return r.json()
      })
      .then(data => setPreferences({ document_sort: data.document_sort ?? 'alphabetical' }))
      .catch(() => { /* fall back to defaults */ })
      .finally(() => setLoading(false))
  }, [])

  const updatePreference = async (key: keyof UserPreferences, value: string) => {
    const next = { ...preferences, [key]: value } as UserPreferences
    setPreferences(next)
    try {
      const res = await fetch('/api/users/me/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [key]: value }),
      })
      if (!res.ok) {
        setPreferences(preferences)  // revert on failure
      }
    } catch {
      setPreferences(preferences)  // revert on failure
    }
  }

  return { preferences, loading, updatePreference }
}
