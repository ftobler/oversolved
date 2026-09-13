import { useEffect, useState, useSyncExternalStore } from 'react'
import { readWorkspaceMeta } from '@/workspace/idbCarrier'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'

// The open workspace's display name, for the breadcrumb's middle crumb. One
// meta read, re-read on every store mutation so a rename reaches the trail
// without the page knowing it happened.
//
// The returned name is gated on the workspace it was read for, the same guard
// usePreview uses: during the render where the route changes, the previous
// workspace's name is still in state, and returning it would flash the wrong
// name in the trail before the new read lands.
export function useWorkspaceName(workspace: string | undefined): string | undefined {
  const revision = useSyncExternalStore(subscribeWorkspaceStore, workspaceStoreRevision)
  const [state, setState] = useState<{ workspace: string | undefined; name: string | undefined }>(
    { workspace: undefined, name: undefined },
  )

  useEffect(() => {
    if (!workspace) return
    let cancelled = false
    readWorkspaceMeta(workspace)
      .then(meta => { if (!cancelled) setState({ workspace, name: meta?.name }) })
      // A workspace whose meta cannot be read still gets a trail; the crumb
      // falls back to its id rather than the whole header failing.
      .catch(() => { if (!cancelled) setState({ workspace, name: undefined }) })
    return () => { cancelled = true }
  }, [workspace, revision])

  return state.workspace === workspace ? state.name : undefined
}
