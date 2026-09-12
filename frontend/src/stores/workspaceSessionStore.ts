import { create } from 'zustand'
import type { WorkspaceSession } from '@/workspace/session'

// The one open workspace session, set by WorkspacePage on open and cleared when
// it unmounts. Editors and the solve relay read it; the grid never does. Keeping
// it as state (rather than a module variable) is what lets a scoped consumer
// re-read after a route change.
interface WorkspaceSessionState {
  session: WorkspaceSession | null
  setSession: (session: WorkspaceSession) => void
  clearSession: (workspace: string) => void
}

export const useWorkspaceSessionStore = create<WorkspaceSessionState>((set, get) => ({
  session: null,
  setSession: session => set({ session }),
  clearSession: workspace => {
    // Only the workspace that owns the live session may clear it: an unmount of
    // a superseded page must not blank the session a newer page just installed.
    if (get().session?.workspace === workspace) set({ session: null })
  },
}))
