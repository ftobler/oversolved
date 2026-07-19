import { useEffect } from 'react'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

// Warn on a hard browser exit (tab close, reload, external link) while the open
// document has unsaved edits. In-app navigation (the shared header links) is
// guarded separately via confirmDiscardUnsavedChanges; beforeunload is the only
// hook for leaving the SPA entirely. Clearing the flag on unmount stops a stale
// "dirty" from following the user onto other pages that share the header.
//
// Every document editor (part, assembly) must install this, otherwise it marks
// itself dirty without ever arming the browser-level guard. Shared so the two
// editors cannot drift apart.
export function useUnsavedChangesGuard(): void {
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useUnsavedChangesStore.getState().dirty) {
        e.preventDefault()
        e.returnValue = ''  // some browsers require returnValue to be set
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      useUnsavedChangesStore.getState().setDirty(false)
    }
  }, [])
}
