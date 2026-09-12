// Storage durability: the one place that asks the browser to stop treating the
// document library as disposable.
//
// Since the backend removal IndexedDB is the only home a document has, and by
// default it is *best-effort* storage -- the browser may evict the whole origin
// under disk pressure, with no warning and nothing to recover from.
// `navigator.storage.persist()` is the only lever that changes that, and it has
// to be asked for; it is never granted implicitly.
//
// A port rather than a call at the boot site because it is a platform
// capability with three honest answers, and the About/disclaimer copy renders a
// different sentence for each. Browsers decide the grant on their own
// heuristics (engagement, installed-app status), so a denial is normal and must
// read as a fact about durability, not as an error.

// 'persisted'   the browser will not evict this origin on its own.
// 'best-effort' the API exists and said no; eviction under pressure is possible.
// 'unsupported' the API is absent, so durability is unknown and unaskable.
export type PersistenceState = 'persisted' | 'best-effort' | 'unsupported'

function manager(): StorageManager | null {
  const storage = navigator.storage
  if (!storage || typeof storage.persist !== 'function' || typeof storage.persisted !== 'function') {
    return null
  }
  return storage
}

// Reports the grant WITHOUT asking for it. `persisted()` is a pure query and
// never prompts, so this is what boot runs: the durability sentence can be
// rendered honestly from it, and nothing pops up in front of a visitor who has
// not done anything yet.
export async function checkStoragePersistence(): Promise<PersistenceState> {
  const storage = manager()
  if (!storage) return 'unsupported'
  try {
    return (await storage.persisted()) ? 'persisted' : 'best-effort'
  } catch {
    // A rejected promise here (private mode, storage disabled) tells us the same
    // thing an absent API does: durability cannot be established.
    return 'unsupported'
  }
}

// Asks for the grant. Some engines decide this on their own heuristics and some
// put a permission prompt in front of the user, so it is called from a user
// gesture (the disclaimer's OK, which is where the storage copy is read) rather
// than at boot -- the same discipline the folder handles follow.
//
// `persisted()` is checked first: a grant already in force must not be
// re-requested, because a repeat `persist()` can re-run those heuristics and
// prompt a previously granted origin for nothing.
export async function requestStoragePersistence(): Promise<PersistenceState> {
  const storage = manager()
  if (!storage) return 'unsupported'
  try {
    if (await storage.persisted()) return 'persisted'
    return (await storage.persist()) ? 'persisted' : 'best-effort'
  } catch {
    return 'unsupported'
  }
}

// The one-sentence rendering of each answer, kept next to the enum so a fourth
// state cannot be added without a sentence for it. 'unknown' is the pre-answer
// state and renders nothing: an honest silence beats a durability claim the
// browser has not made yet. Lives here rather than in the dialog so the copy
// is testable without mounting React.
export function durabilityNotice(state: PersistenceState | 'unknown'): string | null {
  switch (state) {
    case 'persisted':
      return 'This browser has granted persistent storage, so it will not discard them on its own.'
    case 'best-effort':
      return 'This browser has not granted persistent storage, so it may discard them when disk space runs short.'
    case 'unsupported':
      return 'This browser does not report whether its storage is persistent, so treat it as best effort.'
    default:
      return null
  }
}

// The workspace dirty indicator's sentence per answer (A10). Same three states,
// different subject: `durabilityNotice` describes the stored library in the
// disclaimer, while this describes edits that still only sit in the working
// copy. Kept here rather than in the header so the copy is testable without
// mounting React, exactly like durabilityNotice.
export function unsavedDurabilityNotice(state: PersistenceState | 'unknown'): string | null {
  switch (state) {
    case 'persisted':
      return 'Unsaved edits are kept in this browser until you save.'
    case 'best-effort':
      return 'Unsaved edits can be discarded by the browser when disk space runs short. Save to keep them.'
    case 'unsupported':
      return 'This browser does not report whether its storage is persistent; treat unsaved edits as best-effort.'
    default:
      return null
  }
}
