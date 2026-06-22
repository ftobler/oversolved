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
  setDirty: (dirty: boolean) => void
}

export const useUnsavedChangesStore = create<UnsavedChangesState>((set) => ({
  dirty: false,
  setDirty: (dirty) => set({ dirty }),
}))

// Imperative guard for navigation outside React render (event handlers, the
// logout flow). Returns true when it is safe to proceed; on a confirmed discard
// it clears the flag so the in-flight navigation does not re-prompt.
export function confirmDiscardUnsavedChanges(): boolean {
  if (!useUnsavedChangesStore.getState().dirty) return true
  const ok = window.confirm('You have unsaved changes that will be lost. Leave without saving?')
  if (ok) useUnsavedChangesStore.getState().setDirty(false)
  return ok
}
