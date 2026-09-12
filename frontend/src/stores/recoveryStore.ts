import { create } from 'zustand'
import { getWorkspaceStore } from '@/workspace/store'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

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
  // Opens the workspace and arms the prompt when the working copy is ahead.
  // Returns whether the prompt was armed, so a caller can await the decision
  // rather than guess from a later render.
  begin: (workspace: string) => Promise<boolean>
  keep: () => Promise<void>
  discard: () => Promise<void>
  reset: () => void
}

export const useRecoveryStore = create<RecoveryState>((set, get) => ({
  status: 'idle',
  workspace: null,
  lastEditedAt: 0,
  begin: async (workspace) => {
    const token = ++beginToken
    let opened
    try {
      opened = await getWorkspaceStore().open(workspace)
    } catch {
      // A workspace that cannot be opened has nothing to recover; the editor's
      // own load reports the failure.
      if (token === beginToken) set({ status: 'idle', workspace: null, lastEditedAt: 0 })
      return false
    }
    if (token !== beginToken) return false
    if (!opened.ahead) {
      set({ status: 'idle', workspace: null, lastEditedAt: 0 })
      return false
    }
    set({ status: 'asking', workspace, lastEditedAt: opened.lastEditedAt })
    return true
  },
  keep: async () => {
    const workspace = get().workspace
    if (!workspace) return
    beginToken++
    await getWorkspaceStore().checkpoint(workspace)
    set({ status: 'resolved', workspace: null, lastEditedAt: 0 })
    useUnsavedChangesStore.getState().setDirty(false)
  },
  discard: async () => {
    const workspace = get().workspace
    if (!workspace) return
    beginToken++
    await getWorkspaceStore().discard(workspace)
    set({ status: 'resolved', workspace: null, lastEditedAt: 0 })
    useUnsavedChangesStore.getState().setDirty(false)
  },
  reset: () => {
    beginToken++
    set({ status: 'idle', workspace: null, lastEditedAt: 0 })
  },
}))
