import { useState, useEffect, useCallback, useRef } from 'react'
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
  // `preferences` (the state value closed over by callbacks) only reflects
  // React's latest *committed* render -- it can lag behind calls that already
  // fired. The ref is written synchronously by every update below, so two
  // rapid updatePreference calls always read/write the true current value
  // instead of racing on a stale closure.
  const preferencesRef = useRef(preferences)
  const cloudLoad = prefs.async && signedIn  // a guest skips the server round-trip
  const [loading, setLoading] = useState(cloudLoad)

  useEffect(() => {
    if (!cloudLoad) return  // guest or synchronous store: defaults already stand
    prefs.load()
      .then(loaded => {
        preferencesRef.current = loaded
        setPreferences(loaded)
      })
      .catch(() => {  /* fall back to defaults */ })
      .finally(() => setLoading(false))
  }, [prefs, cloudLoad])

  const updatePreference = useCallback(async (key: keyof UserPreferences, value: string) => {
    const previous = preferencesRef.current[key]
    const next = { ...preferencesRef.current, [key]: value } as UserPreferences
    preferencesRef.current = next
    setPreferences(next)
    try {
      await prefs.save(next, key, value)
    } catch {
      // Only revert if this key still holds the value *this* call set. If a
      // later call already changed it again (e.g. a second rapid toggle),
      // reverting here would stomp that newer update with our stale value.
      if (preferencesRef.current[key] === value) {
        const reverted = { ...preferencesRef.current, [key]: previous } as UserPreferences
        preferencesRef.current = reverted
        setPreferences(reverted)
      }
    }
  }, [prefs])

  return { preferences, loading, updatePreference }
}
