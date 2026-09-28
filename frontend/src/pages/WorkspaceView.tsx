import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import ExportDialog, { type ExportFormat } from '@/components/dialogs/ExportDialog'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import { LoadingState } from '@/components/shared/LoadingState'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import { formatBytes } from '@/utils/formatBytes'
import { errorMessage } from '@/utils/core/errorMessage'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { randomUuid } from '@/utils/randomUuid'
import { EmptyExportError } from '@/utils/partExport'
import { getWorkspaceStore, type WorkspaceSummary } from '@/workspace/store'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { deserializeTree } from '@/workspace/serializer'
import { EntryReferencedError, type EntryReferrer } from '@/workspace/errors'
import { createWorkspaceSession } from '@/workspace/session'
import { importPickedFile } from '@/workspace/importFile'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'
import { dirtyEntryIds, groupEntries } from '@/components/layout/workspaceTreeModel'
import { useWhereUsed } from '@/components/layout/filesSeams'
import { fileSizeOf, orphanFileIds, referrersOf } from '@/components/layout/filesModel'
import { originState, updateFromOrigin, type OriginStatus } from '@/workspace/import'
import { dropWorkerFileId } from '@/kernel/worker/workerFiles'
import type { EntryMeta, ProvenanceRecord } from '@/workspace/types'
import EntryRow from '@/pages/WorkspaceEntryRow'
import { downloadDocumentEntry, downloadFileEntry, entryExportFormats } from '@/pages/workspaceEntryExport'
import '@/pages/Documents.css'
import '@/pages/WorkspaceView.css'

// The middle level: one workspace, its identity on the left and its entries on
// the right. It is deliberately the library's own two-column shell with the two
// halves swapped in kind -- the identity card keeps the tile's vertical
// arrangement so it reads as "one of the things from the library, enlarged",
// and the entries are a LIST of rows rather than a grid of tiles, which is the
// whole distinction between this level and the one above it.
//
// A row is the library tile on its side: the same preview and the same verbs,
// with the name, properties and controls to the right of the thumb instead of
// below it. That is what gives a part a thumbnail again -- the tree row this
// replaces had nowhere to put one.
const EMPTY_ENTRIES: EntryMeta[] = []
const EMPTY_REVS = new Map<string, number>()
const EMPTY_PROVENANCE: ProvenanceRecord[] = []
const EMPTY_STATUSES = new Map<string, OriginStatus>()
const EMPTY_KEYS: ReadonlySet<string> = new Set()

