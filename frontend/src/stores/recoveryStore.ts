import { create } from 'zustand'
import { getWorkspaceStore } from '@/workspace/store'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { errorMessage } from '@/utils/core/errorMessage'

// U7's recovery prompt as an explicit state machine. Opening a workspace whose
// working copy is ahead of its checkpoint leaves the choice to the user: Keep
// adopts the working copy, Discard resets it to the checkpoint. Nothing is
// resolved silently, so a crash between the two writes just asks again.
//
// The state is keyed to a workspace so the page can mount the dialog only for
// the document it is showing, and a route change cannot leave a stale prompt.
export type RecoveryStatus = 'idle' | 'asking' | 'resolved'

// A later `begin` must win over an earlier one still in flight, so a route
// change cannot arm the prompt for the workspace the user just left.
let beginToken = 0

interface RecoveryState {
  status: RecoveryStatus
  workspace: string | null
  lastEditedAt: number
  // A resolution in flight. Keep and Discard are mutually exclusive and the
  // write is not recallable, so the dialog seals on this rather than let a
  // second click checkpoint a working copy the first click is discarding.
  resolving: boolean
  // A resolution that failed. The prompt is still unanswered, so it stays up
  // with the reason on it and both choices live again. Nothing was written and
  // the working copy is untouched, so dismissing only defers: the next open
  // finds it still ahead and asks again.
  error?: string
  // Opens the workspace and arms the prompt when the working copy is ahead.
  // Returns whether the prompt was armed, so a caller can await the decision
  // rather than guess from a later render.
  begin: (workspace: string) => Promise<boolean>
  keep: () => Promise<void>
  discard: () => Promise<void>
  // Leave the prompt without answering it. Only reachable once a resolution has
  // failed, because until then the close button means Keep. It writes nothing,
  // so the working copy stays ahead and the next open asks again.
  dismiss: () => void
  reset: () => void
}

export const useRecoveryStore = create<RecoveryState>((set, get) => {
  // Keep and Discard differ only in the write they hand the store, so the
  // in-flight guard, the failure handling and the staleness rule live once.
  const resolve = async (run: (workspace: string) => Promise<void>): Promise<void> => {
    const workspace = get().workspace
    // The guard is here rather than on the dialog alone: a stale click can land
    // after the buttons are disabled, and checkpointing a working copy that the
    // first click is discarding would resolve the prompt twice, both ways.
    if (!workspace || get().resolving) return
    const token = ++beginToken
    set({ resolving: true, error: undefined })
    try {
      await run(workspace)
    } catch (e) {
      // Nothing was written, so the question is still open: the prompt stays up
      // with the reason on it and both choices live again. The dirty flag is
      // deliberately untouched, because the edits really are still unsaved.
      if (token !== beginToken) return
      set({ resolving: false, error: errorMessage(e, 'Failed to resolve the unsaved edits') })
      return
    }
    if (token !== beginToken) return
    set({ status: 'resolved', workspace: null, lastEditedAt: 0, resolving: false, error: undefined })
    useUnsavedChangesStore.getState().setDirty(false)
  }

  return {
    status: 'idle',
    workspace: null,
    lastEditedAt: 0,
    resolving: false,
    begin: async (workspace) => {
      const token = ++beginToken
      let opened
      try {
        opened = await getWorkspaceStore().open(workspace)
      } catch {
        // A workspace that cannot be opened has nothing to recover; the editor's
        // own load reports the failure.
        if (token === beginToken) set({ status: 'idle', workspace: null, lastEditedAt: 0, error: undefined })
        return false
      }
      if (token !== beginToken) return false
      if (!opened.ahead) {
        set({ status: 'idle', workspace: null, lastEditedAt: 0, error: undefined })
        return false
      }
      set({ status: 'asking', workspace, lastEditedAt: opened.lastEditedAt, error: undefined })
      return true
    },
    keep: () => resolve(workspace => getWorkspaceStore().checkpoint(workspace)),
    discard: () => resolve(workspace => getWorkspaceStore().discard(workspace)),
    dismiss: () => {
      if (get().resolving) return
      beginToken++
      // No write and no dirty change: the working copy is exactly as it was, so
      // the flag the page already derived from `ahead` still tells the truth.
      set({ status: 'resolved', workspace: null, lastEditedAt: 0, error: undefined })
    },
    reset: () => {
      beginToken++
      set({ status: 'idle', workspace: null, lastEditedAt: 0, resolving: false, error: undefined })
    },
  }
})
