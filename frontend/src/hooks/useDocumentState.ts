import { useState, useRef, useEffect } from 'react'
import type { PartDoc } from '@/types/cad'
import { errorMessage } from '@/utils/core/errorMessage'
import { backendBundle } from '@/adapters/backend'
import { docLoadErrorMessage, loadPartDocText, type DocLoadError } from '@/persistence/docSchema'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'
import { useDocPersistence } from '@/hooks/useDocPersistence'

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
  // A validation failure keeps its structured report (field, raw text) so the
  // page can offer a read-only view or a raw export instead of dropping the
  // document. Only the loader's own failures set it; a store failure has no
  // document to show.
  const [loadFailure, setLoadFailure] = useState<DocLoadError | null>(null)
  const store = backendBundle.documents

  useEffect(() => {
    if (!uuid) return
    // Guard against a superseded load: if the uuid changes while a load is in
    // flight, a slow prior resolution must not overwrite the newer doc. Mirrors
    // the listReqRef guard in Documents.tsx.
    let cancelled = false
    // A new load clears the previous failure: otherwise a stale error would keep
    // the terminal panel engaged even after a later load succeeds.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing the stale failure synchronously at load start is the intended external-sync boundary
    setError(null)
    queueMicrotask(() => { if (!cancelled) setLoading(true) })
    store.load(uuid)
      .then(data => {
        if (cancelled) return
        // One gate for every stored document: parse, migrate and validate. A
        // legacy doc is healed by the ladder before the checks see it, and a
        // document the checks refuse never reaches the tree or the solver.
        const loaded = loadPartDocText(data.content, { name: data.name })
        if (!loaded.ok) {
          setError(docLoadErrorMessage(loaded.error))
          setLoadFailure(loaded.error)
          docRef.current = null
          setDoc(null)
          setDocName('')
          setLoading(false)
          return
        }
        const parsed = loaded.doc
        // An empty document gets its own coordinate frame; the loader does not
        // seed policy, so an editor still opens every fresh part the same way.
        if (!parsed.features || parsed.features.length === 0) {
          parsed.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
        }
        docRef.current = parsed
        setDoc(parsed)
        setLoadFailure(null)
        setDocName(data.name)
        // Freshly loaded content matches its store; any self-heal above predates
        // user intent, so the document starts clean, with nothing pinned from
        // the document it replaces.
        useUnsavedChangesStore.getState().clearForNewDocument()
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

  const { saveDoc, renameDoc, cloneDoc } = useDocPersistence<PartDoc>({
    docRef, setError, setDocName, workspace,
  })

  return {
    doc,
    setDoc,
    docRef,
    docName,
    setDocName,
    loading,
    error,
    setError,
    loadFailure,
    setLoadFailure,
    saveDoc,
    renameDoc,
    cloneDoc,
  }
}
