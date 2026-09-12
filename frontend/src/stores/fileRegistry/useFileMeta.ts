import { useEffect, useState } from 'react'
import type { FileMeta } from './types'
import { toFileMeta } from './types'
import { getFileRegistry } from './index'
import { fileRegistryRevision, subscribeFileRegistry } from './events'

// The feature row's async view of a registry record. `null` is "not resolved
// yet" (loading), 'missing' is a reference the registry cannot satisfy or an
// import with no reference at all, which is the first user-visible surface of
// the C1 hole.
export function useFileMeta(fileId: string | undefined): FileMeta | 'missing' | null {
  // The fileId the stored value belongs to, so a changed id reads as loading
  // (null) until its own fetch lands, without a synchronous setState in an effect.
  const [state, setState] = useState<{ fileId: string | undefined; meta: FileMeta | 'missing' | null }>({
    fileId, meta: null,
  })
  const [revision, setRevision] = useState(fileRegistryRevision())

  useEffect(() => subscribeFileRegistry(() => setRevision(r => r + 1)), [])

  useEffect(() => {
    let cancelled = false
    if (!fileId) return
    getFileRegistry().get(fileId).then(entry => {
      if (!cancelled) setState({ fileId, meta: entry ? toFileMeta(entry) : 'missing' })
    }).catch(() => {
      if (!cancelled) setState({ fileId, meta: 'missing' })
    })
    return () => { cancelled = true }
  }, [fileId, revision])

  // A missing reference is terminal, not loading: an import_step without a
  // file_id must not spin "Loading..." forever.
  if (!fileId) return 'missing'
  return state.fileId === fileId ? state.meta : null
}
