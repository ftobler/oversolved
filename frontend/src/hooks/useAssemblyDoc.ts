import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { AssemblyDoc } from '@/types/cad'
import { parseHttpError } from '@/utils/core/httpClient'
import { backendBundle } from '@/adapters/backend'

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
        const parsed = (parseYaml(data.content) ?? {}) as AssemblyDoc
        docRef.current = parsed
        setDoc(parsed)
        setDocName(data.name)
        setOwnerUsername(data.owner_username || '')
        setPermission(data.permission || 'owner')
        setLoading(false)
      })
      .catch(e => {
        if (cancelled) return
        setError(parseHttpError(e, 'Failed to load document'))
        setLoading(false)
      })
    return () => { cancelled = true }
  }, [uuid])

  const saveDoc = useCallback(async (document: AssemblyDoc, screenshot?: () => Promise<string | null>) => {
    try {
      const body: { content: string; preview_image?: string } = { content: stringifyYaml(document) }
      if (screenshot) {
        const dataUrl = await screenshot()
        if (dataUrl) {
          body.preview_image = dataUrl.split(',')[1]
        }
      }
      await storeRef.current.save(uuid!, body)
      return true
    } catch (e) {
      setError(parseHttpError(e, 'Failed to save document'))
      return false
    }
  }, [uuid])

  const renameDoc = useCallback(async (name: string) => {
    try {
      await storeRef.current.rename(uuid!, name)
      setDocName(name)
      return true
    } catch (e) {
      setError(parseHttpError(e, 'Failed to rename document'))
      return false
    }
  }, [uuid])

  const cloneDoc = useCallback(async (): Promise<{ uuid: string }> => {
    return storeRef.current.clone(uuid!)
  }, [uuid])

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
    isCloudDoc,
    saveDoc,
    renameDoc,
    cloneDoc,
  }
}
