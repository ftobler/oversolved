import { create } from 'zustand'
import { getWorkspaceStore } from '@/workspace/store'
import { subscribeWorkspaceStore } from '@/workspace/storeEvents'

// Tracks whether the open workspace has edits not yet written to its
// checkpoint. Navigating away does NOT auto-save (that is by design), so this
// flag lets the shared header and the browser-unload path warn before the edits
// are dropped. Kept global (not in partEditorStore) so AppHeader, which renders
// on every page, can read it without coupling to the part editor.
//
// In C2 the working copy is the durable-ish half and the explicit save writes
// the checkpoint; "dirty" is therefore the editor's in-memory edit flag OR the
// workspace being `ahead` of its checkpoint. The workspace subscription keeps
// the second half honest whenever the seam mutates.
export interface PinnedDirty {
  dirty: boolean
  saves: number
}

interface UnsavedChangesState {
  dirty: boolean
  // Counts saves of the open document. The flag alone cannot say whether a save
  // landed mid-session: an edit after it sets the flag again.
  saves: number
  // The workspace the current editor belongs to, or null on pages with nothing
  // to save. The header and the recovery path read it; the dirty refresh uses
  // it to compare the working copy against the checkpoint.
  workspace: string | null
  pendingCallback: (() => void) | null
  // How to write the open document, registered by whichever editor owns it, so
  // the shared header can offer "Save & Exit" instead of only "Discard". Null
  // on pages that have nothing to save; resolves to whether the bytes landed,
  // so a failed save can hold the user in the dialog. The handler clears dirty
  // itself, and only when no edit landed while it was in flight; a caller that
  // cleared it on `true` would mark that edit saved.
  saveHandler: (() => boolean | Promise<boolean>) | null
  setDirty: (dirty: boolean) => void
  // A save landed: the stored bytes now equal the live doc, so the flag clears
  // and the save count moves, which is what a later cancel compares against.
  markSaved: () => void
  // The flag and save count as they stand now, for a session to pin at entry.
  pinDirty: () => PinnedDirty
  // A cancel rewound the doc to the state pinned when its session opened; puts
  // back the flag pinned with it, unless a save landed since.
  restoreDirtyAfterRewind: (pinned: PinnedDirty) => void
  setWorkspace: (workspace: string | null) => void
  setSaveHandler: (handler: (() => boolean | Promise<boolean>) | null) => void
  requestConfirm: (onDiscard: () => void) => void
  dismissConfirm: () => void
  refreshWorkspaceDirty: () => Promise<void>
}

// Guards against an older `open` resolving after a newer one and writing a
// stale `ahead` back: a save fires both a writeEntry and a checkpoint event, so
// two refreshes race and the later-started one must win.
let refreshToken = 0

export const useUnsavedChangesStore = create<UnsavedChangesState>((set, get) => ({
  dirty: false,
  saves: 0,
  workspace: null,
  pendingCallback: null,
  saveHandler: null,
  setDirty: (dirty) => set({ dirty }),
  markSaved: () => set(prev => ({ dirty: false, saves: prev.saves + 1 })),
  pinDirty: () => ({ dirty: get().dirty, saves: get().saves }),
  // A save that landed mid-session stored the doc being thrown away, so the
  // rewound doc differs from the saved one and stays dirty, even when a later
  // edit already set the flag again.
  restoreDirtyAfterRewind: (pinned) => set(prev => ({ dirty: prev.saves !== pinned.saves ? true : pinned.dirty })),
  setWorkspace: (workspace) => {
    set({ workspace, dirty: false })
    if (workspace) void get().refreshWorkspaceDirty()
  },
  // Stored behind an updater: zustand would otherwise call a bare function
  // argument as a state updater instead of storing it.
  setSaveHandler: (handler) => set({ saveHandler: handler }),
  requestConfirm: (onDiscard) => set({ pendingCallback: onDiscard }),
  dismissConfirm: () => set({ pendingCallback: null }),
  refreshWorkspaceDirty: async () => {
    const workspace = get().workspace
    if (!workspace) return
    const token = ++refreshToken
    try {
      const opened = await getWorkspaceStore().open(workspace)
      if (token !== refreshToken || get().workspace !== workspace) return
      set({ dirty: opened.ahead })
    } catch {
      // A workspace that cannot be opened (no IndexedDB in a non-persistence
      // test, or a purged row) leaves the in-memory edit flag as it was.
    }
  },
}))

// The seam emits on open, close and every mutating verb, so a save or a
// recovery reset re-derives dirty from the record rather than from React.
subscribeWorkspaceStore(() => { void useUnsavedChangesStore.getState().refreshWorkspaceDirty() })

// Imperative guard for navigation outside React render (event handlers). When the document is dirty, schedules a confirm dialog via the
// store so the shared header can render it. `onProceed` is baked into the stored
// callback and fired when the user clicks Discard. Returns false to cancel the
// current event (e.preventDefault etc.) while the user decides.
export function confirmDiscardUnsavedChanges(onProceed?: () => void): boolean {
  if (!useUnsavedChangesStore.getState().dirty) return true
  // First-requested navigation wins: a second nav target clicked while the
  // dialog is up must not overwrite the first one's proceed, or confirming
  // would silently drop the navigation the user asked for first.
  if (useUnsavedChangesStore.getState().pendingCallback === null) {
    useUnsavedChangesStore.getState().requestConfirm(() => {
      useUnsavedChangesStore.getState().setDirty(false)
      onProceed?.()
    })
  }
  return false
}
