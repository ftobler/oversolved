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
import { buildZipBytes } from '@/workspace/zipCarrier'
import { deserializeTree } from '@/workspace/serializer'
import { importBag, readDirectoryBag, readZipBag } from '@/workspace/import'
import { importPickedFile } from '@/workspace/importFile'
import { isStepFileName, type StepImportMode } from '@/workspace/stepImportMode'
import StepImportDialog from '@/components/dialogs/StepImportDialog'
import { canPickDirectory, canPickWorkspaceZip, pickLibraryDirectory, pickWorkspaceZip } from '@/adapters/fileSystemAccess'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import { shouldActivateDrag } from '@/utils/geometry/dragLogic'
import { gridSlotAt, type GridTileRect } from '@/pages/workspaceGridSlot'
import '@/pages/Documents.css'

// A press becomes a drag only after the click threshold (or a long press on
// touch), so a plain click still opens the tile under it.
const TOUCH_LONG_PRESS_MS = 350

interface TileGesture {
  workspace: string
  pointerId: number
  pointerType: string
  startX: number
  startY: number
  lastX: number
  lastY: number
}

interface TileDragView {
  workspace: string
  slot: number
  dx: number
  dy: number
}

// U1: one tile per workspace. It lists workspace summaries only (no document
// text, no preview), so opening the grid is cheap however many entries a
// workspace holds. A tile paints a placeholder until the workspace is first
// opened and a save writes a preview (A9); the cover entry is metadata only.
export default function Workspaces() {
  const store = getWorkspaceStore()
  const [summaries, setSummaries] = useState<WorkspaceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Whether the last list failed, kept apart from `error` because the banner is
  // dismissible and the empty claim must stay suppressed after it is.
  const [loadFailed, setLoadFailed] = useState(false)
  const [trashView, setTrashView] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const { preferences, updatePreference } = useUserPreferences()
  const orderMode = preferences.workspace_sort
  // A tile gesture is transient interaction state, not document data. The view
  // is the live preview: the dragged tile keeps its slot in the local list but
  // is translated to the pointer while the other tiles reflow around it.
  const [gesture, setGesture] = useState<TileGesture | null>(null)
  const [dragView, setDragView] = useState<TileDragView | null>(null)
  const suppressClickRef = useRef(false)
  const gridRef = useRef<HTMLDivElement>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<'part' | 'assembly'>('part')
  const [addError, setAddError] = useState<string | null>(null)
  const [renameTarget, setRenameTarget] = useState<WorkspaceSummary | null>(null)
  const [renameName, setRenameName] = useState('')
  const [purgeTarget, setPurgeTarget] = useState<WorkspaceSummary | null>(null)
  // U5: the count of entries the last import copied, held until acknowledged.
  // The copy semantics is stated at the moment it matters, not buried in docs.
  const [importedCount, setImportedCount] = useState<number | null>(null)
  // The three import gestures share one toolbar button and one menu; the file
  // input stays mounted so a plain-file import still needs no picker support.
  const importButtonRef = useRef<HTMLButtonElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importMenu, setImportMenu] = useState<[number, number] | null>(null)
  // The picked STEP waiting for its import mode. A STEP creates a workspace
  // either way; the mode only decides what lands inside it.
  const [stepImportFile, setStepImportFile] = useState<File | null>(null)
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

  // Every refresh is a fresh read, and a view change (the trash tab, a search,
  // a workspace event) starts a new one while the previous may still be open.
  // Only the newest request may publish; an older answer describes a view the
  // user has already left.
  const refreshSeq = useRef(0)
  const refresh = useCallback(async (includeTrashed: boolean, search: string) => {
    const seq = ++refreshSeq.current
    try {
      const list = await store.list({ includeTrashed, sort: orderMode === 'custom' ? 'custom' : 'modified', search })
      if (seq !== refreshSeq.current) return
      setSummaries(list)
      setError(null)
      setLoadFailed(false)
    } catch (e) {
      if (seq !== refreshSeq.current) return
      // A failed list is not an empty library. The flag survives the banner's
      // dismissal so the page never claims "No workspaces yet." over a failure.
      setError(errorMessage(e, 'Failed to load workspaces'))
      setLoadFailed(true)
    } finally {
      if (seq === refreshSeq.current) setLoading(false)
    }
  }, [store, orderMode])

  useEffect(() => {
    void refresh(trashView, debouncedSearch)
    return subscribeWorkspaceStore(() => { void refresh(trashView, debouncedSearch) })
  }, [refresh, trashView, debouncedSearch])

  const handleCreate = async () => {
    if (!newName.trim()) {
      setAddError('Workspace name cannot be empty')
      return
    }
    try {
      await withBusy('create', async () => {
        await store.create(newName.trim(), { docKind: newKind })
        setNewName('')
        setAddError(null)
        setShowCreate(false)
        await refresh(false, debouncedSearch)
      })
    } catch (e) {
      setAddError(errorMessage(e, 'Failed to create workspace'))
    }
  }

  const handleRename = async () => {
    if (!renameTarget || !renameName.trim()) return
    try {
      await withBusy('rename', async () => {
        await store.rename(renameTarget.workspace, renameName.trim())
        setRenameTarget(null)
        await refresh(trashView, debouncedSearch)
      })
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
      await withBusy(`trash:${workspace}`, async () => {
        await store.trash(workspace)
        await refresh(trashView, debouncedSearch)
      })
    } catch (e) {
      setError(errorMessage(e, 'Failed to move to trash'))
    }
  }

  const handleRecover = async (workspace: string) => {
    try {
      await withBusy(`recover:${workspace}`, async () => {
        await store.recover(workspace)
        await refresh(trashView, debouncedSearch)
      })
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

  // A picked STEP asks how to land, then the picked mode builds the workspace in
  // one gesture: mode A keeps adoption's pair, B1/B2 create the workspace and
  // land the assembly inside it (importPickedFile owns that split).
  const importChosenFile = async (file: File, stepMode: StepImportMode) => {
    try {
      await withBusy('import', async () => {
        const result = await importPickedFile(file, { stepMode })
        setImportedCount(result.documents + result.files)
        await refresh(false, debouncedSearch)
      })
    } catch (err) {
      setError(errorMessage(err, 'Failed to import file'))
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''
    if (isStepFileName(file.name)) {
      setStepImportFile(file)
      return
    }
    await importChosenFile(file, 'part')
  }

  const handleImportFolder = async () => {
    try {
      await withBusy('import', async () => {
        const dir = await pickLibraryDirectory()
        if (!dir) return  // cancelled: a non-event
        // One-shot: the folder's bytes are copied into the permanent store and
        // the folder itself is left alone.
        const result = await importBag(await readDirectoryBag(dir))
        setImportedCount(result.documents + result.files)
        await refresh(false, debouncedSearch)
      })
    } catch (err) {
      setError(errorMessage(err, 'Failed to import folder'))
    }
  }

  const handleOpenZip = async () => {
    try {
      await withBusy('import', async () => {
        const handle = await pickWorkspaceZip()
        if (!handle) return  // cancelled: a non-event
        const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer())
        const result = await importBag(await readZipBag(bytes))
        setImportedCount(result.documents + result.files)
        await refresh(false, debouncedSearch)
      })
    } catch (err) {
      setError(errorMessage(err, 'Failed to open archive'))
    }
  }

  const visible = trashView ? summaries.filter(s => s.trashedAt) : summaries.filter(s => !s.trashedAt)
  const visibleRef = useRef(visible)
  visibleRef.current = visible

  // Dragging maps a visible gap to a slot in the full custom list, because a
  // search hides tiles and a trash keeps its slot while its tile is elsewhere.
  const draggable = orderMode === 'custom' && !trashView && searchQuery.trim() === ''

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>, workspace: string) => {
    if (e.button !== 0 || !e.isPrimary) return
    // The row actions own their own clicks; a press on one is not a tile grab.
    if ((e.target as HTMLElement).closest('button')) return
    const next: TileGesture = {
      workspace,
      pointerId: e.pointerId,
      // A synthetic pointer event may name no type; only touch uses the hold.
      pointerType: e.pointerType || 'mouse',
      startX: e.clientX,
      startY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
    }
    setGesture(next)
  }

  useEffect(() => {
    if (gesture === null) return
    const { workspace, pointerId, pointerType } = gesture
    let active = false
    let timer: number | null = null
    let blocker: ((e: TouchEvent) => void) | null = null
    let rects: GridTileRect[] = []
    let remaining: WorkspaceSummary[] = []
    const ownsPointer = (e: PointerEvent) => e.pointerId === pointerId
    const draggedTile = () => Array.from(gridRef.current?.querySelectorAll<HTMLElement>('.doc-tile') ?? [])
      .find(el => el.dataset.workspace === workspace)

    const updateView = (x: number, y: number) => setDragView({
      workspace,
      slot: gridSlotAt(rects, { x, y }),
      dx: x - gesture.startX,
      dy: y - gesture.startY,
    })

    const finish = () => {
      active = false
      if (timer !== null) window.clearTimeout(timer)
      if (blocker !== null) window.removeEventListener('touchmove', blocker)
      const tile = draggedTile()
      if (tile?.hasPointerCapture?.(pointerId)) tile.releasePointerCapture(pointerId)
      // The click from a released pointer arrives in the same task; clear the
      // suppression on the next task so it cannot open the workspace.
      window.setTimeout(() => { suppressClickRef.current = false }, 0)
      setGesture(null)
      setDragView(null)
    }

    const activate = () => {
      if (active) return
      const tiles = Array.from(gridRef.current?.querySelectorAll<HTMLElement>('.doc-tile') ?? [])
      remaining = visibleRef.current.filter(summary => summary.workspace !== workspace)
      // Measured once: a live reflow must not move the target slot mid-gesture.
      rects = tiles
        .filter(el => el.dataset.workspace !== workspace)
        .map(el => {
          const rect = el.getBoundingClientRect()
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
        })
      active = true
      if (pointerType === 'touch') {
        // Only the activated hold blocks a touchmove, so a quick swipe still
        // scrolls the grid instead of starting a reorder.
        blocker = event => event.preventDefault()
        window.addEventListener('touchmove', blocker, { passive: false })
      }
      const tile = draggedTile()
      if (tile?.setPointerCapture) tile.setPointerCapture(pointerId)
      suppressClickRef.current = true
      updateView(gesture.lastX, gesture.lastY)
    }

    const onMove = (e: PointerEvent) => {
      if (!ownsPointer(e)) return
      gesture.lastX = e.clientX
      gesture.lastY = e.clientY
      if (!active) {
        if (pointerType === 'touch') {
          // A finger that travels before the hold is a scroll, not a reorder.
          if (shouldActivateDrag([gesture.startX, gesture.startY], [e.clientX, e.clientY])) finish()
          return
        }
        if (!shouldActivateDrag([gesture.startX, gesture.startY], [e.clientX, e.clientY])) return
        activate()
        return
      }
      updateView(e.clientX, e.clientY)
    }

    const onUp = (e: PointerEvent) => {
      if (!ownsPointer(e)) return
      const wasActive = active
      const slot = wasActive ? gridSlotAt(rects, { x: e.clientX, y: e.clientY }) : 0
      const remainingIds = remaining.map(summary => summary.workspace)
      finish()
      if (!wasActive) return
      void (async () => {
        try {
          // The store's index is in the full order (trashed tiles included), so
          // translate the visible slot through it before the one move write.
          const full = await store.list({ includeTrashed: true, sort: 'custom' })
          const target = remainingIds[slot]
          const last = remainingIds[remainingIds.length - 1]
          const lastIndex = last === undefined ? -1 : full.findIndex(summary => summary.workspace === last)
          const toIndex = target === undefined
            ? (lastIndex < 0 ? full.length : lastIndex + 1)
            : full.findIndex(summary => summary.workspace === target)
          await store.moveWorkspace(workspace, toIndex)
          await refresh(trashView, debouncedSearch)
        } catch (err) {
          setError(errorMessage(err, 'Failed to reorder workspaces'))
        }
      })()
    }

    const onCancel = (e: PointerEvent) => { if (ownsPointer(e)) finish() }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && active) {
        e.preventDefault()
        finish()
      }
    }

    if (pointerType === 'touch') timer = window.setTimeout(activate, TOUCH_LONG_PRESS_MS)
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      if (timer !== null) window.clearTimeout(timer)
      if (blocker !== null) window.removeEventListener('touchmove', blocker)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [gesture, store, refresh, trashView, debouncedSearch])

  const dragged = dragView === null ? undefined : visible.find(summary => summary.workspace === dragView.workspace)
  const rendered = dragged === undefined || dragView === null ? visible : (() => {
    const rest = visible.filter(summary => summary.workspace !== dragged.workspace)
    const at = Math.min(dragView.slot, rest.length)
    return [...rest.slice(0, at), dragged, ...rest.slice(at)]
  })()

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
          <div className="workspace-sort" role="group" aria-label="Workspace order">
            <button
              className={`sort-option ${orderMode === 'date' ? 'active' : ''}`}
              aria-pressed={orderMode === 'date'}
              onClick={() => { void updatePreference('workspace_sort', 'date') }}
              title="Sort by date, most recently changed first"
            >
              Date
            </button>
            <button
              className={`sort-option ${orderMode === 'custom' ? 'active' : ''}`}
              aria-pressed={orderMode === 'custom'}
              onClick={() => { void updatePreference('workspace_sort', 'custom') }}
              title="Use your own tile order; drag tiles to change it"
            >
              Custom
            </button>
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
            onClick={() => { if (importMenu) setImportMenu(null); else openImportMenu() }}
            disabled={isBusy('import')}
            title="Import"
            aria-label="Import"
            aria-haspopup="menu"
            aria-expanded={importMenu !== null}
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
            title={newKind === 'assembly' ? 'Create New Assembly Workspace' : 'Create New Part Workspace'}
            onClose={() => { setShowCreate(false); setAddError(null) }}
            onConfirm={handleCreate}
            confirmLabel="Create"
            busy={isBusy('create')}
          >
            <input
              type="text"
              placeholder="Workspace name"
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
            busy={isBusy('rename')}
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
            message={`Copied ${importedCount ?? 0} entries into this workspace. Edits to the source will not propagate.`}
            onClose={() => setImportedCount(null)}
          />

          <StepImportDialog
            isOpen={stepImportFile !== null}
            fileName={stepImportFile?.name ?? ''}
            onImport={mode => {
              const file = stepImportFile
              setStepImportFile(null)
              if (file !== null) void importChosenFile(file, mode)
            }}
            onCancel={() => setStepImportFile(null)}
          />

          {loading && <LoadingState label="Loading workspaces..." />}
          {error && <ErrorBanner message={`Error: ${error}`} onDismiss={() => setError(null)} />}
          {!loading && !loadFailed && visible.length === 0 && (
            <p className="status">
              {trashView ? 'Trash is empty.' : debouncedSearch ? `No workspaces match "${debouncedSearch}"` : 'No workspaces yet.'}
            </p>
          )}

          {orderMode === 'custom' && searchQuery.trim() !== '' && !trashView && (
            <p className="sort-hint">Drag is off while searching; clear the search to reorder tiles.</p>
          )}

          {!loading && visible.length > 0 && (
            <div className="doc-tiles" ref={gridRef}>
              {rendered.map(summary => (
                <div
                  key={summary.workspace}
                  className={`doc-tile ${draggable ? 'draggable' : ''} ${dragView?.workspace === summary.workspace ? 'dragging' : ''}`}
                  data-workspace={summary.workspace}
                  style={dragView?.workspace === summary.workspace
                    ? { transform: `translate(${dragView.dx}px, ${dragView.dy}px)`, zIndex: 5 }
                    : undefined}
                  onPointerDown={draggable ? e => beginDrag(e, summary.workspace) : undefined}
                >
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
                          <button
                            className="btn btn-tile-action"
                            disabled={isBusy(`recover:${summary.workspace}`)}
                            onClick={() => handleRecover(summary.workspace)}
                            title="Recover workspace"
                          >
                            <span className="material-icons">{isBusy(`recover:${summary.workspace}`) ? 'hourglass_empty' : 'restore'}</span>
                          </button>
                          <button className="btn btn-delete-tile" onClick={() => setPurgeTarget(summary)} title="Permanently delete">
                            <span className="material-icons">delete_forever</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <Link
                      to={`/workspaces/${summary.workspace}`}
                      className="doc-tile-link"
                      onClick={e => {
                        if (!suppressClickRef.current) return
                        e.preventDefault()
                      }}
                    >
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
                            disabled={isBusy(`trash:${summary.workspace}`)}
                            onClick={e => { e.preventDefault(); void handleTrash(summary.workspace) }}
                            title="Move to trash"
                          >
                            <span className="material-icons">{isBusy(`trash:${summary.workspace}`) ? 'hourglass_empty' : 'delete'}</span>
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
          anchorRef={importButtonRef}
        />
      )}
    </div>
  )
}
