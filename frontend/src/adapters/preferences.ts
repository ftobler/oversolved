// Preferences capability: where user preferences (e.g. document sort) live.
//
// The HTTP build stores them per-user on the PDM backend; the static
// (zero-backend) build has no server, so they live in localStorage on the
// device. Both builds always have SOME preferences store -- only the transport
// differs -- so this capability is always present in the bundle (like
// telemetry). The hook reads `backendBundle.preferences` and never asks which
// build it is.
import { http } from '@/utils/core/httpClient'
import { type Backend } from '@/config/capabilities'

export type DocumentSort = 'alphabetical' | 'date_newest_first' | 'date_oldest_first'

export interface UserPreferences {
  document_sort: DocumentSort
}

export const DEFAULT_PREFS: UserPreferences = { document_sort: 'date_newest_first' }

export interface PreferencesAdapter {
  // Synchronous best-effort value available at first render. The static build
  // hydrates straight from localStorage here (no async flicker); the HTTP build
  // returns defaults until `load()` resolves.
  initial(): UserPreferences
  // Whether an async `load()` should follow `initial()` (HTTP yes, static no).
  readonly async: boolean
  load(): Promise<UserPreferences>
  // `next` is the full updated set; `key`/`value` is the single changed field
  // (the HTTP API patches one key, localStorage rewrites the whole blob).
  save(next: UserPreferences, key: keyof UserPreferences, value: string): Promise<void>
}

const API_PATH = '/api/users/me/preferences'

class HttpPreferences implements PreferencesAdapter {
  readonly async = true
  initial(): UserPreferences { return DEFAULT_PREFS }
  async load(): Promise<UserPreferences> {
    const data = await http.getJson<{ document_sort?: DocumentSort }>(API_PATH)
    return { document_sort: data.document_sort ?? DEFAULT_PREFS.document_sort }
  }
  async save(_next: UserPreferences, key: keyof UserPreferences, value: string): Promise<void> {
    await http.putJson(API_PATH, { [key]: value })
  }
}

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

class LocalPreferences implements PreferencesAdapter {
  readonly async = false  // localStorage is synchronous; initial() already has it
  initial(): UserPreferences { return readLocalPrefs() }
  async load(): Promise<UserPreferences> { return readLocalPrefs() }
  async save(next: UserPreferences): Promise<void> {
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch { /* quota / disabled */ }
  }
}

// Pure factory (testable without touching the env). Assembled into the
// `backendBundle` composition root (adapters/backend.ts), not a singleton here.
export function createPreferencesAdapter(b: Backend): PreferencesAdapter {
  return b === 'static' ? new LocalPreferences() : new HttpPreferences()
}
