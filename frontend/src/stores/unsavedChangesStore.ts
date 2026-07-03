import { create } from 'zustand'

// Tracks whether the open document has edits not yet written to its store.
// Navigating away does NOT auto-save (that is by design), so this flag lets the
// shared header and the browser-unload path warn before the edits are dropped.
// Kept global (not in partEditorStore) so AppHeader, which renders on every
// page, can read it without coupling to the part editor. Part owns the lifecycle:
// it marks dirty on edit, clears on save/load, and clears on unmount so other
// pages never inherit a stale flag.
interface UnsavedChangesState {
  dirty: boolean
  pendingCallback: (() => void) | null
  setDirty: (dirty: boolean) => void
  requestConfirm: (onDiscard: () => void) => void
  dismissConfirm: () => void
}

export const useUnsavedChangesStore = create<UnsavedChangesState>((set) => ({
  dirty: false,
  pendingCallback: null,
  setDirty: (dirty) => set({ dirty }),
  requestConfirm: (onDiscard) => set({ pendingCallback: onDiscard }),
  dismissConfirm: () => set({ pendingCallback: null }),
}))

// Imperative guard for navigation outside React render (event handlers, the
// logout flow). When the document is dirty, schedules a confirm dialog via the
// store so the shared header can render it. `onProceed` is baked into the stored
// callback and fired when the user clicks Discard. Returns false to cancel the
// current event (e.preventDefault etc.) while the user decides.
export function confirmDiscardUnsavedChanges(onProceed?: () => void): boolean {
  if (!useUnsavedChangesStore.getState().dirty) return true
  useUnsavedChangesStore.getState().requestConfirm(() => {
    useUnsavedChangesStore.getState().setDirty(false)
    onProceed?.()
  })
  return false
}
