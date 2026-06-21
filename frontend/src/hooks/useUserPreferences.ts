import { useState, useEffect } from 'react'
import { backendBundle } from '@/adapters/backend'
import type { DocumentSort, UserPreferences } from '@/adapters/preferences'

// Types live with the adapter now; re-exported here so existing call sites
// (Documents, UserProfile) keep importing them from the hook.
export type { DocumentSort, UserPreferences }

// `signedIn` gates the cloud load: a guest (the default session) has no
// server-side preferences, so firing the HTTP load would only 401. Defaults to
// true so the static build and account-only pages keep loading unconditionally.
export function useUserPreferences(signedIn = true) {
  const prefs = backendBundle.preferences
  // Static hydrates synchronously from localStorage via the lazy initializer
  // (no setState-in-effect); the HTTP build loads asynchronously after defaults.
  const [preferences, setPreferences] = useState<UserPreferences>(() => prefs.initial())
  const cloudLoad = prefs.async && signedIn  // a guest skips the server round-trip
  const [loading, setLoading] = useState(cloudLoad)

  useEffect(() => {
    if (!cloudLoad) return  // guest or synchronous store: defaults already stand
    prefs.load()
      .then(setPreferences)
      .catch(() => { /* fall back to defaults */ })
      .finally(() => setLoading(false))
  }, [prefs, cloudLoad])

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
