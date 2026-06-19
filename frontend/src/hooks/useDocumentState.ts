import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, PartFeature } from '@/types/cad'
import { backendBundle } from '@/adapters/backend'

export const BUILTIN_FEATURE_DEFAULTS: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top',    kind: 'plane' },
  { id: 'Front',  kind: 'plane' },
  { id: 'Right',  kind: 'plane' },
]

export const BUILTIN_FEATURE_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

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
  // The store the open document was resolved from (its domain). Edits go back to
  // the SAME domain, so save/rename target this rather than assuming local home.
  const storeRef = useRef(backendBundle.documents)

  useEffect(() => {
    if (!uuid) return
    queueMicrotask(() => setLoading(true))
    // Two domains (doc-domain-move): prefer the local home copy, fall back to the
    // cloud domain when the uuid lives there (e.g. a server document not yet pulled
    // local). Whichever store answers becomes the save/rename target.
    const loadFromDomain = async () => {
      try {
        const data = await backendBundle.documents.load(uuid)
        storeRef.current = backendBundle.documents
        return data
      } catch (localErr) {
        const cloud = backendBundle.cloudDocuments
        if (!cloud) throw localErr
        const data = await cloud.load(uuid)
        storeRef.current = cloud
        return data
      }
    }
    loadFromDomain()
      .then(data => {
        const parsed = (parseYaml(data.content) ?? {}) as PartDoc
        if (!parsed.features || parsed.features.length === 0) {
          parsed.features = BUILTIN_FEATURE_DEFAULTS.map(f => ({ ...f }))
        }
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        setOwnerUsername(data.owner_username || '')
        setPermission(data.permission || 'owner')
        setIsPublic(data.is_public || false)
        setLoading(false)
        if (solveOnLoad && reSolveRef.current) {
          reSolveRef.current(parsed)
        }
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
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
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      await storeRef.current.rename(uuid, name)
      setDocName(name)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
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
    saveDoc,
    renameDoc,
  }
}
