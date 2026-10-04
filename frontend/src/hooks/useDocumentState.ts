import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import { errorMessage } from '@/utils/core/errorMessage'
import { backendBundle } from '@/adapters/backend'
import { getPreviewStore } from '@/stores/previewStore'
import { dropDeadAxisConstraints, migrateLegacyBodyPicks } from '@/utils/yamlMutations'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

export function useDocumentState(
  uuid: string | undefined,
  reSolveRef: React.MutableRefObject<((d: PartDoc) => void) | null>,
  { solveOnLoad = true, workspace }: { solveOnLoad?: boolean; workspace?: string } = {},
) {
  const [doc, setDoc] = useState<PartDoc | null>(null)
  const [docName, setDocName] = useState<string>('')
  const docRef = useRef<PartDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const store = backendBundle.documents

  useEffect(() => {
    if (!uuid) return
    // Guard against a superseded load: if the uuid changes while a load is in
    // flight, a slow prior resolution must not overwrite the newer doc. Mirrors
    // the listReqRef guard in Documents.tsx.
    let cancelled = false
    // A new load clears the previous failure: otherwise a stale error would keep
    // the terminal panel engaged even after a later load succeeds.
    setError(null)
    queueMicrotask(() => { if (!cancelled) setLoading(true) })
    store.load(uuid)
      .then(data => {
        if (cancelled) return
        const parsed = (parseYaml(data.content) ?? {}) as PartDoc
        if ((!parsed.kind || parsed.kind === 'part') && (!parsed.features || parsed.features.length === 0)) {
          parsed.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
        }
        // Self-heal stale documents authored before whole-entity axis constraints
        // were rejected at creation time. See dropDeadAxisConstraints.
        dropDeadAxisConstraints(parsed)
        // Self-heal docs authored before the transform/delete_body body pick was
        // pluralized: the singular `body` becomes a one-element `bodies` list so
        // the plural kernel read and the list mutators see the ref.
        migrateLegacyBodyPicks(parsed)
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        // Freshly loaded content matches its store; any self-heal above predates
        // user intent, so the document starts clean.
        useUnsavedChangesStore.getState().setDirty(false)
        setLoading(false)
        if (solveOnLoad && reSolveRef.current) {
          reSolveRef.current(parsed)
        }
      })
      .catch(e => {
        if (cancelled) return
        setError(errorMessage(e, 'Failed to load document'))
        // A failed load must not leave the previous document on screen under the
        // new uuid's route: the editor would render the old doc as if it were the
        // one that failed. Null it so the page can show a terminal panel instead.
        docRef.current = null
        setDoc(null)
        setDocName('')
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [uuid, solveOnLoad, reSolveRef, store])

  // Single-flight chain for saves. Bytes are serialized per call from the doc
  // the caller hands over (the latest mutation's state), but a call landing
  // while another save is in flight must not race it to the store: without
  // gating, an older slow save can complete after a newer one and leave the
  // stored bytes behind the newer edits under dirty=false (review-18 ST-M1).
  // Chaining makes arrival order the landing order, so the latest bytes always
  // win, independent of the identity guard below.
  const saveChain = useRef<Promise<void>>(Promise.resolve())

  const saveDoc = useCallback(async (uuid: string, document: PartDoc, screenshot?: () => Promise<string | null>) => {
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
        // The store now holds the latest edits, so there is nothing to warn about.
        // An edit during the save windows postdates the stored bytes though: its
        // dirty flag must survive, or a reload would silently drop those edits.
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
  }, [store, workspace])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      await store.rename(uuid, name)
      setDocName(name)
      return true
    } catch (e) {
      setError(errorMessage(e, 'Failed to rename document'))
      return false
    }
  }, [store])

  const cloneDoc = useCallback(async (id: string, name?: string): Promise<{ uuid: string }> => {
    return store.clone(id, name)
  }, [store])

  return {
    doc,
    setDoc,
    docRef,
    docName,
    setDocName,
    loading,
    error,
    setError,
    saveDoc,
    renameDoc,
    cloneDoc,
  }
}
