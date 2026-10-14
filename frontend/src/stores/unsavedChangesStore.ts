import { create } from 'zustand'
import { hashSavedText, reconcileDirty, type DirtyPin } from '@/session/dirty'
import { getWorkspaceStore } from '@/workspace/store'
import { subscribeWorkspaceStore } from '@/workspace/storeEvents'

// The fingerprint and the reconcile decision moved to the session's dirty
// policy when the session layer claimed them; the store stays the UI-facing
// mirror and re-exports the hash for its existing importers.
export { hashSavedText }

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
export type PinnedDirty = DirtyPin

interface UnsavedChangesState {
  dirty: boolean
  // Counts saves of the open document. The flag alone cannot say whether a save
  // landed mid-session: an edit after it sets the flag again.
  saves: number
  // The fingerprint of the text the last save stored, or null when nothing
  // published one. A cancel that rewinds a doc saved mid-session compares the
  // doc it restores against this: equal means the rewind threw nothing away,
  // unequal means the stored bytes hold an edit that no longer exists.
  savedHash: number | null
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
  // A save landed: the fingerprint describes the bytes now on disk, so it is
  // always published, and the save count moves. The flag clears only for a
  // `clean` save: an edit that landed during the write postdates the stored
  // bytes, so its flag has to survive. The fingerprint is what a later cancel
  // compares a rewound doc against; a caller that cannot say what it wrote
  // omits it, which clears the previous one rather than leaving a stale
  // fingerprint a later cancel would trust.
  markSaved: (savedHash?: number, clean?: boolean) => void
  // A different document is now open: the flag, the save count and the
  // fingerprint of what was stored all describe the previous one. A session
  // pinned against them would read another document's saves as its own, and a
  // cancel would compare its rewind against bytes that document stored.
  clearForNewDocument: () => void
  // The flag and save count as they stand now, for a session to pin at entry.
  pinDirty: () => PinnedDirty
  // A cancel rewound the doc to the state pinned when its session opened; puts
  // back the flag pinned with it, unless a save landed since. This is the
  // fallback for a caller that published no fingerprint: with no record of
  // whether the mid-session save stored the rewound content, a moved save count
  // means the stored bytes are not the doc being restored.
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
  savedHash: null,
  workspace: null,
  pendingCallback: null,
  saveHandler: null,
  setDirty: (dirty) => set({ dirty }),
  markSaved: (savedHash, clean = true) => set(prev => ({
    dirty: clean ? false : prev.dirty,
    saves: prev.saves + 1,
    savedHash: savedHash ?? null,
  })),
  clearForNewDocument: () => set({ dirty: false, saves: 0, savedHash: null }),
  pinDirty: () => ({ dirty: get().dirty, saves: get().saves }),
  // The fallback for a caller that publishes no fingerprint: without knowing
  // what bytes a mid-session save stored, a moved save count is read as "the
  // stored doc is not the one being restored", even when a later edit already
  // set the flag again. A caller that knows the stored fingerprint uses
  // reconcileDirtyAfterRewind instead, which compares content rather than count.
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

// The shared decision every cancel and commit uses to re-derive the flag from
// the bytes a mid-session save actually stored, so the call sites cannot drift
// apart. The decision itself lives in the session's dirty policy
// (`@/session/dirty`); this wrapper reads and writes the UI-facing store.
export function reconcileDirtyAfterRewind(
  pinned: PinnedDirty,
  rewound: boolean,
  serializeRestored: () => string,
): void {
  const store = useUnsavedChangesStore.getState()
  const next = reconcileDirty(
    { dirty: store.dirty, saves: store.saves, savedHash: store.savedHash },
    pinned,
    rewound,
    serializeRestored,
  )
  if (next !== null) store.setDirty(next)
}

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
