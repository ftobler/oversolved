import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import Dialog from '@/components/dialogs/Dialog'
import MessageDialog from '@/components/dialogs/MessageDialog'
import ShareDialog from '@/components/dialogs/ShareDialog'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import type { DocumentSort } from '@/hooks/useUserPreferences'
import { isConnectionError, parseHttpError } from '@/utils/core/httpClient'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import { downloadBlob } from '@/utils/core/downloadBlob'
import { exportBundle, importBundle, copyDocument, pushDocument, moveDocument, syncAllDocuments, importStepFile } from '@/stores/documentStore'
import type { DocSummary, DocumentStore } from '@/stores/documentStore'
import { backendBundle } from '@/adapters/backend'
import { stringify as stringifyYaml } from 'yaml'
import { emptyAssemblyDoc } from '@/utils/assemblyMutations'
import type { TrashDoc } from '@/adapters/trash'
import { useAuth } from '@/contexts/AuthContext'
import '@/pages/Documents.css'

function stopClick(handler: () => void): React.MouseEventHandler {
  return (e) => {
    e.preventDefault()
    e.stopPropagation()
    handler()
  }
}

type DocumentMeta = DocSummary

// Tile thumbnail: prefer the inline base64 preview (local store), else the
// store's own thumbnail URL (the cloud store's /api path), else a placeholder.
// The view asks the store for the URL instead of hardcoding /api -- the one spot
// that used to reach past the adapter.
function DocTilePreview(
  { doc, store }: { doc: { uuid: string; name: string; preview_image?: string }; store: DocumentStore },
) {
  if (doc.preview_image) {
    return <img src={`data:image/png;base64,${doc.preview_image}`} alt={doc.name} />
  }
  const url = store.thumbnailUrl(doc.uuid)
  if (!url) return <div className="doc-tile-placeholder" />
  return (
    <>
      <img
        src={url}
        alt={doc.name}
        onError={(e) => {
          const target = e.target as HTMLImageElement
          target.style.display = 'none'
          const next = target.nextElementSibling as HTMLElement
          if (next) next.style.display = 'block'
        }}
      />
      <div className="doc-tile-placeholder" style={{ display: 'none' }} />
    </>
  )
}

type SidebarFilter = 'owned' | 'shared' | 'public'
type Domain = 'local' | 'cloud'

