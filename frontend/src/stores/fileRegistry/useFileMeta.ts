import { useEffect, useState } from 'react'
import type { FileMeta } from './types'
import { toFileMeta } from './types'
import { getFileRegistry } from './index'
import { fileRegistryRevision, subscribeFileRegistry } from './events'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'
import type { WorkspaceEntry } from '@/workspace/types'

// The feature row's async view of a file record. `null` is "not resolved yet"
// (loading), 'missing' is a reference neither the open workspace nor the
// registry can satisfy or an import with no reference at all, which is the
// first user-visible surface of the C1 hole. Resolution is session-first: a STEP
// adopted from a folder/zip/.oversolved lives in the workspace, not the flat
// registry, so a workspace file entry names a real file where the registry
// would read "Missing file".
export function useFileMeta(fileId: string | undefined): FileMeta | 'missing' | null {
  // The fileId the stored value belongs to, so a changed id reads as loading
  // (null) until its own fetch lands, without a synchronous setState in an effect.
  const [state, setState] = useState<{ fileId: string | undefined; meta: FileMeta | 'missing' | null }>({
    fileId, meta: null,
  })
  const [revision, setRevision] = useState(fileRegistryRevision())
  const [workspaceRevision, setWorkspaceRevision] = useState(workspaceStoreRevision())
  const session = useWorkspaceSessionStore(s => s.session)

  useEffect(() => subscribeFileRegistry(() => setRevision(r => r + 1)), [])
  // A workspace write (a replace of the file's bytes, a rename) must refresh
  // the row like a registry change does.
  useEffect(() => subscribeWorkspaceStore(() => setWorkspaceRevision(r => r + 1)), [])

  useEffect(() => {
    let cancelled = false
    if (!fileId) return
    const load = async () => {
      if (session) {
        try {
          const entry = await session.readEntry(fileId)
          if (!cancelled && entry.kind === 'file') {
            setState({ fileId, meta: fileMetaOf(entry) })
            return
          }
        } catch {
          // Not a live workspace file entry: fall through to the flat registry.
        }
      }
      getFileRegistry().get(fileId).then(entry => {
        if (!cancelled) setState({ fileId, meta: entry ? toFileMeta(entry) : 'missing' })
      }).catch(() => {
        if (!cancelled) setState({ fileId, meta: 'missing' })
      })
    }
    void load()
    return () => { cancelled = true }
  }, [fileId, revision, workspaceRevision, session])

  // A missing reference is terminal, not loading: an import_step without a
  // file_id must not spin "Loading..." forever.
  if (!fileId) return 'missing'
  return state.fileId === fileId ? state.meta : null
}

// A workspace file entry carries no registry timestamps; the row only reads name
// and size, so the absent ones are zeroed rather than guessed at.
function fileMetaOf(entry: WorkspaceEntry): FileMeta {
  return {
    id: entry.id,
    name: entry.name,
    kind: entry.fileKind ?? 'step',
    mime: entry.mime ?? '',
    size: entry.bytes?.byteLength ?? 0,
    createdAt: 0,
    updatedAt: 0,
  }
}