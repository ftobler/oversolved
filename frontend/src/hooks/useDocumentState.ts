import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc } from '@/types/cad'
import { parseHttpError } from '@/utils/core/httpClient'
import { backendBundle } from '@/adapters/backend'
import { dropDeadAxisConstraints } from '@/utils/yamlMutations'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { BUILTIN_FEATURE_DEFAULTS } from '@/utils/builtins'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

export function useDocumentState(
  uuid: string | undefined,
  reSolveRef: React.MutableRefObject<((d: PartDoc) => void) | null>,
  { solveOnLoad = true }: { solveOnLoad?: boolean } = {},
) {
  const [doc, setDoc] = useState<PartDoc | null>(null)
  const [docName, setDocName] = useState<string>('')
  const [ownerUsername, setOwnerUsername] = useState<string>('')
  const docRef = useRef<PartDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<string>('owner')
  const [isPublic, setIsPublic] = useState(false)
  // True when the open document was resolved from the cloud domain. Sharing is a
  // cloud-only concept, so the share UI uses this to refuse a local-only doc
  // instead of issuing a guaranteed-404 request for a uuid the server never minted.
  const [isCloudDoc, setIsCloudDoc] = useState(false)
  // The store the open document was resolved from (its domain). Edits go back to
  // the SAME domain, so save/rename target this rather than assuming local home.
  const storeRef = useRef(backendBundle.documents)

  useEffect(() => {
    if (!uuid) return
    // Guard against a superseded load: if the uuid changes while a load is in
    // flight, a slow prior resolution must not overwrite the newer doc or, worse,
    // point storeRef at the wrong domain (a later save would target it). Mirrors
    // the listReqRef guard in Documents.tsx.
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) setLoading(true) })
    // Two domains (doc-domain-move): prefer the local home copy, fall back to the
    // cloud domain when the uuid lives there (e.g. a server document not yet pulled
    // local). Whichever store answers becomes the save/rename target. The resolving
    // store is committed to storeRef only in the guarded .then below, never inside
    // this async fn, so a stale load cannot corrupt the save target.
    const loadFromDomain = async (): Promise<{ data: Awaited<ReturnType<typeof backendBundle.documents.load>>; store: typeof backendBundle.documents }> => {
      try {
        const data = await backendBundle.documents.load(uuid)
        return { data, store: backendBundle.documents }
      } catch (localErr) {
        const cloud = backendBundle.cloudDocuments
        if (!cloud) throw localErr
        const data = await cloud.load(uuid)
        return { data, store: cloud }
      }
    }
    loadFromDomain()
      .then(({ data, store }) => {
        if (cancelled) return
        storeRef.current = store
        setIsCloudDoc(store === backendBundle.cloudDocuments)
        const parsed = (parseYaml(data.content) ?? {}) as PartDoc
        if ((!parsed.kind || parsed.kind === 'part') && (!parsed.features || parsed.features.length === 0)) {
          parsed.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
        }
        // Self-heal stale documents authored before whole-entity axis constraints
        // were rejected at creation time. See dropDeadAxisConstraints.
        dropDeadAxisConstraints(parsed)
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        setOwnerUsername(data.owner_username || '')
        setPermission(data.permission || 'owner')
        setIsPublic(data.is_public || false)
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
        setError(parseHttpError(e, 'Failed to load document'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [uuid, solveOnLoad, reSolveRef])

  const saveDoc = useCallback(async (uuid: string, document: PartDoc, screenshot?: () => Promise<string | null>) => {
    try {
      const body: { content: string; preview_image?: string } = { content: stringifyYaml(document) }
      if (screenshot) {
        const dataUrl = await screenshot()
        if (dataUrl) {
          body.preview_image = dataUrl.split(',')[1]
        }
      }
      await storeRef.current.save(uuid, body)
      // The store now holds the latest edits, so there is nothing to warn about.
      useUnsavedChangesStore.getState().setDirty(false)
      return true
    } catch (e) {
      setError(parseHttpError(e, 'Failed to save document'))
      return false
    }
  }, [])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      await storeRef.current.rename(uuid, name)
      setDocName(name)
      return true
    } catch (e) {
      setError(parseHttpError(e, 'Failed to rename document'))
      return false
    }
  }, [])

  // Clone the open document into the caller's library, via the SAME store it was
  // resolved from (a cloud doc clones server-side; a local doc copies locally).
  // Routing through storeRef fixes the cross-domain case the old build-flag fork
  // got wrong: on the HTTP build a LOCAL doc must not hit the server clone route.
  const cloneDoc = useCallback(async (id: string): Promise<{ uuid: string }> => {
    return storeRef.current.clone(id)
  }, [])

  return {
    doc,
    setDoc,
    docRef,
    docName,
    setDocName,
    ownerUsername,
    loading,
    error,
    setError,
    permission,
    isPublic,
    isCloudDoc,
    saveDoc,
    renameDoc,
    cloneDoc,
  }
}
