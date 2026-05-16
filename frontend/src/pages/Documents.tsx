import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '@/components/AppHeader'
import Dialog from '@/components/Dialog'
import ShareDialog from '@/components/ShareDialog'
import { useUserPreferences } from '@/hooks/useUserPreferences'
import type { DocumentSort } from '@/hooks/useUserPreferences'
import { http, HttpError } from '@/utils/httpClient'
import '@/pages/Documents.css'

interface DocumentMeta {
  uuid: string
  name: string
  created_at: string
  updated_at: string
  is_owner: boolean
  owner_username: string
  is_public: boolean
}

interface TrashDoc {
  uuid: string
  name: string
  deleted_at: string
  created_at: string
  owner_id: number
  owner_username: string
}

type SidebarFilter = 'owned' | 'shared' | 'public'

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
  const { preferences, loading: prefsLoading, updatePreference } = useUserPreferences()
  const sortBy = preferences.document_sort

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchQuery), 300)
    return () => clearTimeout(timer)
  }, [searchQuery])

  const sortToApiParam = (sort: DocumentSort): string => {
    if (sort === 'date_newest_first') return 'modified'
    if (sort === 'date_oldest_first') return 'modified_asc'
    return 'name'
  }

  const fetchDocuments = useCallback((filter: string = 'owned', search: string = '') => {
    const params = new URLSearchParams()
    params.set('sort', sortToApiParam(sortBy))
    params.set('filter', filter)
    if (search) params.set('search', search)

    http.getJson<{ documents: DocumentMeta[] }>(`/api/documents?${params.toString()}`)
      .then(data => {
        setDocuments(data.documents || [])
        setError(null)
      })
      .catch(e => {
        setError(String(e))
      })
  }, [sortBy])

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
      await http.postJson<{ uuid: string }>('/api/documents', { name: newDocName.trim(), is_public: newDocPublic })
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
      await http.deleteJson(`/api/documents/${uuid}`)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDuplicate = async (uuid: string) => {
    try {
      await http.postJson(`/api/documents/${uuid}/duplicate`)
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

  const handleExport = async (uuid: string, name: string) => {
    try {
      const data = await http.getJson<{ content: string }>(`/api/documents/${uuid}/export`)
      const blob = new Blob([data.content], { type: 'text/yaml' })
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

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return

    const name = file.name.replace(/\.yaml$/, '').replace(/\.yml$/, '')
    if (!name) {
      setError('Invalid filename')
      return
    }

    try {
      const text = await file.text()
      await http.postJson('/api/documents/import', { name, content: text })
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

  const sidebarItems: { label: string; filter: SidebarFilter; icon: string }[] = [
    { label: 'My Documents', filter: 'owned', icon: 'folder' },
    { label: 'Shared with me', filter: 'shared', icon: 'people' },
    { label: 'Public Documents', filter: 'public', icon: 'public' },
  ]

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
          <label className="toolbar-btn btn-import" title="Import YAML">
            <input
              type="file"
              accept=".yaml,.yml"
              onChange={handleImportFile}
              className="file-upload-input"
            />
            <span className="material-icons">upload</span>
          </label>
        </div>
      </AppHeader>

      <div className="documents-layout">
        <aside className="documents-sidebar">
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
          <div
            className={`sidebar-item ${isTrashView ? 'active' : ''}`}
            onClick={() => { if (!isTrashView) { setIsTrashView(true); fetchTrash() } }}
            title="Trash"
          >
            <span className="material-icons sidebar-item-icon">delete_outline</span>
            <span className="sidebar-item-label">Trash</span>
          </div>
        </aside>

        <div className="documents-main">
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
                          <span className="doc-tile-date">{formatDate(doc.updated_at)}</span>
                           <div className="doc-tile-actions">
                            {doc.is_owner && (
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
                            {!doc.is_owner && (
                              <button
                                className="btn btn-tile-action"
                                onClick={e => {
                                  e.preventDefault()
                                  e.stopPropagation()
                                  if (window.confirm('Remove this shared document?')) {
                                    http.deleteJson(`/api/documents/${doc.uuid}/share`)
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
