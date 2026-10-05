import { useState, useRef, useEffect } from 'react'
import { parse as parseYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import { errorMessage } from '@/utils/core/errorMessage'
import { backendBundle } from '@/adapters/backend'
import { dropDeadAxisConstraints, migrateLegacyBodyPicks } from '@/utils/yamlMutations'
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
    saveDoc,
    renameDoc,
    cloneDoc,
  }
}
