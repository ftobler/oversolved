import { useState, useEffect, useCallback, useRef } from 'react'
import { backendBundle } from '@/adapters/backend'
import type { DocumentSort, UserPreferences } from '@/adapters/preferences'

// Types live with the adapter now; re-exported here so existing call sites
// (Documents) keep importing them from the hook.
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
  // The flag tracks the cloud-load lifecycle: up while the fetch runs, down
  // once it settles, and down again when logout cancels it mid-flight (the
  // finally's cancelled guard would otherwise leave it stuck). React's
  // adjust-during-render idiom applies the cloudLoad edges here rather than
  // via setState inside the effect body, which cascades renders.
  const [loading, setLoading] = useState(cloudLoad)
  const [loadingFor, setLoadingFor] = useState(cloudLoad)
  if (loadingFor !== cloudLoad) {
    setLoadingFor(cloudLoad)
    setLoading(cloudLoad)
  }

  useEffect(() => {
    if (!cloudLoad) return  // guest or synchronous store: defaults already stand
    // A logout (or session expiry) mid-fetch flips cloudLoad back to false
    // without unmounting this hook's owner (Documents.tsx does not remount on
    // login/logout), so a stale resolution must not overwrite the now-guest
    // preferences with the logged-out user's server-side values. Mirrors the
    // `cancelled` guard in useDocumentState.ts/useAssemblyDoc.ts.
    let cancelled = false
    prefs.load()
      .then(loaded => {
        if (cancelled) return
        preferencesRef.current = loaded
        setPreferences(loaded)
      })
      .catch(() => {  /* fall back to defaults */ })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
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
        // Fail loud enough for an offline user to diagnose: the toggle visibly
        // bounced back, so say which key and why instead of reverting silently.
        console.warn(`[useUserPreferences] saving '${key}' failed; reverted to '${previous}'`)
      }
    }
  }, [prefs])

  return { preferences, loading, updatePreference }
}
