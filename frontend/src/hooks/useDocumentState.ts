import { useState, useCallback, useRef, useEffect } from 'react'
import { parse as parseYaml } from 'yaml'
import { stringify as stringifyYaml } from 'yaml'
import type { PartDoc, PartFeature } from '@/types/cad'
import { http } from '@/utils/httpClient'

export const BUILTIN_FEATURE_DEFAULTS: PartFeature[] = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top',    kind: 'plane' },
  { id: 'Front',  kind: 'plane' },
  { id: 'Right',  kind: 'plane' },
]

export const BUILTIN_FEATURE_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

export function healDoc(raw: unknown): PartDoc {
  const doc = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const userFeatures = Array.isArray(doc.features) ? (doc.features as PartFeature[]) : []
  const existingIds = new Set(userFeatures.map(f => f.id))
  const missingBuiltins = BUILTIN_FEATURE_DEFAULTS.filter(f => !existingIds.has(f.id))
  return {
    ...doc,
    version:  (doc.version as number) ?? 1,
    kind:     (doc.kind    as string) ?? 'part',
    features: [...missingBuiltins, ...userFeatures],
  } as PartDoc
}

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

  useEffect(() => {
    if (!uuid) return
    queueMicrotask(() => setLoading(true))
    http.getJson<{ content: string; name: string; owner_username?: string; permission?: string; is_public?: boolean }>(`/api/documents/${uuid}`)
      .then(data => {
        const parsed = healDoc(parseYaml(data.content))
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
      await http.putJson(`/api/documents/${uuid}`, body)
      return true
    } catch (e) {
      setError(String(e))
      return false
    }
  }, [])

  const renameDoc = useCallback(async (uuid: string, name: string) => {
    try {
      await http.patchJson(`/api/documents/${uuid}`, { name })
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
