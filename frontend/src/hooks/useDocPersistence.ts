import { useCallback, useRef } from 'react'
import { stringify as stringifyYaml } from 'yaml'
import { errorMessage } from '@/utils/core/errorMessage'
import { backendBundle } from '@/adapters/backend'
import { getPreviewStore } from '@/stores/previewStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'

// The persistence seam both editors share. saveDoc, renameDoc and cloneDoc plus
// the single-flight save chain were duplicated verbatim between
// useDocumentState and useAssemblyDoc, differing only in the document type. A
// concurrency fix in this chain (arrival-order landing, the identity-guarded
// dirty retention) is a write-integrity fix, so it must exist once, not once
// per editor where it can drift.
export interface DocPersistence<D> {
  saveDoc(uuid: string, document: D, screenshot?: () => Promise<string | null>): Promise<boolean>
  renameDoc(uuid: string, name: string): Promise<boolean>
  cloneDoc(id: string, name?: string): Promise<{ uuid: string }>
}

export function useDocPersistence<D>({
  docRef,
  setError,
  setDocName,
  workspace,
}: {
  docRef: React.MutableRefObject<D | null>
  setError: (error: string | null) => void
  setDocName: (name: string) => void
  workspace?: string
}): DocPersistence<D> {
  const store = backendBundle.documents

  // Single-flight chain for saves. Bytes are serialized per call from the doc
  // the caller hands over (the latest mutation's state), but a call landing
  // while another save is in flight must not race it to the store: without
  // gating, an older slow save can complete after a newer one and leave the
  // stored bytes behind the newer edits under dirty=false (review-18 ST-M1).
  // Chaining makes arrival order the landing order, so the latest bytes always
  // win, independent of the identity guard below.
  const saveChain = useRef<Promise<void>>(Promise.resolve())

  const saveDoc = useCallback(async (uuid: string, document: D, screenshot?: () => Promise<string | null>) => {
    const prior = saveChain.current
    let release!: () => void
    const mine = new Promise<void>(resolve => { release = resolve })
    saveChain.current = mine
    await prior
    try {
      try {
        // Reference at entry: every mutation installs a fresh doc object (never
        // edits in place), so identity still holding after the awaits below
        // proves no edit landed while the save was in flight.
        const savedRef = docRef.current
        // Previews live in their own store keyed by (workspace, entry). The
        // workspace is the route's id and the entry is the document uuid; the
        // reader (tiles, pickers) uses the same pair, so a multi-document
        // workspace paints the right thumbnail and purge clears it by prefix.
        if (screenshot) {
          const dataUrl = await screenshot()
          if (dataUrl) await getPreviewStore().put(workspace ?? uuid, uuid, dataUrl.split(',')[1])
        }
        await store.save(uuid, { content: stringifyYaml(document) })
        // The store now holds the latest edits, so there is nothing to warn
        // about. An edit during the save windows postdates the stored bytes
        // though: its dirty flag must survive, or a reload would silently drop
        // those edits.
        if (docRef.current === savedRef) {
          useUnsavedChangesStore.getState().setDirty(false)
        }
        return true
      } catch (e) {
        setError(errorMessage(e, 'Failed to save document'))
        return false
      }
    } finally {
      release()
    }
  }, [store, workspace, docRef, setError])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      await store.rename(uuid, name)
      setDocName(name)
      return true
    } catch (e) {
      setError(errorMessage(e, 'Failed to rename document'))
      return false
    }
  }, [store, setDocName, setError])

  const cloneDoc = useCallback(async (id: string, name?: string): Promise<{ uuid: string }> => {
    // Keep each caller's original call shape: the assembly path clones under the
    // stored name with a one-arg call, the part path forwards the user's name.
    // Passing an explicit undefined here would change the store call's arity and
    // the two seams have drifted before.
    return name === undefined ? store.clone(id) : store.clone(id, name)
  }, [store])

  return { saveDoc, renameDoc, cloneDoc }
}
