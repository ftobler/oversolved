import { create } from 'zustand'
import { requestStoragePersistence, type PersistenceState } from '@/adapters/storagePersistence'

// Where the answer to "will this browser keep my documents" is held for the UI.
//
// The request itself is fired once per session (boot), but the sentence it
// decides is rendered by a dialog that may mount before or after the promise
// settles, so the answer needs somewhere to live that both orderings can read.
// 'unknown' is the pre-answer state and renders no claim at all: an honest
// silence beats a durability promise the browser has not made yet.
interface StoragePersistenceState {
  state: PersistenceState | 'unknown'
  ensureRequested: () => void
}

// Module-level rather than store state: `ensureRequested` must be idempotent
// across every caller, and StrictMode double-invokes effects, so the guard has
// to sit outside the reactive value it sets.
let inFlight: Promise<void> | null = null

export const useStoragePersistenceStore = create<StoragePersistenceState>((set) => ({
  state: 'unknown',
  ensureRequested: () => {
    if (inFlight) return
    inFlight = requestStoragePersistence().then(state => { set({ state }) })
  },
}))

// Test seam: drops the once-per-session guard so a case can re-run the request.
export function resetStoragePersistenceRequest(): void {
  inFlight = null
  useStoragePersistenceStore.setState({ state: 'unknown' })
}
