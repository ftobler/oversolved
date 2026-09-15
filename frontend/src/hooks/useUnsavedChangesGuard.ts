import { useEffect, useRef } from 'react'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

// Warn on a hard browser exit (tab close, reload, external link) while the open
// document has unsaved edits. In-app navigation (the shared header links) is
// guarded separately via confirmDiscardUnsavedChanges; beforeunload is the only
// hook for leaving the SPA entirely.
//
// The unmount takes the listener down and nothing else. It used to clear
// `dirty` as well, which meant any unmount that no dialog preceded -- an error
// branch, a route mismatch, a programmatic navigate -- dropped the edits and
// the flag that would have warned about them, in that order and in silence. An
// unmount is not an answer to the question. The flag is cleared where the
// question is answered (the guard dialog) or where the workspace is left
// (setWorkspace(null)).
//
// Every document editor (part, assembly) must install this, otherwise it marks
// itself dirty without ever arming the browser-level guard. Shared so the two
// editors cannot drift apart.
//
// Pass the editor's save function to also offer "Save & Exit" in the in-app
// confirm dialog; without it that dialog stays a discard-or-stay choice.
export function useUnsavedChangesGuard(save?: () => boolean | Promise<boolean>): void {
  // The registration is stable for the editor's whole life while the handler it
  // calls is re-read on every invocation: registering the raw callback would
  // re-publish the store on every doc change (the part editor's handleSave is a
  // fresh closure each render), and every AppHeader in the app would re-render
  // for it. The ref is written in an effect, not during render.
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })

  const hasSave = save != null
  useEffect(() => {
    if (!hasSave) return
    useUnsavedChangesStore.getState().setSaveHandler(() => saveRef.current!())
    return () => useUnsavedChangesStore.getState().setSaveHandler(null)
  }, [hasSave])

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (useUnsavedChangesStore.getState().dirty) {
        e.preventDefault()
        e.returnValue = ''  // some browsers require returnValue to be set
      }
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [])
}