export default function Documents() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [newDocPublic, setNewDocPublic] = useState(false)
  const [newDocKind, setNewDocKind] = useState<'part' | 'assembly'>('part')
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [shareDoc, setShareDoc] = useState<DocumentMeta | null>(null)
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>('owned')
  const [isTrashView, setIsTrashView] = useState(false)
  const [trashDocs, setTrashDocs] = useState<TrashDoc[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [activeDomain, setActiveDomain] = useState<Domain>('local')
  const [notice, setNotice] = useState<string | null>(null)
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<{ uuid: string; name: string } | null>(null)
  const [moveTarget, setMoveTarget] = useState<{ uuid: string; name: string; toCloud: boolean } | null>(null)
  const [unshareTarget, setUnshareTarget] = useState<DocumentMeta | null>(null)
  const { user, online, setOnline } = useAuth()
  // Guest sort lives on defaults only; the cloud preferences load is gated on a
  // signed-in session so a guest never fires a doomed 401 request.
  const { preferences, loading: prefsLoading, updatePreference } = useUserPreferences(!!user)
  const sortBy = preferences.document_sort

  // The two domains (doc-domain-move). Local is always home; the cloud domain is
  // additive and present only when this build has a server, a session is signed in,
  // AND the server is reachable -- a structural value, not a per-render backend-flag
  // fork. Losing any of the three (sign-out or going offline) makes the cloud domain
  // simply not available, dropping you back to local (session-logout-offline). The
  // owned/shared/public sub-filter, sharing and trash are all cloud-domain concepts
  // (the local IndexedDB library is identity-free), so they render only under Cloud.
  const cloudStore = backendBundle.cloudDocuments
  const cloudAvailable = cloudStore != null && user != null && online
  // Fall back to local if the cloud domain vanishes (sign-out / offline) while active.
  const onCloud = activeDomain === 'cloud' && cloudAvailable
  const activeStore = onCloud ? cloudStore! : backendBundle.documents

  // When the cloud domain disappears (logout or going offline), snap the view back
  // to a coherent local-only state so no stale cloud filter / trash view lingers.
  const prevCloudAvailable = useRef(cloudAvailable)
  useEffect(() => {
    prevCloudAvailable.current = cloudAvailable
    if (cloudAvailable) return
    setActiveDomain('local')
    setActiveFilter('owned')
    setIsTrashView(false)
  }, [cloudAvailable])

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  // Cross-domain copy confirmation is transient: clear it after a few seconds.
  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 4000)
    return () => clearTimeout(timer)
  }, [notice])

  const sortToApiParam = (sort: DocumentSort): string => {
    if (sort === 'date_newest_first') return 'modified'
    if (sort === 'date_oldest_first') return 'modified_asc'
    return 'name'
  }

  // Guards against a stale list response winning the race: switching domains
  // fires a new list against the new store, but the previous store's promise (a
  // slow local IndexedDB read can land after a fast cloud fetch) must not
  // overwrite it. Only the latest request gets to set state.
  const listReqRef = useRef(0)
  const fetchDocuments = useCallback((filter: string = 'owned', search: string = '') => {
    const reqId = ++listReqRef.current
    activeStore.list({ sort: sortToApiParam(sortBy), filter, search })
      .then(documents => {
        if (reqId !== listReqRef.current) return
        setDocuments(documents)
        setError(null)
      })
      .catch(e => {
        if (reqId !== listReqRef.current) return
        // Lost the server mid-session: report offline (drops the cloud domain and
        // re-fetches against local) instead of stranding the user on a hard error.
        if (onCloud && isConnectionError(e)) {
          setOnline(false)
          setError(null)
          setNotice('Cloud unavailable. Showing your local documents.')
          return
        }
        setError(parseHttpError(e, 'Failed to load documents'))
      })
  }, [sortBy, activeStore, onCloud, setOnline])

  useEffect(() => {
    if (prefsLoading) return
    setLoading(true)
    fetchDocuments(activeFilter, debouncedSearch)
    setLoading(false)
  }, [activeFilter, debouncedSearch, fetchDocuments, prefsLoading])

  const handleAddDocument = async () => {
    if (!newDocName.trim()) {
      setAddError('Document name cannot be empty')
      return
    }

    try {
      const { uuid } = await activeStore.create(newDocName.trim(), { is_public: newDocPublic })
      // `create` always makes an empty document, and empty content parses to a
      // part (DocumentPage routes on `kind`). An assembly is therefore a create
      // + save of its seed content, the same two-step handleImportFile uses, so
      // neither store adapter nor the backend learns what a `kind` is.
      if (newDocKind === 'assembly') {
        await activeStore.save(uuid, { content: stringifyYaml(emptyAssemblyDoc()) })
      }
      setNewDocName('')
      setShowAddForm(false)
      setAddError(null)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setAddError(parseHttpError(e, 'Failed to create document'))
    }
  }

  const handleDeleteDocument = async (uuid: string) => {
    try {
      await activeStore.remove(uuid)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to delete document'))
    }
  }

  const handleDuplicate = async (uuid: string) => {
    try {
      await activeStore.duplicate(uuid)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to duplicate document'))
    }
  }

  // Cross-domain copy verbs (doc-domain-move slice 4). Both leave the source
  // intact -- they bridge a mirror across the boundary, they do not move it. The
  // list is not refetched because the active domain (the one on screen) is
  // unchanged; only the OTHER domain gains a copy.
  const handleCopyToCloud = async (uuid: string, name: string) => {
    if (!cloudStore) return
    try {
      await pushDocument(backendBundle.documents, cloudStore, uuid)
      setNotice(`Copied "${name}" to Cloud`)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to copy document'))
    }
  }

  const handleCopyToLocal = async (uuid: string, name: string) => {
    if (!cloudStore) return
    try {
      await copyDocument(cloudStore, backendBundle.documents, uuid)
      setNotice(`Copied "${name}" to Local`)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to copy document'))
    }
  }

  // Cross-domain MOVE (doc-domain-move slice 5): copy across, then delete the
  // source. Destructive on the source side, so confirm first; the active list is
  // refetched because the moved tile leaves the domain on screen (unlike copy).
  const handleMoveToCloud = async (uuid: string, name: string) => {
    if (!cloudStore) return
    setMoveTarget({ uuid, name, toCloud: true })
  }

  const handleMoveToLocal = async (uuid: string, name: string) => {
    if (!cloudStore) return
    setMoveTarget({ uuid, name, toCloud: false })
  }

  const handleMoveConfirm = async () => {
    const target = moveTarget
    if (!target || !cloudStore) return
    setMoveTarget(null)
    try {
      if (target.toCloud) {
        await moveDocument(backendBundle.documents, cloudStore, target.uuid)
        setNotice(`Moved "${target.name}" to Cloud`)
      } else {
        await moveDocument(cloudStore, backendBundle.documents, target.uuid)
        setNotice(`Moved "${target.name}" to Local`)
      }
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to move document'))
    }
  }

  // Bulk push the whole local library up to the cloud.
  // Only unsynced docs move (markSynced clears dirty), so it is safe to
  // re-run. Both sides stay intact -- it mirrors, never moves.
  const handleSyncAll = async () => {
    if (!cloudStore) return
    try {
      const { pushed } = await syncAllDocuments(backendBundle.documents, cloudStore)
      setNotice(
        pushed.length > 0
          ? `Synced ${pushed.length} document${pushed.length === 1 ? '' : 's'} to Cloud`
          : 'Everything is already in sync',
      )
    } catch (e) {
      setError(parseHttpError(e, 'Failed to sync documents'))
    }
  }

  const handleExport = async (uuid: string, name: string) => {
    try {
      // Read the document text from whichever domain is active and download it.
      // Both stores answer load() the same way, so there is no backend fork here.
      const content = (await activeStore.load(uuid)).content
      const blob = new Blob([content], { type: 'text/yaml' })
      downloadBlob(blob, `${name}.yaml`)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to export document'))
    }
  }

  // Library backup: every listed document into one .oversolved bundle. This is
  // the static replacement for the admin backup feature; it also works against
  // the HTTP store (the zip layout matches the server-side admin backup).
  const handleExportAll = async () => {
    try {
      const all = await activeStore.list({ filter: 'owned' })
      if (all.length === 0) {
        setError('No documents to export')
        return
      }
      const blob = await exportBundle(activeStore, all.map(d => d.uuid))
      downloadBlob(blob, `oversolved-backup-${new Date().toISOString().slice(0, 10)}.oversolved`)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to export documents'))
    }
  }

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    e.target.value = ''  // allow re-importing the same file

    // A bundle (.oversolved/.zip) round-trips through the active store; a bare
    // .yaml stays on the single-document import path.
    if (/\.(oversolved|zip)$/i.test(file.name)) {
      try {
        await importBundle(activeStore, file)
        fetchDocuments(activeFilter, debouncedSearch)
      } catch (err) {
        setError(parseHttpError(err, 'Failed to import file'))
      }
      return
    }

    // A STEP file becomes a fresh document whose content is a single
    // import_step feature carrying the inline base64 bytes (parsed by the WASM
    // kernel, no server round-trip). Same shape Part.tsx produces on import.
    if (/\.(step|stp)$/i.test(file.name)) {
      try {
        await importStepFile(activeStore, file)
        fetchDocuments(activeFilter, debouncedSearch)
      } catch (err) {
        setError(parseHttpError(err, 'Failed to import STEP file'))
      }
      return
    }

    const name = file.name.replace(/\.yaml$/, '').replace(/\.yml$/, '')
    if (!name) {
      setError('Invalid filename')
      return
    }

    try {
      const text = await file.text()
      // Import into the active domain's store: create + save round-trips through
      // either store identically, so no backend fork.
      const { uuid } = await activeStore.create(name)
      await activeStore.save(uuid, { content: text })
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (err) {
      setError(parseHttpError(err, 'Failed to import document'))
    }
  }

  // Trash is a per-domain capability: the cloud trash is server-side, the local
  // trash is the IndexedDB soft delete's other half. The Trash view is one piece
  // of UI driven by whichever adapter the active domain provides.
  const activeTrash = onCloud ? backendBundle.trash : backendBundle.localTrash

  const fetchTrash = useCallback(async (domain: Domain) => {
    const adapter = domain === 'cloud' ? backendBundle.trash : backendBundle.localTrash
    if (!adapter) return
    setTrashLoading(true)
    try {
      setTrashDocs(await adapter.list())
    } catch (e) {
      setError(parseHttpError(e, 'Failed to load trash'))
    } finally {
      setTrashLoading(false)
    }
  }, [])

  const handleRecover = async (uuid: string) => {
    try {
      await activeTrash?.recover(uuid)
      fetchTrash(activeDomain)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to recover document'))
    }
  }

  const handlePermanentDelete = async (uuid: string, name: string) => {
    setPermanentDeleteTarget({ uuid, name })
  }

  const handlePermanentDeleteConfirm = async () => {
    const target = permanentDeleteTarget
    if (!target) return
    setPermanentDeleteTarget(null)
    try {
      await activeTrash?.purge(target.uuid)
      fetchTrash(activeDomain)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to delete document'))
    }
  }

  const formatDate = (isoString: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
    const diffMs = Date.now() - date.getTime()
    const diffSec = Math.floor(diffMs / 1000)
    if (diffSec < 60) return `${diffSec}s ago`
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `${diffMin}min ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  // One flat sidebar of items grouped under "Local" / "Cloud" dividers, replacing
  // the old Local/Cloud toggle: a click picks BOTH the domain and the view (a
  // filter, or the domain's Trash) in one go. The local home is identity-free, so
  // shared / public have no meaning there -- only its own documents and trash.
  type SidebarEntry =
    | { domain: Domain; label: string; icon: string; filter: SidebarFilter }
    | { domain: Domain; label: string; icon: string; trash: true }

  const localEntries: SidebarEntry[] = [
    { domain: 'local', label: 'Local Documents', icon: 'computer', filter: 'owned' },
    { domain: 'local', label: 'Local Trash', icon: 'delete_outline', trash: true },
  ]
  const cloudEntries: SidebarEntry[] = [
    { domain: 'cloud', label: 'My Documents', icon: 'folder', filter: 'owned' },
    { domain: 'cloud', label: 'Shared with me', icon: 'people', filter: 'shared' },
    { domain: 'cloud', label: 'Public Documents', icon: 'public', filter: 'public' },
    { domain: 'cloud', label: 'My Trash', icon: 'delete_outline', trash: true },
  ]

  const isEntryActive = (e: SidebarEntry): boolean => {
    if (e.domain !== activeDomain) return false
    return 'trash' in e ? isTrashView : !isTrashView && activeFilter === e.filter
  }

  const selectEntry = (e: SidebarEntry) => {
    setActiveDomain(e.domain)
    if ('trash' in e) {
      setIsTrashView(true)
      fetchTrash(e.domain)
    } else {
      setIsTrashView(false)
      setActiveFilter(e.filter)
    }
  }

  const renderEntry = (e: SidebarEntry) => (
    <div
      key={`${e.domain}-${e.label}`}
      className={`sidebar-item ${isEntryActive(e) ? 'active' : ''}`}
      onClick={() => selectEntry(e)}
      title={e.label}
    >
      <span className="material-icons sidebar-item-icon">{e.icon}</span>
      <span className="sidebar-item-label">{e.label}</span>
    </div>
  )

  return (
    <div className="documents">
      <AppHeader title="Documents">
        <div className="doc-controls">
          <div className="search-input-container">
            <span className="material-icons search-icon">search</span>
            <input
              type="text"
              placeholder="Search documents..."
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
            onClick={() => {
              const cycle: DocumentSort[] = ['alphabetical', 'date_newest_first', 'date_oldest_first']
              const next = cycle[(cycle.indexOf(sortBy) + 1) % cycle.length]
              updatePreference('document_sort', next)
            }}
            title={
              sortBy === 'alphabetical' ? 'Sort: A-Z (click for newest first)' :
              sortBy === 'date_newest_first' ? 'Sort: Newest first (click for oldest first)' :
              'Sort: Oldest first (click for A-Z)'
            }
          >
            <span className="material-icons">
              {sortBy === 'alphabetical' ? 'sort_by_alpha' : sortBy === 'date_newest_first' ? 'update' : 'history'}
            </span>
          </button>
          <button className="toolbar-btn" onClick={() => { setShowAddForm(!showAddForm); setNewDocKind('part'); setNewDocPublic(activeFilter === 'public') }} title="Add part">
            <span className="material-icons">add</span>
          </button>
          <button className="toolbar-btn" onClick={() => { setShowAddForm(!showAddForm); setNewDocKind('assembly'); setNewDocPublic(activeFilter === 'public') }} title="Add assembly">
            <span className="material-icons">account_tree</span>
          </button>
          <label className="toolbar-btn btn-import" title="Import STEP, YAML, or .oversolved bundle">
            <input
              type="file"
              accept=".step,.stp,.yaml,.yml,.oversolved,.zip"
              onChange={handleImportFile}
              className="file-upload-input"
            />
            <span className="material-icons">upload</span>
          </label>
          <button className="toolbar-btn" onClick={handleExportAll} title="Export all as .oversolved bundle">
            <span className="material-icons">archive</span>
          </button>
          {!onCloud && cloudAvailable && (
            <button className="toolbar-btn" onClick={handleSyncAll} title="Sync all to Cloud">
              <span className="material-icons">cloud_sync</span>
            </button>
          )}
        </div>
      </AppHeader>

      <div className="documents-layout">
        <aside className="documents-sidebar">
          <div className="sidebar-section-label">Local</div>
          {localEntries.map(renderEntry)}
          {cloudAvailable ? (
            <>
              <div className="sidebar-section-label">Cloud</div>
              {cloudEntries.map(renderEntry)}
            </>
          ) : cloudStore && !user ? (
            // A cloud domain exists in this build but you are a guest: offer to
            // sign in right where the Cloud section would otherwise be, so the
            // upgrade is one click from the library, not just the header.
            <>
              <div className="sidebar-section-label">Cloud</div>
              <Link to="/login" className="sidebar-item sidebar-item-login" title="Sign in to Cloud">
                <span className="material-icons sidebar-item-icon">login</span>
                <span className="sidebar-item-label">Sign in to Cloud</span>
              </Link>
            </>
          ) : null}
        </aside>

        <div className="documents-main">
          {notice && <p className="status notice">{notice}</p>}
          <Dialog
            isOpen={showAddForm}
            title={newDocKind === 'assembly' ? 'Create New Assembly' : 'Create New Part'}
            onClose={() => setShowAddForm(false)}
            onConfirm={handleAddDocument}
            confirmLabel="Create"
          >
            <input
              type="text"
              placeholder={newDocKind === 'assembly' ? 'Assembly name' : 'Document name'}
              value={newDocName}
              onChange={e => setNewDocName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleAddDocument()
                if (e.key === 'Escape') setShowAddForm(false)
              }}
              autoFocus
            />
            <label className="dialog-checkbox">
              <input
                type="checkbox"
                checked={newDocPublic}
                onChange={e => setNewDocPublic(e.target.checked)}
              />
              Public document
            </label>
            {addError && <p className="error-text">{addError}</p>}
          </Dialog>

          {shareDoc && (
            <ShareDialog
              isOpen={!!shareDoc}
              documentUuid={shareDoc.uuid}
              documentName={shareDoc.name}
              ownerUsername={shareDoc.owner_username}
              isOwner={shareDoc.is_owner}
              onClose={() => setShareDoc(null)}
            />
          )}

          <MessageDialog
            isOpen={permanentDeleteTarget != null}
            title="Permanently Delete"
            message={`Permanently delete "${permanentDeleteTarget?.name}"? This cannot be undone.`}
            variant="error"
            onClose={() => setPermanentDeleteTarget(null)}
            onConfirm={handlePermanentDeleteConfirm}
            confirmLabel="Delete"
            cancelLabel="Cancel"
          />

          <MessageDialog
            isOpen={moveTarget != null}
            title="Move Document"
            message={moveTarget?.toCloud
              ? `Move "${moveTarget?.name}" to Cloud? It will be removed from Local.`
              : `Move "${moveTarget?.name}" to Local? It will be removed from Cloud.`}
            variant="info"
            onClose={() => setMoveTarget(null)}
            onConfirm={handleMoveConfirm}
            confirmLabel="Move"
            cancelLabel="Cancel"
          />

          <MessageDialog
            isOpen={unshareTarget != null}
            title="Remove Shared Document"
            message={`Remove "${unshareTarget?.name}" from your shared documents?`}
            variant="info"
            onClose={() => setUnshareTarget(null)}
            onConfirm={() => {
              const u = unshareTarget
              if (!u) return
              setUnshareTarget(null)
              backendBundle.sharing?.leaveShare(u.uuid)
                .then(() => fetchDocuments(activeFilter, debouncedSearch))
                .catch(() => undefined)
            }}
            confirmLabel="Remove"
            cancelLabel="Cancel"
          />

          {isTrashView ? (
            <>
              {trashLoading && <p className="status">Loading trash...</p>}
              {!trashLoading && trashDocs.length === 0 && (
                <p className="status">Trash is empty.</p>
              )}
              {!trashLoading && trashDocs.length > 0 && (
                <div className="doc-tiles">
                  {trashDocs.map(doc => (
                      <div key={doc.uuid} className="doc-tile">
                        <div className="doc-tile-link">
                          <div className="doc-tile-preview">
                            <DocTilePreview doc={doc} store={activeStore} />
                          </div>
                          <div className="doc-tile-info">
                            <span className="doc-tile-name" title={`${doc.owner_username}/${doc.name}`}>
                              {doc.owner_username}/{doc.name}
                            </span>
                          </div>
                          <div className="doc-tile-meta">
                            <span className="doc-tile-date">
                              Deleted: {formatDate(doc.deleted_at)}
                            </span>
                            <div className="doc-tile-actions">
                              <button
                                className="btn btn-tile-action"
                                onClick={() => handleRecover(doc.uuid)}
                                title="Recover document"
                              >
                                <span className="material-icons">restore</span>
                              </button>
                              <button
                                className="btn btn-delete-tile"
                                onClick={() => handlePermanentDelete(doc.uuid, doc.name)}
                                title="Permanently delete"
                              >
                                <span className="material-icons">delete_forever</span>
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}

                </div>
              )}
            </>
          ) : (
            <>
              {loading && <p className="status">Loading documents...</p>}
              {error && <ErrorBanner message={`Error: ${error}`} onDismiss={() => setError(null)} />}
              {!loading && documents.length === 0 && debouncedSearch && (
                <p className="status">No documents match "{debouncedSearch}"</p>
              )}
              {!loading && documents.length === 0 && !debouncedSearch && (
                <p className="status">No documents yet.</p>
              )}

              {!loading && documents.length > 0 && (
                <div className="doc-tiles">
                  {documents.map(doc => (
                    <div key={doc.uuid} className="doc-tile">
                      <Link to={`/documents/${doc.uuid}`} className="doc-tile-link">
                        <div className="doc-tile-preview">
                          <DocTilePreview doc={doc} store={activeStore} />
                        </div>
                        <div className="doc-tile-info">
                          <span className="doc-tile-name" title={`${doc.owner_username}/${doc.name}`}>
                            {doc.owner_username}/{doc.name}
                          </span>
                        </div>
                        <div className="doc-tile-meta">
                          <span className="doc-tile-date">{formatDate(doc.updated_at)}</span>
                           <div className="doc-tile-actions">
                            {onCloud && doc.is_owner && (
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => setShareDoc(doc))}
                                title="Share document"
                              >
                                <span className="material-icons">share</span>
                              </button>
                            )}
                            {onCloud && !doc.is_owner && (
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => setUnshareTarget(doc))}
                                title="Unshare document"
                              >
                                <span className="material-icons">link_off</span>
                              </button>
                            )}
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => handleDuplicate(doc.uuid))}
                                title="Duplicate"
                              >
                              <span className="material-icons">content_copy</span>
                            </button>
                            {!onCloud && cloudAvailable && (
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => handleCopyToCloud(doc.uuid, doc.name))}
                                title="Copy to Cloud"
                              >
                                <span className="material-icons">cloud_upload</span>
                              </button>
                            )}
                            {!onCloud && cloudAvailable && (
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => handleMoveToCloud(doc.uuid, doc.name))}
                                title="Move to Cloud"
                              >
                                <span className="material-icons">drive_file_move</span>
                              </button>
                            )}
                            {onCloud && (
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => handleCopyToLocal(doc.uuid, doc.name))}
                                title="Copy to Local"
                              >
                                <span className="material-icons">cloud_download</span>
                              </button>
                            )}
                            {onCloud && doc.is_owner && (
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => handleMoveToLocal(doc.uuid, doc.name))}
                                title="Move to Local"
                              >
                                <span className="material-icons">drive_file_move</span>
                              </button>
                            )}
                              <button
                                className="btn btn-tile-action"
                                onClick={stopClick(() => handleExport(doc.uuid, doc.name))}
                                title="Export YAML"
                              >
                              <span className="material-icons">download</span>
                            </button>
                            {doc.is_owner && (
                              <button
                                className="btn btn-delete-tile"
                                onClick={stopClick(() => handleDeleteDocument(doc.uuid))}
                                title="Delete document"
                              >
                                <span className="material-icons">delete</span>
                              </button>
                            )}
                          </div>
                        </div>
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
