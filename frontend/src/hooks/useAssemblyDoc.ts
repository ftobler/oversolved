import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'
import type { AssemblyDoc } from '@/types/cad'
import { parseHttpError } from '@/utils/core/httpClient'
import { backendBundle } from '@/adapters/backend'
import { loadDocumentAnyDomain } from '@/adapters/documentLoad'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAssemblyStore } from '@/stores/assemblyStore'
import { mateFeatures, partInstances } from '@/utils/assemblyMutations'
import { ASSEMBLY_BUILTIN_DEFAULTS } from '@/utils/assemblyBuiltins'

export function useAssemblyDoc(uuid: string | undefined) {
  const [doc, setDoc] = useState<AssemblyDoc | null>(null)
  const [docName, setDocName] = useState<string>('')
  const [ownerUsername, setOwnerUsername] = useState<string>('')
  const docRef = useRef<AssemblyDoc | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [permission, setPermission] = useState<string>('owner')
  const [isCloudDoc, setIsCloudDoc] = useState(false)
  const storeRef = useRef(backendBundle.documents)

  useEffect(() => {
    if (!uuid) return
    let cancelled = false
    queueMicrotask(() => { if (!cancelled) setLoading(true) })
    loadDocumentAnyDomain(uuid)
      .then(({ data, store }) => {
        if (cancelled) return
        storeRef.current = store
        setIsCloudDoc(store === backendBundle.cloudDocuments)
        const parsed = (parseYaml(data.content) ?? {}) as AssemblyDoc
        // An empty assembly starts with its own Origin + 3 planes (its coordinate
        // frame), mirroring the part-editor empty-doc prepend but with assembly
        // built-ins so the assembly never inherits part built-ins.
        if (!parsed.features || parsed.features.length === 0) {
          parsed.features = ASSEMBLY_BUILTIN_DEFAULTS.map(f => ({ ...f }))
        }
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        setOwnerUsername(data.owner_username || '')
        setPermission(data.permission || 'owner')
        useUnsavedChangesStore.getState().setDirty(false)
        // A fresh document must not inherit the previous document's undo
        // history: Ctrl+Z in the new doc would otherwise restore the old one
        // into it, and a later save could write A's content under B's uuid.
        useAssemblyStore.getState().clearAssemblyHistory()
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(parseHttpError(e, 'Failed to load document'))
        // A failed load must not leave a previous document's history in the
        // module store: Ctrl+Z after the error would otherwise restore the old
        // document's content into the one that failed to load. Clearing on a
        // first mount with no prior doc is a harmless empty write.
        useAssemblyStore.getState().clearAssemblyHistory()
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [uuid])

  const instances = useMemo(() => partInstances(doc), [doc])

  // Feature id included: `mateResults` is keyed by it, so the tree cannot mark a
  // stale mate red without knowing which feature each row came from.
  const mates = useMemo(() => (doc ? mateFeatures(doc) : []), [doc])

  const saveDoc = useCallback(async (uuid: string, document: AssemblyDoc, screenshot?: () => Promise<string | null>) => {
    try {
      const body: { content: string; preview_image?: string } = { content: stringifyYaml(document) }
      if (screenshot) {
        const dataUrl = await screenshot()
        if (dataUrl) body.preview_image = dataUrl.split(',')[1]
      }
      await storeRef.current.save(uuid, body)
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

  const cloneDoc = useCallback(async (id: string): Promise<{ uuid: string }> => {
    return storeRef.current.clone(id)
  }, [])

  return {
    doc, setDoc, docRef, docName, setDocName, ownerUsername,
    loading, error, setError, permission, isCloudDoc,
    instances, mates,
    saveDoc, renameDoc, cloneDoc,
  }
}
