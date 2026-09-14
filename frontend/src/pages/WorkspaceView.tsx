import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import { LoadingState } from '@/components/shared/LoadingState'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import { formatBytes } from '@/utils/formatBytes'
import { errorMessage } from '@/utils/core/errorMessage'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { randomUuid } from '@/utils/randomUuid'
import { getWorkspaceStore, type WorkspaceSummary } from '@/workspace/store'
import { subscribeWorkspaceStore, workspaceStoreRevision } from '@/workspace/storeEvents'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { deserializeTree } from '@/workspace/serializer'
import { EntryReferencedError, type EntryReferrer } from '@/workspace/errors'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'
import { dirtyEntryIds, groupEntries } from '@/components/layout/workspaceTreeModel'
import { referrersOf } from '@/components/layout/filesModel'
import { useWhereUsed } from '@/components/layout/filesSeams'
import { fileKindOf, fileSizeOf } from '@/components/layout/filesModel'
import type { EntryMeta } from '@/workspace/types'
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

export default function WorkspaceView() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const session = useWorkspaceSessionStore(s => s.session)
  const revision = useSyncExternalStore(subscribeWorkspaceStore, workspaceStoreRevision)
  const navigate = useNavigate()
  const store = getWorkspaceStore()

  // `null` is "not loaded yet", which is NOT the same as "empty": starting at []
  // painted "This workspace is empty." over a nameless 0-byte card on every open,
  // until two IDB round-trips resolved.
  const [loaded, setLoaded] = useState<{ workspace: string; entries: EntryMeta[]; savedRevs: Map<string, number>; summary: WorkspaceSummary | null } | null>(null)
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
  const [addOpen, setAddOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'part' | 'assembly'>('part')
  const [renameTarget, setRenameTarget] = useState<EntryMeta | null>(null)
  const [renameName, setRenameName] = useState('')
  const [wsRenameOpen, setWsRenameOpen] = useState(false)
  const [wsRenameName, setWsRenameName] = useState('')
  const [trashOpen, setTrashOpen] = useState(false)
  // The delete guard's presentation: the typed refusal with the live referrers
  // it named, held until the user acknowledges or jumps to one.
  const [referenced, setReferenced] = useState<{ entry: EntryMeta; referrers: EntryReferrer[] } | null>(null)
  // The row whose delete is in flight. The store round-trip can be slow enough
  // that a second click lands, and a double delete is not idempotent at this
  // layer, so the row's own button goes disabled until it settles. A Set rather
  // than one id, so a delete on one row cannot re-enable another's.
  const [deleting, setDeleting] = useState<ReadonlySet<string>>(new Set())
  // The workspace-level verbs that can run long: duplicate, export and trash.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())

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
      try {
        const [entries, savedRevs, all] = await Promise.all([
          session.listEntries(),
          session.savedRevs(),
          store.list(),
        ])
        if (cancelled) return
        setLoaded({ workspace: workspaceId, entries, savedRevs, summary: all.find(row => row.workspace === workspaceId) ?? null })
      } catch (e) {
        if (!cancelled) setErrors({ workspace: workspaceId, banner: errorMessage(e, 'Failed to read this workspace'), dialog: null })
      }
    }
    void load()
    return () => { cancelled = true }
  }, [session, workspaceId, revision, store])

  const ready = loaded !== null && loaded.workspace === workspaceId
  const entries = ready ? loaded.entries : EMPTY_ENTRIES
  const savedRevs = ready ? loaded.savedRevs : EMPTY_REVS
  const summary = ready ? loaded.summary : null

  const grouped = useMemo(() => groupEntries(entries), [entries])
  const dirty = useMemo(() => dirtyEntryIds(entries, savedRevs), [entries, savedRevs])
  const { inverse } = useWhereUsed(session, entries)
  const referrerNames = useMemo(() => {
    const names = new Map<string, string[]>()
    const byId = new Map(entries.map(entry => [entry.id, entry.name]))
    for (const entry of entries) {
      const refs = referrersOf(inverse, entry.id)
        .map(id => byId.get(id))
        .filter((name): name is string => name !== undefined)
      if (refs.length > 0) names.set(entry.id, refs)
    }
    return names
  }, [entries, inverse])

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

  const handleAdd = () => run('Failed to add the entry', async () => {
    if (!workspaceId || !newName.trim()) return
    const id = randomUuid()
    await store.addEntry(workspaceId, { id, kind: 'document', name: newName.trim(), docKind: newKind, text: '' })
    setAddOpen(false)
    setNewName('')
    const target = `/workspaces/${workspaceId}/entries/${id}`
    if (confirmDiscardUnsavedChanges(() => navigate(target))) navigate(target)
  }, 'dialog')

  const handleRenameEntry = () => run('Failed to rename the entry', async () => {
    if (!workspaceId || !renameTarget || !renameName.trim()) return
    await store.renameEntry(workspaceId, renameTarget.id, renameName.trim())
    setRenameTarget(null)
    setRenameName('')
  }, 'dialog')

  const handleDuplicate = (entry: EntryMeta) => run('Failed to duplicate the entry', async () => {
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

  // A long workspace-level verb keeps its own key busy, so the card's control
  // goes disabled and no second duplicate or export can start.
  const runBusy = async (key: string, what: string, action: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try {
      await run(what, action)
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  const handleRenameWorkspace = () => run('Failed to rename the workspace', async () => {
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
          <button
            className="btn btn-tile-action"
            title="Add entry"
            aria-label="Add entry"
            onClick={() => { setNewKind('part'); setNewName(''); setAddOpen(true) }}
          >
            <span className="material-icons">add</span>
          </button>
        </div>

        {/* A failed load must not keep the spinner up: the banner below says
            what went wrong, and an endless wait next to it would lie. */}
        {!ready && !error && <LoadingState label="Loading workspace..." />}

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
                  usedBy={referrerNames.get(entry.id)}
                  onOpen={openEntry}
                  onRename={target => { setRenameTarget(target); setRenameName(target.name) }}
                  onDuplicate={target => { void handleDuplicate(target) }}
                  onDelete={target => { void handleDelete(target) }}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <Dialog
        isOpen={addOpen}
        title="Add Entry"
        onClose={() => { setAddOpen(false); setDialogError(null) }}
        onConfirm={() => { void handleAdd() }}
        confirmLabel="Add"
      >
        <input
          type="text"
          placeholder="Entry name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void handleAdd() }}
          autoFocus
        />
        <select value={newKind} onChange={e => setNewKind(e.target.value as 'part' | 'assembly')} aria-label="Entry kind">
          <option value="part">Part</option>
          <option value="assembly">Assembly</option>
        </select>
        {dialogError && <p className="error-text">{dialogError}</p>}
      </Dialog>

      <Dialog
        isOpen={renameTarget !== null}
        title="Rename Entry"
        onClose={() => { setRenameTarget(null); setDialogError(null) }}
        onConfirm={() => { void handleRenameEntry() }}
        confirmLabel="Rename"
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

interface EntryRowProps {
  entry: EntryMeta
  workspace: string
  dirty: boolean
  deleting: boolean
  usedBy: string[] | undefined
  onOpen: (entry: EntryMeta) => void
  onRename: (entry: EntryMeta) => void
  onDuplicate: (entry: EntryMeta) => void
  onDelete: (entry: EntryMeta) => void
}

// The library tile on its side. A document row is activatable (click, Enter,
// Space); a file row is not -- it carries the same thumb slot and verbs but
// there is no editor behind it.
function EntryRow({ entry, workspace, dirty, deleting, usedBy, onOpen, onRename, onDuplicate, onDelete }: EntryRowProps) {
  const openable = entry.kind === 'document'
  const meta = entry.kind === 'file'
    ? [fileKindOf(entry), formatBytes(fileSizeOf(entry))]
    : [entry.docKind ?? 'document', entry.updatedAt ? formatRelativeDate(new Date(entry.updatedAt).toISOString()) : '']

  // The openable surface is a real <button> INSIDE the row rather than a role on
  // the row itself: the row also holds three controls, and a role="button"
  // wrapping them is nested-interactive -- it swallows the list item and makes a
  // screen reader announce the row's whole contents, controls included, as one
  // button's name. A real button also brings Enter and Space with it.
  const face = (
    <>
      <div className="doc-tile-preview workspace-entry-preview">
        <DocTilePreview workspace={workspace} entry={entry.id} name={entry.name} />
      </div>
      <div className="workspace-entry-body">
        <div className="workspace-entry-title">
          <span className="workspace-entry-name" title={entry.name}>{entry.name}</span>
          {dirty && <span className="workspace-entry-dot" role="img" aria-label="Changed since last save" />}
        </div>
        <div className="workspace-entry-meta">
          {meta.filter(Boolean).map(text => <span key={text}>{text}</span>)}
        </div>
        {usedBy && usedBy.length > 0 && (
          <div className="workspace-entry-usedby" title={`Used by ${usedBy.join(', ')}`}>
            used by {usedBy.join(', ')}
          </div>
        )}
      </div>
    </>
  )

  return (
    <li className={`workspace-entry-row${openable ? ' openable' : ''}`}>
      {openable ? (
        <button type="button" className="workspace-entry-open" onClick={() => onOpen(entry)}>
          {face}
        </button>
      ) : (
        <div className="workspace-entry-open">{face}</div>
      )}
      <div className="workspace-entry-actions">
        <button
          className="btn btn-tile-action"
          aria-label={`Rename ${entry.name}`}
          title="Rename"
          onClick={() => onRename(entry)}
        >
          <span className="material-icons">edit</span>
        </button>
        <button
          className="btn btn-tile-action"
          aria-label={`Duplicate ${entry.name}`}
          title="Duplicate"
          onClick={() => onDuplicate(entry)}
        >
          <span className="material-icons">content_copy</span>
        </button>
        <button
          className="btn btn-delete-tile"
          aria-label={`Delete ${entry.name}`}
          title="Delete"
          disabled={deleting}
          onClick={() => onDelete(entry)}
        >
          <span className="material-icons">{deleting ? 'hourglass_empty' : 'delete'}</span>
        </button>
      </div>
    </li>
  )
}
