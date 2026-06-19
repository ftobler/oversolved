import { useState, useEffect } from 'react'
import { backendBundle } from '@/adapters/backend'
import type { DocumentSort, UserPreferences } from '@/adapters/preferences'

// Types live with the adapter now; re-exported here so existing call sites
// (Documents, UserProfile) keep importing them from the hook.
export type { DocumentSort, UserPreferences }

export function useUserPreferences() {
  const prefs = backendBundle.preferences
  // Static hydrates synchronously from localStorage via the lazy initializer
  // (no setState-in-effect); the HTTP build loads asynchronously after defaults.
  const [preferences, setPreferences] = useState<UserPreferences>(() => prefs.initial())
  const [loading, setLoading] = useState(prefs.async)

  useEffect(() => {
    if (!prefs.async) return  // already hydrated synchronously
    prefs.load()
      .then(setPreferences)
      .catch(() => { /* fall back to defaults */ })
      .finally(() => setLoading(false))
  }, [prefs])

  const updatePreference = async (key: keyof UserPreferences, value: string) => {
    const next = { ...preferences, [key]: value } as UserPreferences
    setPreferences(next)
    try {
      await prefs.save(next, key, value)
    } catch {
      setPreferences(preferences)  // revert on failure (HTTP)
    }
  }

  return { preferences, loading, updatePreference }
}
