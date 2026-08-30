import { create } from 'zustand'
import {
  checkStoragePersistence, requestStoragePersistence, type PersistenceState,
} from '@/adapters/storagePersistence'

// Where the answer to "will this browser keep my documents" is held for the UI.
//
// Two steps, because asking for the grant can prompt and merely reading it
// cannot. Boot CHECKS (never prompts), which is what the disclaimer's storage
// sentence renders; acknowledging the disclaimer REQUESTS, which is a user
// gesture and the moment the user has just been told what the grant is for.
//
// The check is fired once per session but the dialog may mount before or after
// the promise settles, so the answer needs somewhere both orderings can read.
// 'unknown' is the pre-answer state and renders no claim at all: an honest
// silence beats a durability promise the browser has not made yet.
interface StoragePersistenceState {
  state: PersistenceState | 'unknown'
  ensureChecked: () => void
  request: () => Promise<void>
}

// Module-level rather than store state: `ensureChecked` must be idempotent
// across every caller, and StrictMode double-invokes effects, so the guard has
// to sit outside the reactive value it sets.
let inFlight: Promise<void> | null = null

export const useStoragePersistenceStore = create<StoragePersistenceState>((set) => ({
  state: 'unknown',
  ensureChecked: () => {
    if (inFlight) return
    inFlight = checkStoragePersistence().then(state => { set({ state }) })
  },
  request: async () => {
    set({ state: await requestStoragePersistence() })
  },
}))

// Test seam: drops the once-per-session guard so a case can re-run the check.
export function resetStoragePersistenceRequest(): void {
  inFlight = null
  useStoragePersistenceStore.setState({ state: 'unknown' })
}
