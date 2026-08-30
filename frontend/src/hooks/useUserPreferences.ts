import { useState, useCallback, useRef } from 'react'
import { backendBundle } from '@/adapters/backend'
import type { DocumentSort, UserPreferences } from '@/adapters/preferences'

// Types live with the adapter now; re-exported here so existing call sites
// (Documents) keep importing them from the hook.
export type { DocumentSort, UserPreferences }

// Reads through the preferences port and writes back optimistically.
//
// There is no loading state and no effect: the port reads synchronously (see
// PreferencesAdapter), so the very first render already has the stored value and
// the documents grid paints the right sort arrow without a correcting second
// pass. That is the whole reason preferences are not in the document database.
export function useUserPreferences() {
  const prefs = backendBundle.preferences
  const [preferences, setPreferences] = useState<UserPreferences>(() => prefs.read())
  // `preferences` (the state value closed over by callbacks) only reflects
  // React's latest *committed* render -- it can lag behind calls that already
  // fired. The ref is written synchronously by every update below, so two
  // rapid updatePreference calls always read/write the true current value
  // instead of racing on a stale closure.
  const preferencesRef = useRef(preferences)

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
        // Fail loud enough to diagnose: the toggle visibly bounced back, so say
        // which key and why instead of reverting silently.
        console.warn(`[useUserPreferences] saving '${key}' failed; reverted to '${previous}'`)
      }
    }
  }, [prefs])

  return { preferences, updatePreference }
}
