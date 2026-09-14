import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import RightClickMenu, { type ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import { LoadingState } from '@/components/shared/LoadingState'
import DocTilePreview from '@/components/shared/DocTilePreview'
import { formatRelativeDate } from '@/utils/core/relativeDate'
import { formatBytes } from '@/utils/formatBytes'
import { errorMessage } from '@/utils/core/errorMessage'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { getWorkspaceStore, type WorkspaceSummary } from '@/workspace/store'
import { subscribeWorkspaceStore } from '@/workspace/storeEvents'
import { useCarrierChangeStore } from '@/stores/carrierChangeStore'
import { buildZipBytes } from '@/workspace/zipCarrier'
import { deserializeTree } from '@/workspace/serializer'
import { importBag, readDirectoryBag, readZipBag, type ImportBag } from '@/workspace/import'
import {
  getOriginResolver,
  mintOriginLocator,
  rememberOriginDirectory,
  rememberOriginZip,
  type OriginDescriptor,
} from '@/workspace/originResolver'
import { reopenWorkspaceHandle, workspaceHandleName } from '@/workspace/workspaceHandleRegistry'
import { canPickDirectory, canPickWorkspaceZip, pickLibraryDirectory, pickWorkspaceZip } from '@/adapters/fileSystemAccess'
import '@/pages/Documents.css'

// U1: one tile per workspace. It lists workspace summaries only (no document
// text, no preview), so opening the grid is cheap however many entries a
// workspace holds. A tile paints a placeholder until the workspace is first
// opened and a save writes a preview (A9); the cover entry is metadata only.
export default function Workspaces() {
  const store = getWorkspaceStore()
  const [summaries, setSummaries] = useState<WorkspaceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [trashView, setTrashView] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'part' | 'assembly'>('part')
  const [addError, setAddError] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<WorkspaceSummary | null>(null)
  const [renameName, setRenameName] = useState('')
  const [purgeTarget, setPurgeTarget] = useState<WorkspaceSummary | null>(null)
  const [reopen, setReopen] = useState<Map<string, string>>(new Map())
  // U5: the count of entries the last import copied, held until acknowledged.
  // The copy semantics is stated at the moment it matters, not buried in docs.
  const [importedCount, setImportedCount] = useState<number | null>(null)
  // The three import gestures share one toolbar button and one menu; the file
  // input stays mounted so a plain-file import still needs no picker support.
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importMenu, setImportMenu] = useState<[number, number] | null>(null)
  // Import, export and duplicate can take long enough that a second click
  // lands before the first settles, and a duplicated slow verb would run twice.
  // Each in-flight verb names its own key here: the control that owns it goes
  // disabled and swaps to the hourglass until the key is dropped.
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const isBusy = (key: string) => busy.has(key)
  const withBusy = async (key: string, action: () => Promise<void>) => {
    setBusy(prev => new Set(prev).add(key))
    try {
      await action()
    } finally {
      setBusy(prev => { const next = new Set(prev); next.delete(key); return next })
    }
  }

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const refresh = useCallback(async (includeTrashed: boolean, search: string) => {
    try {
      const list = await store.list({ includeTrashed, sort: 'modified', search })
      setSummaries(list)
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Failed to load workspaces'))
    } finally {
      setLoading(false)
    }
  }, [store])

  useEffect(() => {
    void refresh(trashView, debouncedSearch)
    return subscribeWorkspaceStore(() => { void refresh(trashView, debouncedSearch) })
  }, [refresh, trashView, debouncedSearch])

  useEffect(() => {
    let cancelled = false
    const probe = async () => {
      const names = new Map<string, string>()
      for (const summary of await store.list()) {
        const name = await workspaceHandleName(summary.workspace)
        if (name) names.set(summary.workspace, name)
      }
      if (!cancelled) setReopen(names)
    }
    void probe()
    return () => { cancelled = true }
  }, [store, summaries.length])

  const handleCreate = async () => {
    if (!newName.trim()) {
      setAddError('Workspace name cannot be empty')
      return
    }
    try {
      await store.create(newName.trim(), { docKind: newKind })
      setNewName('')
      setAddError(null)
      setShowCreate(false)
      await refresh(false, debouncedSearch)
    } catch (e) {
      setAddError(errorMessage(e, 'Failed to create workspace'))
    }
  }

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim()) return
    try {
      await store.rename(renameTarget.workspace, renameName.trim())
      setRenameTarget(null)
      await refresh(trashView, debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to rename workspace'))
    }
  }

  const handleDuplicate = async (workspace: string) => {
    try {
      await withBusy(`duplicate:${workspace}`, async () => {
        await store.duplicate(workspace)
        await refresh(trashView, debouncedSearch)
      })
    } catch (e) {
      setError(errorMessage(e, 'Failed to duplicate workspace'))
    }
  }

  const handleTrash = async (workspace: string) => {
    try {
      await store.trash(workspace)
      await refresh(trashView, debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to move to trash'))
    }
  }

  const handleRecover = async (workspace: string) => {
    try {
      await store.recover(workspace)
      await refresh(trashView, debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to recover workspace'))
    }
  }

  const handlePurgeConfirm = async () => {
    const target = purgeTarget
    if (!target) return
    setPurgeTarget(null)
    try {
      await store.purge(target.workspace)
      await refresh(trashView, debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to delete workspace'))
    }
  }

  const handleExport = async (summary: WorkspaceSummary) => {
    try {
      await withBusy(`export:${summary.workspace}`, async () => {
        const tree = deserializeTree(await store.export(summary.workspace))
        const bytes = await buildZipBytes(tree)
        downloadBlob(new Blob([bytes as BlobPart], { type: 'application/zip' }), `${summary.name}.zip`)
      })
    } catch (e) {
      setError(errorMessage(e, 'Failed to export workspace'))
    }
  }

  const handleReopen = async (workspace: string) => {
    try {
      const handle = await reopenWorkspaceHandle(workspace)
      if (!handle) {
        setError('That folder is no longer available')
        return
      }
      // The grant is restored, so prime the resolved target at once: a later
      // save writes through it instead of re-probing. The carrier change the
      // check finds is surfaced into carrierChangeStore, so entering the
      // workspace shows the decision dialog instead of silently keeping the
      // stale working copy (P4b).
      await useCarrierChangeStore.getState().check(workspace)
      setError(null)
    } catch (e) {
      setError(errorMessage(e, 'Failed to reopen folder'))
    }
  }

  // Bind a save target to a workspace that does not have one yet (an IDB-only
  // workspace adopted from a dropped bag). The carrier is not written now; the
  // first explicit save normalizes the layout into the picked folder.
  const handleAttachCarrier = async (workspace: string) => {
    try {
      const dir = await pickLibraryDirectory()
      if (!dir) return  // cancelled: a non-event
      await store.attachCarrier(workspace, { kind: 'folder', label: dir.name, handle: dir })
      setError(null)
      await refresh(trashView, debouncedSearch)
    } catch (e) {
      setError(errorMessage(e, 'Failed to bind folder'))
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    try {
      await withBusy('import', async () => {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const locator = mintOriginLocator('file')
        const isArchive = /\.(zip|oversolved)$/i.test(file.name)
        const read = async (): Promise<ImportBag> => isArchive
          ? readZipBag(bytes, locator)
          : { origin: locator, items: [{ path: file.name, bytes }] }
        const descriptor: OriginDescriptor = { locator, name: file.name, read }
        getOriginResolver().register(descriptor)
        const result = await importBag(await read(), { origin: descriptor })
        setImportedCount(result.documents + result.files)
        await refresh(false, debouncedSearch)
      })
    } catch (err) {
      setError(errorMessage(err, 'Failed to import file'))
    }
  }

  const handleImportFolder = async () => {
    try {
      await withBusy('import', async () => {
        const dir = await pickLibraryDirectory()
        if (!dir) return  // cancelled: a non-event
        const locator = mintOriginLocator('folder')
        const descriptor: OriginDescriptor = {
          locator,
          name: dir.name,
          read: () => readDirectoryBag(dir, locator),
        }
        getOriginResolver().register(descriptor)
        // Remember the handle so a save target or a later session's update can
        // reopen it. The in-session read above still works if this is refused.
        await rememberOriginDirectory(locator, dir)
        // Bind the picked folder as the workspace's save target: opening it is
        // the signal that an explicit save should land back there. The carrier is
        // not written now; `land` leaves the folder's files as they are.
        const bag = await readDirectoryBag(dir, locator)
        const result = await importBag(bag, { origin: descriptor, target: { kind: 'folder', label: dir.name, handle: dir } })
        setImportedCount(result.documents + result.files)
        await refresh(false, debouncedSearch)
      })
    } catch (err) {
      setError(errorMessage(err, 'Failed to import folder'))
    }
  }

  // A zip opened through the file picker carries a real handle, so the archive
  // becomes the workspace's save target. A zip dropped through the plain file
  // input cannot be written back and stays IDB-only.
  const handleOpenZip = async () => {
    try {
      await withBusy('import', async () => {
        const handle = await pickWorkspaceZip()
        if (!handle) return  // cancelled: a non-event
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
        const locator = mintOriginLocator('zip')
        const descriptor: OriginDescriptor = {
          locator,
          name: handle.name,
          // Re-read from the handle rather than the captured bytes, so an archive
          // edited on disk is the one an update sees.
          read: async () => readZipBag(new Uint8Array(await (await handle.getFile()).arrayBuffer()), locator),
        }
        getOriginResolver().register(descriptor)
        await rememberOriginZip(locator, handle)
        const bag = await readZipBag(bytes, locator)
        const result = await importBag(bag, { origin: descriptor, target: { kind: 'zip', label: handle.name, handle } })
        setImportedCount(result.documents + result.files)
        await refresh(false, debouncedSearch)
      })
    } catch (err) {
      setError(errorMessage(err, 'Failed to open archive'))
    }
  }

  const visible = trashView ? summaries.filter(s => s.trashedAt) : summaries.filter(s => !s.trashedAt)

  const openImportMenu = () => {
    const rect = importButtonRef.current?.getBoundingClientRect()
    setImportMenu(rect ? [rect.left, rect.bottom + 4] : [0, 0])
  }

  // The menu lists only the gestures this browser can actually perform; the
  // folder and archive entries appear exactly when their pickers do.
  const importItems: ContextMenuItem[] = [
    { label: 'Import file', onClick: () => fileInputRef.current?.click() },
  ]
  if (canPickDirectory()) {
    importItems.push({ label: 'Import folder', onClick: () => { void handleImportFolder() } })
  }
  if (canPickWorkspaceZip()) {
    importItems.push({ label: 'Open archive', onClick: () => { void handleOpenZip() } })
  }

  return (
    <div className="documents">
      {/* No trail here: this page IS the library, and the crumb above a
          workspace was the one word that never changed. */}
      <AppHeader>
        <div className="doc-controls">
          <div className="search-input-container">
            <span className="material-icons search-icon">search</span>
            <input
              type="text"
              placeholder="Search workspaces..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              className="search-input"
            />
            {searchQuery && (
              <button
                className="btn btn-clear-search"
                onClick={() => setSearchQuery('')}
                title="Clear search"
              >
                <span className="material-icons">close</span>
              </button>
            )}
          </div>
          <button
            className="toolbar-btn"
            onClick={() => { setShowCreate(true); setNewKind('part') }}
            title="New part workspace"
          >
            <span className="material-icons">add</span>
          </button>
          <button
            className="toolbar-btn"
            onClick={() => { setShowCreate(true); setNewKind('assembly') }}
            title="New assembly workspace"
          >
            <span className="material-icons">account_tree</span>
          </button>
          <button
            ref={importButtonRef}
            className="toolbar-btn btn-import"
            onClick={openImportMenu}
            disabled={isBusy('import')}
            title="Import"
            aria-label="Import"
            aria-haspopup="menu"
          >
            <span className="material-icons">{isBusy('import') ? 'hourglass_empty' : 'upload'}</span>
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".zip,.oversolved,.yaml,.yml,.step,.stp"
            onChange={handleImportFile}
            className="file-upload-input"
          />
        </div>
      </AppHeader>

      <div className="documents-layout">
        <aside className="documents-sidebar">
          <div className="sidebar-section">Library</div>
          <div
            className={`sidebar-item ${trashView ? '' : 'active'}`}
            onClick={() => { setTrashView(false); setLoading(true) }}
          >
            <span className="material-icons sidebar-item-icon">folder</span>
            <span className="sidebar-item-label">Workspaces</span>
          </div>
          <div
            className={`sidebar-item ${trashView ? 'active' : ''}`}
            onClick={() => { setTrashView(true); setLoading(true) }}
          >
            <span className="material-icons sidebar-item-icon">delete_outline</span>
            <span className="sidebar-item-label">Trash</span>
          </div>
        </aside>

        <div className="documents-main">
          <Dialog
            isOpen={showCreate}
            title={newKind === 'assembly' ? 'Create New Assembly' : 'Create New Part'}
            onClose={() => { setShowCreate(false); setAddError(null) }}
            onConfirm={handleCreate}
            confirmLabel="Create"
          >
            <input
              type="text"
              placeholder={newKind === 'assembly' ? 'Assembly name' : 'Part name'}
              value={newName}
              onChange={e => { setNewName(e.target.value); if (e.target.value.trim()) setAddError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') handleCreate() }}
              autoFocus
            />
            {addError && <p className="error-text">{addError}</p>}
          </Dialog>

          <Dialog
            isOpen={renameTarget != null}
            title="Rename Workspace"
            onClose={() => setRenameTarget(null)}
            onConfirm={handleRename}
            confirmLabel="Rename"
          >
            <input
              type="text"
              value={renameName}
              onChange={e => setRenameName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleRename() }}
              autoFocus
            />
          </Dialog>

          <MessageDialog
            isOpen={purgeTarget != null}
            title="Permanently Delete"
            message={`Permanently delete "${purgeTarget?.name}"? This cannot be undone.`}
            variant="error"
            onClose={() => setPurgeTarget(null)}
            onConfirm={handlePurgeConfirm}
            confirmLabel="Delete"
            cancelLabel="Cancel"
          />

          <MessageDialog
            isOpen={importedCount !== null}
            title="Copied into Workspace"
            message={`Copied ${importedCount ?? 0} entries into this workspace. Edits to the source will not propagate. Use the Origins panel to check for and pull updates.`}
            onClose={() => setImportedCount(null)}
          />

          {loading && <LoadingState label="Loading workspaces..." />}
          {error && <ErrorBanner message={`Error: ${error}`} onDismiss={() => setError(null)} />}
          {!loading && visible.length === 0 && (
            <p className="status">
              {trashView ? 'Trash is empty.' : debouncedSearch ? `No workspaces match "${debouncedSearch}"` : 'No workspaces yet.'}
            </p>
          )}

          {!loading && visible.length > 0 && (
            <div className="doc-tiles">
              {visible.map(summary => (
                <div key={summary.workspace} className="doc-tile">
                  {trashView ? (
                    <div className="doc-tile-link">
                      <div className="doc-tile-preview">
                        <DocTilePreview
                          workspace={summary.workspace}
                          entry={summary.coverEntry ?? summary.workspace}
                          name={summary.name}
                        />
                      </div>
                      <div className="doc-tile-info">
                        <span className="doc-tile-name" title={summary.name}>{summary.name}</span>
                      </div>
                      <div className="doc-tile-meta">
                        <span className="doc-tile-date">
                          Deleted: {formatRelativeDate(summary.trashedAt ?? '')}
                        </span>
                        <div className="doc-tile-actions">
                          <button className="btn btn-tile-action" onClick={() => handleRecover(summary.workspace)} title="Recover workspace">
                            <span className="material-icons">restore</span>
                          </button>
                          <button className="btn btn-delete-tile" onClick={() => setPurgeTarget(summary)} title="Permanently delete">
                            <span className="material-icons">delete_forever</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Link to={`/workspaces/${summary.workspace}`} className="doc-tile-link">
                      <div className="doc-tile-preview">
                        <DocTilePreview
                          workspace={summary.workspace}
                          entry={summary.coverEntry ?? summary.workspace}
                          name={summary.name}
                        />
                      </div>
                      <div className="doc-tile-info">
                        <span className="doc-tile-name" title={summary.name}>{summary.name}</span>
                      </div>
                      <div className="doc-tile-meta">
                        <span className="doc-tile-date">{formatRelativeDate(new Date(summary.updatedAt).toISOString())}</span>
                        <span className="doc-tile-size">{formatBytes(summary.size)}</span>
                        <div className="doc-tile-actions">
                          {reopen.has(summary.workspace) && (
                            <button
                              className="btn btn-tile-action"
                              onClick={e => { e.preventDefault(); void handleReopen(summary.workspace) }}
                              title={`Reopen ${reopen.get(summary.workspace)}`}
                            >
                              <span className="material-icons">folder_open</span>
                            </button>
                          )}
                          {canPickDirectory() && (
                            <button
                              className="btn btn-tile-action"
                              onClick={e => { e.preventDefault(); void handleAttachCarrier(summary.workspace) }}
                              title="Save to folder"
                            >
                              <span className="material-icons">save</span>
                            </button>
                          )}
                          <button
                            className="btn btn-tile-action"
                            onClick={e => { e.preventDefault(); setRenameTarget(summary); setRenameName(summary.name) }}
                            title="Rename"
                          >
                            <span className="material-icons">edit</span>
                          </button>
                          <button
                            className="btn btn-tile-action"
                            disabled={isBusy(`duplicate:${summary.workspace}`)}
                            onClick={e => { e.preventDefault(); void handleDuplicate(summary.workspace) }}
                            title="Duplicate"
                          >
                            <span className="material-icons">{isBusy(`duplicate:${summary.workspace}`) ? 'hourglass_empty' : 'content_copy'}</span>
                          </button>
                          <button
                            className="btn btn-tile-action"
                            disabled={isBusy(`export:${summary.workspace}`)}
                            onClick={e => { e.preventDefault(); void handleExport(summary) }}
                            title="Export workspace"
                          >
                            <span className="material-icons">{isBusy(`export:${summary.workspace}`) ? 'hourglass_empty' : 'archive'}</span>
                          </button>
                          <button
                            className="btn btn-delete-tile"
                            onClick={e => { e.preventDefault(); void handleTrash(summary.workspace) }}
                            title="Move to trash"
                          >
                            <span className="material-icons">delete</span>
                          </button>
                        </div>
                      </div>
                    </Link>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {importMenu && (
        <RightClickMenu
          items={importItems}
          position={importMenu}
          onClose={() => setImportMenu(null)}
        />
      )}
    </div>
  )
}