export default function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const session = useWorkspaceSessionStore(s => s.session)
  const revision = useSyncExternalStore(subscribeWorkspaceStore, workspaceStoreRevision)
  const navigate = useNavigate()
  const store = getWorkspaceStore()

  // `null` is "not loaded yet", which is NOT the same as "empty": starting at []
  // painted "This workspace is empty." over a nameless 0-byte card on every open,
  // until two IDB round-trips resolved.
  const [loaded, setLoaded] = useState<{ workspace: string; entries: EntryMeta[]; savedRevs: Map<string, number>; summary: WorkspaceSummary | null; provenance: ProvenanceRecord[] } | null>(null)
  // Errors from a verb that owns a dialog belong inside that dialog: the banner
  // renders in the main column, which the open modal covers.
  //
  // Both are tagged with the workspace they were raised under, and that tag is
  // what clears them: a banner names a workspace, so carrying it to the next one
  // would blame the wrong workspace for a failure it had nothing to do with. An
  // effect that reset them on workspaceId could only do so after the new
  // workspace had already painted the old message once.
  const [errors, setErrors] = useState<{ workspace: string | undefined; banner: string | null; dialog: string | null }>(
    { workspace: workspaceId, banner: null, dialog: null },
  )
  const raised = errors.workspace === workspaceId ? errors : null
  const error = raised?.banner ?? null
  const dialogError = raised?.dialog ?? null
  const setError = (message: string | null) =>
    setErrors(prev => ({ workspace: workspaceId, banner: message, dialog: prev.workspace === workspaceId ? prev.dialog : null }))
  const setDialogError = (message: string | null) =>
    setErrors(prev => ({ workspace: workspaceId, banner: prev.workspace === workspaceId ? prev.banner : null, dialog: message }))
  // The kind of the document being added, fixed by the header button that
  // opened the dialog; null while the dialog is closed.
  const [addKind, setAddKind] = useState<'part' | 'assembly' | null>(null)
  const [newName, setNewName] = useState('')
  // The document row whose export dialog is open. A file row never lands here:
  // its bytes are the export, so it downloads on the click.
  const [exportTarget, setExportTarget] = useState<EntryMeta | null>(null)
  const [renameTarget, setRenameTarget] = useState<EntryMeta | null>(null)
  const [renameName, setRenameName] = useState('')
  const [wsRenameOpen, setWsRenameOpen] = useState(false)
  const [wsRenameName, setWsRenameName] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  // The delete guard's presentation: the typed refusal with the live referrers
  // it named, held until the user acknowledges or jumps to one.
  const [referenced, setReferenced] = useState<{ entry: EntryMeta; referrers: EntryReferrer[] } | null>(null)
  const [pruneOpen, setPruneOpen] = useState(false)
  // The prune guard's refusal: the store found a referrer the scan had not, so
  // the sweep stopped and names it rather than deleting the rest silently.
  const [pruneBlocked, setPruneBlocked] = useState<EntryReferrer[] | null>(null)
  // What the explicit check answered, stamped with the workspace AND the store
  // revision it answered for, because both can invalidate it. A status is a
  // claim about how the local copy compares to its source, so any write to the
  // workspace (this view's own pull included, which rewrites the whole closure
  // and not just the clicked row) can make it false, and another workspace's
  // rows were never in the answer at all. Stale either way, the row says "Not
  // checked" rather than a comparison nobody made.
  const [checked, setChecked] = useState<{ workspace: string | undefined; revision: number; statuses: Map<string, OriginStatus> }>(
    { workspace: workspaceId, revision, statuses: EMPTY_STATUSES },
  )
  // The row whose delete is in flight. The store round-trip can be slow enough
  // that a second click lands, and a double delete is not idempotent at this
  // layer, so the row's own button goes disabled until it settles. A Set rather
  // than one id, so a delete on one row cannot re-enable another's.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  // The verbs in flight, tagged with the workspace they were started on like
  // the errors and the check statuses are. The per-entry keys carry a uuid and
  // could never collide, but the workspace-wide ones (check, prune, rename,
  // duplicate, export, trash, add) are bare: a duplicate navigates to the new
  // workspace without unmounting this view, so an untagged set left the NEW
  // workspace's controls disabled until the OLD workspace's verb settled.
  const [inFlight, setInFlight] = useState<{ workspace: string | undefined; keys: ReadonlySet<string> }>(
    { workspace: workspaceId, keys: EMPTY_KEYS },
  )
  const busy = inFlight.workspace === workspaceId ? inFlight.keys : EMPTY_KEYS
  // The load A failed state, kept apart from the dismissible error banner: the
  // spinner must not come back when the banner is dismissed, and a retry has to
  // be reachable. `attempt` is what re-runs the effect.
  const [loadFailed, setLoadFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // The session is installed by the page above, whose effect runs AFTER this
  // one; and a same-route navigation (duplicate) swaps workspaceId while the
  // old session is still bound. Reading either without checking they agree put
  // one workspace's rows under another's identity card -- and a row click then
  // built a route from an id the new workspace does not have. Same identity
  // guard as useWorkspaceName and filesSeams.
  useEffect(() => {
    if (!session || !workspaceId || session.workspace !== workspaceId) return
    let cancelled = false
    const load = async () => {
      setLoadFailed(false)
      try {
        const [entries, savedRevs, all, provenance] = await Promise.all([
          session.listEntries(),
          session.savedRevs(),
          store.list(),
          // A stored read, not a resolver read: the row can name its source and
          // say whether the local copy drifted without touching it (I2).
          session.provenance(),
        ])
        if (cancelled) return
        setLoaded({ workspace: workspaceId, entries, savedRevs, summary: all.find(row => row.workspace === workspaceId) ?? null, provenance })
      } catch (e) {
        if (!cancelled) {
          setErrors({ workspace: workspaceId, banner: errorMessage(e, 'Failed to read this workspace'), dialog: null })
          // Drop any prior workspace's rows too: under the banner they would
          // read as this workspace's current content.
          setLoaded(null)
          setLoadFailed(true)
        }
      }
    }
    void load()
    return () => { cancelled = true }
  }, [session, workspaceId, revision, store, attempt])

  const ready = loaded !== null && loaded.workspace === workspaceId
  const entries = ready ? loaded.entries : EMPTY_ENTRIES
  const savedRevs = ready ? loaded.savedRevs : EMPTY_REVS
  const summary = ready ? loaded.summary : null

  const stored = ready ? loaded.provenance : EMPTY_PROVENANCE
  const statuses = checked.workspace === workspaceId && checked.revision === revision
    ? checked.statuses
    : EMPTY_STATUSES

  const grouped = useMemo(() => groupEntries(entries), [entries])
  const dirty = useMemo(() => dirtyEntryIds(entries, savedRevs), [entries, savedRevs])
  const byId = useMemo(() => new Map(entries.map(entry => [entry.id, entry])), [entries])
  // Only the records that still have an entry to sit on. A record outlives the
  // copy it describes (deleting the local entry leaves it in the manifest), and
  // one of those has no row, so checking it would resolve a source for
  // something the user cannot see and would leave the card offering a check on
  // a workspace that shows no origin at all.
  const origins = useMemo(
    () => new Map(stored.filter(record => byId.has(record.entry)).map(record => [record.entry, record])),
    [stored, byId],
  )
  const { inverse, ready: scanned } = useWhereUsed(session, entries)
  const referrerNames = useMemo(() => {
    const names = new Map<string, string[]>()
    for (const entry of entries) {
      const refs = referrersOf(inverse, entry.id)
        .map(id => byId.get(id)?.name)
        .filter((name): name is string => name !== undefined)
      if (refs.length > 0) names.set(entry.id, refs)
    }
    return names
  }, [entries, byId, inverse])
  // The orphan verdict is withheld until the reference scan resolves: before it
  // does, every file has zero known referrers, so the card would offer to sweep
  // away files that are in use.
  const orphans = useMemo(
    () => (scanned ? orphanFileIds(grouped.files, inverse) : [])
      .map(id => byId.get(id))
      .filter((entry): entry is EntryMeta => entry !== undefined),
    [scanned, grouped.files, inverse, byId],
  )

  const openEntry = (entry: EntryMeta) => {
    // A file is not a document: opening one would land on the entry route,
    // which refuses it by name and strands the user on an error page (J9).
    // Files are listed here because the archive is the thing you ship, not
    // because they are openable.
    if (!workspaceId || entry.kind !== 'document') return
    const target = `/workspaces/${workspaceId}/entries/${entry.id}`
    if (confirmDiscardUnsavedChanges(() => navigate(target))) navigate(target)
  }

  // Every verb reports its own failure. The tree this replaces had six
  // uncaught handlers and no error surface at all, so a refused rename or a
  // failed duplicate was an invisible no-op.
  // `into` picks the surface: a verb that owns a dialog reports inside it, the
  // rest report in the banner. Nothing rethrows -- every caller is a `void`, so
  // an escaping rejection would be unhandled rather than shown.
  const run = async (what: string, action: () => Promise<void>, into: 'banner' | 'dialog' = 'banner') => {
    const report = into === 'dialog' ? setDialogError : setError
    try {
      report(null)
      await action()
    } catch (e) {
      report(errorMessage(e, what))
    }
  }

  // A long verb keeps its own key busy, so its control goes disabled and no
  // second duplicate, add or rename can start while one is in flight.
  const runBusy = async (key: string, what: string, action: () => Promise<void>, into: 'banner' | 'dialog' = 'banner') => {
    // The workspace the verb was started on, not the one that is current when
    // it settles: releasing the key under a workspace the verb never ran on
    // would write the old set onto the new workspace's tag.
    const startedOn = workspaceId
    setInFlight(prev => ({
      workspace: startedOn,
      keys: new Set(prev.workspace === startedOn ? prev.keys : []).add(key),
    }))
    try {
      await run(what, action, into)
    } finally {
      setInFlight(prev => {
        if (prev.workspace !== startedOn) return prev
        const keys = new Set(prev.keys)
        keys.delete(key)
        return { workspace: startedOn, keys }
      })
    }
  }

  const handleAdd = () => runBusy('add', 'Failed to add the entry', async () => {
    if (!workspaceId || !addKind || !newName.trim()) return
    const id = randomUuid()
    await store.addEntry(workspaceId, { id, kind: 'document', name: newName.trim(), docKind: addKind, text: '' })
    setAddKind(null)
    setNewName('')
    const target = `/workspaces/${workspaceId}/entries/${id}`
    if (confirmDiscardUnsavedChanges(() => navigate(target))) navigate(target)
  }, 'dialog')

  // Any file joins this workspace the way a library import would classify it: a
  // STEP lands with a part that imports it, a document as a document, anything
  // else as a file entry. No navigation afterwards, since several uploads in a
  // row are the common case; the new rows appear through the store event.
  const handleUpload = (chosen: File) => runBusy('upload', `Failed to upload ${chosen.name}`, async () => {
    if (!workspaceId) return
    await importPickedFile(chosen, { into: workspaceId })
  })

  // Where a document's referenced STEP bytes come from. The bound session is
  // the authority when it is this workspace's; otherwise a session is built on
  // the spot, which reads the same store rows the bound one would.
  const fileResolver = () => (session && session.workspace === workspaceId
    ? session
    : createWorkspaceSession(workspaceId ?? '', store))

  const handleExportEntry = (entry: EntryMeta) => {
    if (busy.has(`export:${entry.id}`)) return
    if (entryExportFormats(entry) !== null) {
      setExportTarget(entry)
      return
    }
    void runBusy(`export:${entry.id}`, `Failed to export ${entry.name}`, async () => {
      downloadFileEntry(await fileResolver().readEntry(entry.id))
    })
  }

  // Runs inside the dialog's own busy state and closes it either way, so the
  // failure lands in the banner the closed dialog uncovers.
  const handleExportDownload = (format: ExportFormat, tessellation: number, fileName: string) => {
    const entry = exportTarget
    if (!entry) return Promise.resolve()
    return runBusy(`export:${entry.id}`, `Failed to export ${entry.name}`, async () => {
      try {
        const resolver = fileResolver()
        const stored = await resolver.readEntry(entry.id)
        await downloadDocumentEntry(entry, stored.text ?? '', format, tessellation, fileName, resolver)
      } catch (e) {
        // The bare kernel wording does not say which row it is about.
        if (e instanceof EmptyExportError) throw new Error(`${entry.name} has ${e.message}`)
        throw e
      } finally {
        setExportTarget(null)
      }
    })
  }

  const handleRenameEntry = () => runBusy('renameEntry', 'Failed to rename the entry', async () => {
    if (!workspaceId || !renameTarget || !renameName.trim()) return
    await store.renameEntry(workspaceId, renameTarget.id, renameName.trim())
    setRenameTarget(null)
    setRenameName('')
  }, 'dialog')

  const handleDuplicate = (entry: EntryMeta) => runBusy(`duplicate:${entry.id}`, 'Failed to duplicate the entry', async () => {
    if (!workspaceId) return
    await store.cloneEntry(workspaceId, entry.id)
  })

  const handleDelete = async (entry: EntryMeta) => {
    if (!workspaceId) return
    setDeleting(prev => new Set(prev).add(entry.id))
    try {
      await store.removeEntry(workspaceId, entry.id)
    } catch (e) {
      // A referenced entry is refused with its live referrers, which is a
      // guard rather than a failure and gets its own dialog.
      if (e instanceof EntryReferencedError) setReferenced({ entry, referrers: e.referrers })
      else setError(errorMessage(e, 'Failed to delete the entry'))
    } finally {
      setDeleting(prev => { const next = new Set(prev); next.delete(entry.id); return next })
    }
  }

  // Replace a file entry's bytes in place. The entry keeps its id, so every
  // document that references it keeps referencing it: that is the whole point
  // of the gesture, and why it is a row control rather than a delete plus an
  // import.
  const handleReplace = (entry: EntryMeta, chosen: File) =>
    runBusy(`replace:${entry.id}`, `Failed to replace ${entry.name}`, async () => {
      if (!session) return
      const bytes = new Uint8Array(await chosen.arrayBuffer())
      const current = await session.readEntry(entry.id)
      await session.writeEntry({ ...current, bytes })
      // The solver worker still holds the replaced id's old bytes; drop it so
      // the next solve re-reads the fresh payload from the workspace entry.
      dropWorkerFileId(entry.id)
    })

  // The explicit pull, the only resolver read a row ever makes besides the
  // check. A pull that could not reach the source or find the recorded entry
  // writes nothing, and says so rather than leaving the click unanswered.
  const handleUpdate = (entry: EntryMeta, record: ProvenanceRecord) =>
    runBusy(`update:${entry.id}`, `Failed to update ${entry.name}`, async () => {
      if (!workspaceId) return
      const result = await updateFromOrigin(workspaceId, record.entry)
      if (result.unreachable) setError(`Origin unavailable; ${entry.name} was not updated.`)
      else if (result.sourceMissing) setError(`The source entry is gone; ${entry.name} was not updated.`)
      // A pull that wrote bumps the store revision, so the rows reload and every
      // status falls back to "Not checked" on its own: the pull rewrites the
      // whole closure, so the sibling rows' statuses are as stale as this one's.
      // A pull that wrote nothing bumps nothing, and leaves them standing.
    })

  // A long workspace-level verb keeps its own key busy, so the card's control
  // goes disabled and no second duplicate or export can start.
  const handleRenameWorkspace = () => runBusy('rename', 'Failed to rename the workspace', async () => {
    if (!workspaceId || !wsRenameName.trim()) return
    await store.rename(workspaceId, wsRenameName.trim())
    setWsRenameOpen(false)
  }, 'dialog')

  const handleDuplicateWorkspace = () => runBusy('duplicate', 'Failed to duplicate the workspace', async () => {
    if (!workspaceId) return
    const { workspace } = await store.duplicate(workspaceId)
    navigate(`/workspaces/${workspace}`)
  })

  const handleExport = () => runBusy('export', 'Failed to export the workspace', async () => {
    if (!workspaceId) return
    const tree = deserializeTree(await store.export(workspaceId))
    const bytes = await buildZipBytes(tree)
    downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${summary?.name ?? 'workspace'}.zip`)
  })

  // The one gesture that resolves origins (I2). Nothing here runs on a mount,
  // a render or a solve: a status is only ever the answer to this click.
  const handleCheck = () => runBusy('check', 'Failed to check the origins', async () => {
    const next = new Map<string, OriginStatus>()
    for (const record of origins.values()) {
      try {
        const state = await originState(record, byId.get(record.entry)?.contentHash)
        next.set(record.entry, state.status)
      } catch {
        // One resolver that throws must not strand the rest of the rows: that
        // row reads as unreachable and the remaining checks still run.
        next.set(record.entry, 'unreachable')
      }
    }
    setChecked({ workspace: workspaceId, revision, statuses: next })
  })

  const handlePrune = () => runBusy('prune', 'Failed to prune the orphans', async () => {
    if (!workspaceId) return
    // The guard is a second, independent check. Orphans have zero referrers by
    // construction, but if a race made one referenced between the scan and the
    // delete, the store refuses and prune surfaces it rather than deleting.
    for (const orphan of orphans) {
      try {
        await store.removeEntry(workspaceId, orphan.id)
      } catch (e) {
        if (e instanceof EntryReferencedError) {
          setPruneOpen(false)
          setPruneBlocked(e.referrers)
          return
        }
        throw e
      }
    }
    setPruneOpen(false)
  }, 'dialog')

  const handleTrash = () => runBusy('trash', 'Failed to move the workspace to trash', async () => {
    if (!workspaceId) return
    await store.trash(workspaceId)
    navigate('/workspaces')
  })

  const groups: Array<{ label: string; entries: EntryMeta[] }> = [
    { label: 'Parts', entries: grouped.parts },
    { label: 'Assemblies', entries: grouped.assemblies },
    { label: 'Other documents', entries: grouped.otherDocs },
    { label: 'Files', entries: grouped.files },
  ]

  return (
    <div className="documents-layout workspace-layout">
      <aside className="workspace-identity">
        <div className="workspace-identity-card">
          <div className="doc-tile-preview workspace-identity-preview">
            <DocTilePreview
              workspace={workspaceId ?? ''}
              entry={summary?.coverEntry ?? workspaceId ?? ''}
              name={summary?.name ?? ''}
            />
          </div>
          <div className="workspace-identity-body">
            <h2 className="workspace-identity-name" title={summary?.name}>{summary?.name ?? ''}</h2>
            <div className="workspace-identity-props">
              {ready && <span>{entries.length} {entries.length === 1 ? 'entry' : 'entries'}</span>}
              {ready && <span>{formatBytes(summary?.size ?? 0)}</span>}
              {ready && summary && <span>{formatRelativeDate(new Date(summary.updatedAt).toISOString())}</span>}
            </div>
            <div className="workspace-identity-actions">
              <button
                className="btn btn-tile-action"
                title="Rename workspace"
                aria-label="Rename workspace"
                onClick={() => { setWsRenameName(summary?.name ?? ''); setWsRenameOpen(true) }}
              >
                <span className="material-icons">edit</span>
              </button>
              {/* Both maintenance verbs are workspace-wide, so they sit on the
                  card rather than on any one row: a check resolves every
                  recorded origin, a prune sweeps every unreferenced file. Each
                  appears only when it has something to act on. */}
              {origins.size > 0 && (
                <button
                  className="btn btn-tile-action"
                  title="Check for updates"
                  aria-label="Check for updates"
                  disabled={busy.has('check')}
                  onClick={() => { void handleCheck() }}
                >
                  <span className="material-icons">{busy.has('check') ? 'hourglass_empty' : 'refresh'}</span>
                </button>
              )}
              {orphans.length > 0 && (
                <button
                  className="btn btn-tile-action"
                  title="Prune orphans"
                  aria-label="Prune orphans"
                  onClick={() => setPruneOpen(true)}
                >
                  <span className="material-icons">delete_sweep</span>
                </button>
              )}
              <button
                className="btn btn-tile-action"
                title="Duplicate workspace"
                aria-label="Duplicate workspace"
                disabled={busy.has('duplicate')}
                onClick={() => { void handleDuplicateWorkspace() }}
              >
                <span className="material-icons">{busy.has('duplicate') ? 'hourglass_empty' : 'content_copy'}</span>
              </button>
              <button
                className="btn btn-tile-action"
                title="Export workspace"
                aria-label="Export workspace"
                disabled={busy.has('export')}
                onClick={() => { void handleExport() }}
              >
                <span className="material-icons">{busy.has('export') ? 'hourglass_empty' : 'archive'}</span>
              </button>
              <button
                className="btn btn-delete-tile"
                title="Move workspace to trash"
                aria-label="Move workspace to trash"
                disabled={busy.has('trash')}
                onClick={() => setTrashOpen(true)}
              >
                <span className="material-icons">{busy.has('trash') ? 'hourglass_empty' : 'delete'}</span>
              </button>
            </div>
          </div>
        </div>
      </aside>

      <div className="documents-main workspace-entries">
        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div className="workspace-entries-header">
          <span className="workspace-entries-title">Entries</span>
          {/* One button per thing that can be added, so the kind is the gesture
              rather than a choice inside the dialog. */}
          <button
            className="btn btn-tile-action"
            title="New part"
            aria-label="New part"
            onClick={() => { setNewName(''); setAddKind('part') }}
          >
            <span className="material-icons">add_box</span>
          </button>
          <button
            className="btn btn-tile-action"
            title="New assembly"
            aria-label="New assembly"
            onClick={() => { setNewName(''); setAddKind('assembly') }}
          >
            <span className="material-icons">library_add</span>
          </button>
          {/* The row's replace control's pattern: a label around a visually
              hidden input keeps the picker in the tab order, which
              `display: none` would not. */}
          <label
            className="btn btn-tile-action workspace-upload"
            title={busy.has('upload') ? 'Uploading...' : 'Upload'}
          >
            <input
              type="file"
              className="workspace-upload-input"
              aria-label="Upload file"
              aria-disabled={busy.has('upload')}
              onChange={e => {
                const chosen = e.target.files?.[0]
                // Cleared so the same file can be picked again right after.
                e.target.value = ''
                if (chosen && !busy.has('upload')) void handleUpload(chosen)
              }}
            />
            <span className="material-icons">{busy.has('upload') ? 'hourglass_empty' : 'upload'}</span>
          </label>
        </div>

        {/* A failed load must not keep the spinner up, and the failure has to
            survive the banner's dismissal: the flag, not the banner, decides. */}
        {!ready && !loadFailed && <LoadingState label="Loading workspace..." />}
        {!ready && loadFailed && (
          <p className="workspace-entries-empty">
            Failed to load this workspace.{' '}
            <button
              type="button"
              className="btn btn-tile-action"
              onClick={() => setAttempt(prev => prev + 1)}
            >
              Retry
            </button>
          </p>
        )}

        {ready && entries.length === 0 && <p className="workspace-entries-empty">This workspace is empty.</p>}

        {ready && groups.map(group => group.entries.length === 0 ? null : (
          <section className="workspace-entry-group" key={group.label}>
            <h3 className="workspace-entry-group-label">{group.label}</h3>
            <ul className="workspace-entry-list" role="list">
              {group.entries.map(entry => (
                <EntryRow
                  key={entry.id}
                  entry={entry}
                  workspace={workspaceId ?? ''}
                  dirty={dirty.has(entry.id)}
                  deleting={deleting.has(entry.id)}
                  duplicating={busy.has(`duplicate:${entry.id}`)}
                  replacing={busy.has(`replace:${entry.id}`)}
                  updating={busy.has(`update:${entry.id}`)}
                  exporting={busy.has(`export:${entry.id}`)}
                  usedBy={referrerNames.get(entry.id)}
                  origin={origins.get(entry.id)}
                  status={statuses.get(entry.id) ?? 'unknown'}
                  onOpen={openEntry}
                  onRename={target => { setRenameTarget(target); setRenameName(target.name) }}
                  onDuplicate={target => { void handleDuplicate(target) }}
                  onExport={handleExportEntry}
                  onDelete={target => { void handleDelete(target) }}
                  onReplace={(target, chosen) => { void handleReplace(target, chosen) }}
                  onUpdate={(target, record) => { void handleUpdate(target, record) }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Dialog
        isOpen={addKind !== null}
        title={addKind === 'assembly' ? 'New Assembly' : 'New Part'}
        onClose={() => { setAddKind(null); setDialogError(null) }}
        onConfirm={() => { void handleAdd() }}
        confirmLabel="Add"
        busy={busy.has('add')}
      >
        <input
          type="text"
          placeholder={addKind === 'assembly' ? 'Assembly name' : 'Part name'}
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleAdd() }}
          autoFocus
        />
        {dialogError && <p className="error-text">{dialogError}</p>}
      </Dialog>

      <ExportDialog
        isOpen={exportTarget !== null}
        defaultName={exportTarget?.name ?? 'export'}
        formats={(exportTarget && entryExportFormats(exportTarget)) ?? undefined}
        onDownload={handleExportDownload}
        onCancel={() => setExportTarget(null)}
      />

      <Dialog
        isOpen={renameTarget !== null}
        title="Rename Entry"
        onClose={() => { setRenameTarget(null); setDialogError(null) }}
        onConfirm={() => { void handleRenameEntry() }}
        confirmLabel="Rename"
        busy={busy.has('renameEntry')}
      >
        <input
          type="text"
          value={renameName}
          onChange={e => setRenameName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleRenameEntry() }}
          aria-label="Entry name"
          autoFocus
        />
        {dialogError && <p className="error-text">{dialogError}</p>}
      </Dialog>

      <Dialog
        isOpen={wsRenameOpen}
        title="Rename Workspace"
        onClose={() => { setWsRenameOpen(false); setDialogError(null) }}
        onConfirm={() => { void handleRenameWorkspace() }}
        confirmLabel="Rename"
        busy={busy.has('rename')}
      >
        <input
          type="text"
          value={wsRenameName}
          onChange={e => setWsRenameName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleRenameWorkspace() }}
          aria-label="Workspace name"
          autoFocus
        />
        {dialogError && <p className="error-text">{dialogError}</p>}
      </Dialog>

      <MessageDialog
        isOpen={trashOpen}
        title="Move to Trash"
        message={`Move "${summary?.name ?? 'this workspace'}" to the trash? You can recover it from the library.`}
        variant="error"
        onClose={() => setTrashOpen(false)}
        onConfirm={() => { setTrashOpen(false); void handleTrash() }}
        confirmLabel="Move to Trash"
        cancelLabel="Cancel"
      />

      <Dialog
        isOpen={pruneOpen}
        title="Prune Orphans"
        onClose={() => { setPruneOpen(false); setDialogError(null) }}
        onConfirm={() => { void handlePrune() }}
        confirmLabel="Prune"
        busy={busy.has('prune')}
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
        {dialogError && <p className="error-text">{dialogError}</p>}
      </Dialog>

      <Dialog
        isOpen={pruneBlocked !== null}
        title="Cannot Prune"
        onClose={() => setPruneBlocked(null)}
      >
        <p>An entry is still referenced and was not pruned. Remove the reference first.</p>
        <ul className="where-used-list">
          {pruneBlocked?.map(referrer => (
            <li className="where-used-name" key={referrer.id}>{referrer.name}</li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        isOpen={referenced !== null}
        title="Cannot Delete"
        onClose={() => setReferenced(null)}
      >
        <p>
          {referenced?.entry.name} is still referenced. Remove the reference first, or open the
          entry that uses it.
        </p>
        <ul className="where-used-list">
          {referenced?.referrers.map(referrer => (
            <li key={referrer.id}>
              <button
                type="button"
                className="where-used-open"
                onClick={() => {
                  const entry = entries.find(candidate => candidate.id === referrer.id)
                  setReferenced(null)
                  if (entry) openEntry(entry)
                }}
              >
                {referrer.name}
              </button>
            </li>
          ))}
        </ul>
      </Dialog>
    </div>
  )
}

