import { useEffect, useState, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '@/components/layout/AppHeader'
import Dialog from '@/components/dialogs/Dialog'
import ShareDialog from '@/components/dialogs/ShareDialog'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import type { DocumentSort } from '@/hooks/useUserPreferences'
import { http, HttpError } from '@/utils/core/httpClient'
import { exportBundle, importBundle, copyDocument, pushDocument, moveDocument, syncAllDocuments } from '@/stores/documentStore'
import type { DocSummary } from '@/stores/documentStore'
import { backendBundle } from '@/adapters/backend'
import { useAuth } from '@/contexts/AuthContext'
import '@/pages/Documents.css'

type DocumentMeta = DocSummary

interface TrashDoc {
  uuid: string
  name: string
  deleted_at: string
  created_at: string
  owner_id: number
  owner_username: string
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
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [shareDoc, setShareDoc] = useState<DocumentMeta | null>(null)
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>('owned')
  const [isTrashView, setIsTrashView] = useState(false)
  const [trashDocs, setTrashDocs] = useState<TrashDoc[]>([])
  const [trashLoading, setTrashLoading] = useState(false)
  const [activeDomain, setActiveDomain] = useState<Domain>('local')
  const [notice, setNotice] = useState<string | null>(null)
  const [bridgeCount, setBridgeCount] = useState(0)  // 0 = the post-login bridge prompt is hidden
  const { preferences, loading: prefsLoading, updatePreference } = useUserPreferences()
  const sortBy = preferences.document_sort
  const { user } = useAuth()

  // The two domains (doc-domain-move). Local is always home; the cloud domain is
  // additive and present only when this build has a server AND a session is signed
  // in -- a structural value resolved once, not a per-render backend-flag fork. The
  // owned/shared/public sub-filter, sharing and trash are all cloud-domain concepts
  // (the local IndexedDB library is identity-free), so they render only under Cloud.
  const cloudStore = backendBundle.cloudDocuments
  const cloudAvailable = cloudStore != null && user != null
  // Fall back to local if the cloud domain vanishes (sign-out) while it was active.
  const onCloud = activeDomain === 'cloud' && cloudAvailable
  const activeStore = onCloud ? cloudStore! : backendBundle.documents

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
        setError(String(e))
      })
  }, [sortBy, activeStore])

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
      await activeStore.create(newDocName.trim(), { is_public: newDocPublic })
      setNewDocName('')
      setShowAddForm(false)
      setAddError(null)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setAddError(parsed.error || 'Failed to create document')
      } else {
        setAddError(String(e))
      }
    }
  }

  const handleDeleteDocument = async (uuid: string) => {
    try {
      await activeStore.remove(uuid)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDuplicate = async (uuid: string) => {
    try {
      await activeStore.duplicate(uuid)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to duplicate document')
      } else {
        setError(String(e))
      }
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
      setError(String(e))
    }
  }

  const handleCopyToLocal = async (uuid: string, name: string) => {
    if (!cloudStore) return
    try {
      await copyDocument(cloudStore, backendBundle.documents, uuid)
      setNotice(`Copied "${name}" to Local`)
    } catch (e) {
      setError(String(e))
    }
  }

  // Cross-domain MOVE (doc-domain-move slice 5): copy across, then delete the
  // source. Destructive on the source side, so confirm first; the active list is
  // refetched because the moved tile leaves the domain on screen (unlike copy).
  const handleMoveToCloud = async (uuid: string, name: string) => {
    if (!cloudStore) return
    if (!window.confirm(`Move "${name}" to Cloud? It will be removed from Local.`)) return
    try {
      await moveDocument(backendBundle.documents, cloudStore, uuid)
      setNotice(`Moved "${name}" to Cloud`)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleMoveToLocal = async (uuid: string, name: string) => {
    if (!cloudStore) return
    if (!window.confirm(`Move "${name}" to Local? It will be removed from Cloud.`)) return
    try {
      await moveDocument(cloudStore, backendBundle.documents, uuid)
      setNotice(`Moved "${name}" to Local`)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(String(e))
    }
  }

  // Bulk push the whole local library up to the cloud (doc-domain-move slice 5).
  // Drives both the toolbar "Sync all" verb and the post-login bridge prompt's
  // "Copy all". Only unsynced docs move (markSynced clears dirty), so it is safe to
  // re-run. Both sides stay intact -- it mirrors, never moves.
  const handleSyncAll = async () => {
    if (!cloudStore) return
    setBridgeCount(0)  // dismiss the bridge prompt if this came from it
    try {
      const { pushed } = await syncAllDocuments(backendBundle.documents, cloudStore)
      setNotice(
        pushed.length > 0
          ? `Synced ${pushed.length} document${pushed.length === 1 ? '' : 's'} to Cloud`
          : 'Everything is already in sync',
      )
    } catch (e) {
      setError(String(e))
    }
  }

  // Post-login bridge prompt (doc-domain-move slice 5 / static-build-notes "you have
  // two domains now -- copy local -> cloud?"). When the cloud domain first becomes
  // available (sign-in), offer once to mirror the local library up. An OFFER, both
  // sides left intact; dismissing changes nothing. sessionStorage keeps it to one
  // prompt per tab session so a reload that restores the session does not nag.
  const prevCloudAvailable = useRef(cloudAvailable)
  useEffect(() => {
    const was = prevCloudAvailable.current
    prevCloudAvailable.current = cloudAvailable
    if (was || !cloudAvailable) return
    if (sessionStorage.getItem('docDomainBridgeSeen')) return
    backendBundle.documents.list({ filter: 'owned' })
      .then(local => {
        if (local.length === 0) return
        sessionStorage.setItem('docDomainBridgeSeen', '1')
        setBridgeCount(local.length)
      })
      .catch(() => undefined)
  }, [cloudAvailable])

  const dismissBridge = () => {
    sessionStorage.setItem('docDomainBridgeSeen', '1')
    setBridgeCount(0)
  }

  const handleExport = async (uuid: string, name: string) => {
    try {
      // Read the document text from whichever domain is active and download it.
      // Both stores answer load() the same way, so there is no backend fork here.
      const content = (await activeStore.load(uuid)).content
      const blob = new Blob([content], { type: 'text/yaml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}.yaml`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to export document')
      } else {
        setError(String(e))
      }
    }
  }

  // Library backup: every listed document into one .oversolved bundle. This is
  // the static replacement for the admin backup feature; it also works against
  // the HTTP store (the zip layout is identical to /api/admin/backup).
  const handleExportAll = async () => {
    try {
      const all = await activeStore.list({ filter: 'owned' })
      if (all.length === 0) {
        setError('No documents to export')
        return
      }
      const blob = await exportBundle(activeStore, all.map(d => d.uuid))
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `oversolved-backup-${new Date().toISOString().slice(0, 10)}.oversolved`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(String(e))
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
        setError(String(err))
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
      if (err instanceof HttpError) {
        const parsed = JSON.parse(err.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to import document')
      } else {
        setError(String(err))
      }
    }
  }

  const fetchTrash = useCallback(async () => {
    setTrashLoading(true)
    try {
      const data = await http.getJson<{ documents: TrashDoc[] }>('/api/documents/trash')
      setTrashDocs(data.documents || [])
    } catch (e) {
      setError(String(e))
    } finally {
      setTrashLoading(false)
    }
  }, [])

  const handleRecover = async (uuid: string) => {
    try {
      await http.postJson(`/api/documents/${uuid}/recover`)
      fetchTrash()
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to recover document')
      } else {
        setError(String(e))
      }
    }
  }

  const handlePermanentDelete = async (uuid: string, name: string) => {
    if (!confirm(`Permanently delete "${name}"? This cannot be undone.`)) {
      return
    }
    try {
      await http.deleteJson(`/api/documents/${uuid}/trash`)
      fetchTrash()
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to delete document')
      } else {
        setError(String(e))
      }
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

  const switchDomain = (d: Domain) => {
    setActiveDomain(d)
    setActiveFilter('owned')
    setIsTrashView(false)
  }

  // The local library is identity-free, so shared / public have no meaning there;
  // they (and trash) belong to the cloud domain only.
  const sidebarItems: { label: string; filter: SidebarFilter; icon: string }[] = onCloud
    ? [
        { label: 'My Documents', filter: 'owned', icon: 'folder' },
        { label: 'Shared with me', filter: 'shared', icon: 'people' },
        { label: 'Public Documents', filter: 'public', icon: 'public' },
      ]
    : [{ label: 'My Documents', filter: 'owned', icon: 'folder' }]

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
          <button className="toolbar-btn" onClick={() => { setShowAddForm(!showAddForm); setNewDocPublic(activeFilter === 'public') }} title="Add document">
            <span className="material-icons">add</span>
          </button>
          <label className="toolbar-btn btn-import" title="Import YAML or .oversolved bundle">
            <input
              type="file"
              accept=".yaml,.yml,.oversolved,.zip"
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
          {cloudAvailable && (
            <div className="domain-switch">
              <button
                className={`domain-switch-btn ${!onCloud ? 'active' : ''}`}
                onClick={() => switchDomain('local')}
                title="Local documents"
              >
                <span className="material-icons sidebar-item-icon">computer</span>
                Local
              </button>
              <button
                className={`domain-switch-btn ${onCloud ? 'active' : ''}`}
                onClick={() => switchDomain('cloud')}
                title="Cloud documents"
              >
                <span className="material-icons sidebar-item-icon">cloud</span>
                Cloud
              </button>
            </div>
          )}
          {sidebarItems.map(item => (
            <div
              key={item.filter}
              className={`sidebar-item ${!isTrashView && activeFilter === item.filter ? 'active' : ''}`}
              onClick={() => { setIsTrashView(false); setActiveFilter(item.filter) }}
            >
              <span className="material-icons sidebar-item-icon">{item.icon}</span>
              <span className="sidebar-item-label">{item.label}</span>
            </div>
          ))}
          {onCloud && (
            <div
              className={`sidebar-item ${isTrashView ? 'active' : ''}`}
              onClick={() => { if (!isTrashView) { setIsTrashView(true); fetchTrash() } }}
              title="Trash"
            >
              <span className="material-icons sidebar-item-icon">delete_outline</span>
              <span className="sidebar-item-label">Trash</span>
            </div>
          )}
        </aside>

        <div className="documents-main">
          {notice && <p className="status notice">{notice}</p>}
          {bridgeCount > 0 && (
            <div className="status bridge-prompt">
              <span>
                You're signed in. Copy your {bridgeCount} local document{bridgeCount === 1 ? '' : 's'} to Cloud?
              </span>
              <span className="bridge-prompt-actions">
                <button className="btn" onClick={handleSyncAll}>Copy all</button>
                <button className="btn btn-clear-search" onClick={dismissBridge}>Dismiss</button>
              </span>
            </div>
          )}
          <Dialog
            isOpen={showAddForm}
            title="Create New Document"
            onClose={() => setShowAddForm(false)}
            onConfirm={handleAddDocument}
            confirmLabel="Create"
          >
            <input
              type="text"
              placeholder="Document name"
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
                            <img
                              src={`/api/documents/${doc.uuid}/thumbnail`}
                              alt={doc.name}
                              onError={(e) => {
                                const target = e.target as HTMLImageElement
                                target.style.display = 'none'
                                const next = target.nextElementSibling as HTMLElement
                                if (next) next.style.display = 'block'
                              }}
                            />
                            <div className="doc-tile-placeholder" style={{display: 'none'}} />
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
              {error && <p className="status error">Error: {error}</p>}
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
                          {doc.preview_image ? (
                            <img
                              src={`data:image/png;base64,${doc.preview_image}`}
                              alt={doc.name}
                            />
                          ) : (
                            <>
                              <img
                                src={`/api/documents/${doc.uuid}/thumbnail`}
                                alt={doc.name}
                                onError={(e) => {
                                  const target = e.target as HTMLImageElement
                                  target.style.display = 'none'
                                  const next = target.nextElementSibling as HTMLElement
                                  if (next) next.style.display = 'block'
                                }}
                              />
                              <div className="doc-tile-placeholder" style={{display: 'none'}} />
                            </>
                          )}
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
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  setShareDoc(doc)
                                }}
                                title="Share document"
                              >
                                <span className="material-icons">share</span>
                              </button>
                            )}
                            {onCloud && !doc.is_owner && (
                              <button
                                className="btn btn-tile-action"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  if (window.confirm('Remove this shared document?')) {
                                    backendBundle.sharing?.leaveShare(doc.uuid)
                                      .then(() => fetchDocuments(activeFilter, debouncedSearch))
                                      .catch(() => undefined)
                                  }
                                }}
                                title="Unshare document"
                              >
                                <span className="material-icons">link_off</span>
                              </button>
                            )}
                            <button
                              className="btn btn-tile-action"
                              onClick={e => {
                                e.preventDefault()
                                e.stopPropagation()
                                handleDuplicate(doc.uuid)
                              }}
                              title="Duplicate"
                            >
                              <span className="material-icons">content_copy</span>
                            </button>
                            {!onCloud && cloudAvailable && (
                              <button
                                className="btn btn-tile-action"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleCopyToCloud(doc.uuid, doc.name)
                                }}
                                title="Copy to Cloud"
                              >
                                <span className="material-icons">cloud_upload</span>
                              </button>
                            )}
                            {!onCloud && cloudAvailable && (
                              <button
                                className="btn btn-tile-action"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleMoveToCloud(doc.uuid, doc.name)
                                }}
                                title="Move to Cloud"
                              >
                                <span className="material-icons">drive_file_move</span>
                              </button>
                            )}
                            {onCloud && (
                              <button
                                className="btn btn-tile-action"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleCopyToLocal(doc.uuid, doc.name)
                                }}
                                title="Copy to Local"
                              >
                                <span className="material-icons">cloud_download</span>
                              </button>
                            )}
                            {onCloud && doc.is_owner && (
                              <button
                                className="btn btn-tile-action"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleMoveToLocal(doc.uuid, doc.name)
                                }}
                                title="Move to Local"
                              >
                                <span className="material-icons">drive_file_move</span>
                              </button>
                            )}
                            <button
                              className="btn btn-tile-action"
                              onClick={e => {
                                e.preventDefault()
                                e.stopPropagation()
                                handleExport(doc.uuid, doc.name)
                              }}
                              title="Export YAML"
                            >
                              <span className="material-icons">download</span>
                            </button>
                            {doc.is_owner && (
                              <button
                                className="btn btn-delete-tile"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  handleDeleteDocument(doc.uuid)
                                }}
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
