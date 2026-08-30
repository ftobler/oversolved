// Preferences capability: where user preferences (e.g. document sort) live.
//
// localStorage, not IndexedDB: these are a handful of small scalars read during
// the first render of the documents grid, and localStorage is the only browser
// store that can answer that synchronously. Putting them in the document
// database would cost an async hop and a loading flicker on every page load to
// remember which way a sort arrow points.
//
// Still a port rather than direct localStorage calls at the call site: the hook
// asks `backendBundle.preferences`, so preferences can later move (into the
// document store, into a synced profile) without touching the hook.
//
// `read` is deliberately synchronous, which is a real constraint on any future
// implementation, not an accident of this one: an async read would put a loading
// state and a first-render flicker into every consumer. A store that cannot
// answer synchronously has to cache into memory at boot and serve from there.

export type DocumentSort = 'alphabetical' | 'date_newest_first' | 'date_oldest_first'

export interface UserPreferences {
  document_sort: DocumentSort
}

export const DEFAULT_PREFS: UserPreferences = { document_sort: 'date_newest_first' }

export interface PreferencesAdapter {
  read(): UserPreferences
  // `next` is the full updated set; `key`/`value` is the single changed field,
  // for a store that can write one field without rewriting the rest. Async
  // because writing may be slow or may fail -- the caller applies the change
  // optimistically and reverts if this rejects.
  save(next: UserPreferences, key: keyof UserPreferences, value: string): Promise<void>
}

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

export class LocalPreferences implements PreferencesAdapter {
  read(): UserPreferences { return readLocalPrefs() }
  async save(next: UserPreferences): Promise<void> {
    // A browser with site data disabled throws here. Losing a sort preference is
    // not worth an error banner over, let alone an unhandled rejection, so the
    // write is best-effort and the in-memory value stands for this session.
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)) } catch {  /* quota / disabled */ }
  }
}
