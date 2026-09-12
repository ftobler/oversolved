import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import Dialog from '@/components/dialogs/Dialog'
import { getWorkspaceStore } from '@/workspace/store'
import { EntryReferencedError, type EntryReferrer } from '@/workspace/errors'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'
import type { WorkspaceSession } from '@/workspace/session'
import type { EntryMeta } from '@/workspace/types'
import { formatBytes } from '@/utils/formatBytes'
import { fileKindOf, fileSizeOf, orphanFileIds, referrersOf } from './filesModel'
import { useOrigin, useWhereUsed } from './filesSeams'
import { dropWorkerFileId } from '@/kernel/worker/workerFiles'

const EMPTY_ENTRIES: EntryMeta[] = []

// U3: the archive manager. It lists the workspace's file entries with size,
// where-used and origin, and offers the explicit replace-bytes and prune
// gestures. The two C5/C6 seams live in filesSeams.ts: C5 replaces useWhereUsed
// with its index, C6 fills useOrigin's record with rev, hash and status.
export function FilesPanel() {
  const session = useWorkspaceSessionStore(s => s.session)
  const revision = useSyncExternalStore(subscribeWorkspaceStore, workspaceStoreRevision)
  const [loadedEntries, setLoadedEntries] = useState<EntryMeta[]>([])
  const [pruneOpen, setPruneOpen] = useState(false)
  const [blocked, setBlocked] = useState<EntryReferrer[] | null>(null)
  const store = getWorkspaceStore()

  useEffect(() => {
    if (!session) return
    let cancelled = false
    session.listEntries()
      .then(list => { if (!cancelled) setLoadedEntries(list) })
      .catch(() => { if (!cancelled) setLoadedEntries(EMPTY_ENTRIES) })
    return () => { cancelled = true }
  }, [session, revision])

  const entries = session ? loadedEntries : EMPTY_ENTRIES
  const files = useMemo(() => entries.filter(entry => entry.kind === 'file'), [entries])
  const byId = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries])
  const { inverse, ready } = useWhereUsed(session, entries)
  // The orphan verdict is withheld until the reference scan resolves. Otherwise
  // a referenced file would render as an orphan and expose the prune action in
  // the window between listing and the last sequential referencesOf read.
  const orphans = useMemo(
    () => (ready ? orphanFileIds(files, inverse) : []).map(id => byId.get(id)).filter((entry): entry is EntryMeta => entry !== undefined),
    [ready, files, inverse, byId],
  )

  const handlePrune = async () => {
    if (!session) return
    // The guard is a second, independent check. Orphans have zero referrers by
    // construction, but if a race made one referenced between the scan and the
    // delete, the store refuses and prune surfaces it rather than deleting.
    for (const orphan of orphans) {
      try {
        await store.removeEntry(session.workspace, orphan.id)
      } catch (e) {
        if (e instanceof EntryReferencedError) {
          setPruneOpen(false)
          setBlocked(e.referrers)
          return
        }
        throw e
      }
    }
    setPruneOpen(false)
  }

  return (
    <div className="files-panel">
      <div className="sidebar-header">
        <span>Files</span>
        {ready && orphans.length > 0 && (
          <button
            type="button"
            className="files-prune-btn"
            aria-label="Prune orphans"
            title="Prune orphans"
            onClick={() => setPruneOpen(true)}
          >
            <span className="material-icons">delete_sweep</span>
          </button>
        )}
      </div>
      {files.length === 0 && <div className="empty">No files yet.</div>}
      <ul className="files-list" role="list" aria-label="Files">
        {files.map(file => (
          <FileRow
            key={file.id}
            session={session}
            file={file}
            referrers={ready
              ? referrersOf(inverse, file.id).map(id => byId.get(id)).filter((entry): entry is EntryMeta => entry !== undefined)
              : []}
            orphan={ready && orphans.some(orphan => orphan.id === file.id)}
          />
        ))}
      </ul>

      <Dialog
        isOpen={pruneOpen}
        title="Prune Orphans"
        onClose={() => setPruneOpen(false)}
        onConfirm={() => { void handlePrune() }}
        confirmLabel="Prune"
      >
        <p>
          Pruning moves these file entries and their bytes to the workspace trash, where they stay
          recoverable until the workspace is purged. It does not preserve the in-memory history of
          the documents that referenced them: their editor undo and redo steps can no longer restore
          the payload.
        </p>
        <ul className="prune-list">
          {orphans.map(orphan => (
            <li key={orphan.id}>{orphan.name} ({formatBytes(fileSizeOf(orphan))})</li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        isOpen={blocked !== null}
        title="Cannot Prune"
        onClose={() => setBlocked(null)}
      >
        <p>An entry is still referenced and was not pruned. Remove the reference first.</p>
        <ul className="where-used-list">
          {blocked?.map(referrer => <li key={referrer.id}>{referrer.name}</li>)}
        </ul>
      </Dialog>
    </div>
  )
}

interface FileRowProps {
  session: WorkspaceSession | null
  file: EntryMeta
  referrers: EntryMeta[]
  orphan: boolean
}

function FileRow({ session, file, referrers, orphan }: FileRowProps) {
  const origin = useOrigin(session, file.id)
  const [replacing, setReplacing] = useState(false)

  const handleReplace = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const chosen = e.target.files?.[0]
    e.target.value = ''
    if (!chosen || !session) return
    setReplacing(true)
    try {
      const bytes = new Uint8Array(await chosen.arrayBuffer())
      const current = await session.readEntry(file.id)
      await session.writeEntry({ ...current, bytes })
      // The solver worker still holds the replaced id's old bytes; drop it so
      // the next solve re-reads the fresh payload from the workspace entry.
      dropWorkerFileId(file.id)
    } finally {
      setReplacing(false)
    }
  }

  return (
    <li className="file-item">
      <div className="file-item-title">
        <span className="file-name" title={file.name}>{file.name}</span>
        <span className="file-kind">{fileKindOf(file)}</span>
        <span className="file-size">{formatBytes(fileSizeOf(file))}</span>
        <label className="file-replace-btn" title="Replace bytes">
          <input type="file" className="file-replace-input" onChange={e => { void handleReplace(e) }} disabled={replacing} />
          <span className="material-icons">upload_file</span>
        </label>
      </div>
      <div className="file-referrers">
        {orphan ? (
          <span className="file-orphan-label">orphan, {formatBytes(fileSizeOf(file))}</span>
        ) : (
          referrers.map(referrer => <span key={referrer.id} className="file-referrer">{referrer.name}</span>)
        )}
      </div>
      <div className="file-origin">{origin ? origin.origin : 'No origin'}</div>
    </li>
  )
}
