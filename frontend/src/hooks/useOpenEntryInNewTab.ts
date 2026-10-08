import { useCallback } from 'react'
import { useHref } from 'react-router-dom'

// Opens a workspace entry in a new browser tab. A new tab is a full page load
// that bypasses the router, so the URL has to carry the router basename (the
// deploy base, `/oversolved/` on GitHub Pages) itself; useHref is what adds it.
// A bare `/workspaces/...` would open the host root instead of the app.
export function useOpenEntryInNewTab(workspaceId: string): (entryId: string) => void {
  const workspaceHref = useHref(`/workspaces/${workspaceId}`)
  return useCallback((entryId: string) => {
    window.open(`${workspaceHref}/entries/${entryId}`, '_blank')
  }, [workspaceHref])
}
