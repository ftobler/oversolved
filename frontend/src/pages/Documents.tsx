import { useEffect, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import Dialog from '../components/Dialog'
import ShareDialog from '../components/ShareDialog'
import { useUserPreferences, DocumentSort } from '../hooks/useUserPreferences'
import './Documents.css'

interface DocumentMeta {
  uuid: string
  name: string
  created_at: string
  updated_at: string
  is_owner: boolean
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
  const [searchQuery, setSearchQuery] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [shareDoc, setShareDoc] = useState<DocumentMeta | null>(null)
  const [activeFilter, setActiveFilter] = useState<SidebarFilter>('owned')
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

    fetch(`/api/documents?${params.toString()}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to fetch documents')
        return r.json()
      })
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
      const response = await fetch('/api/documents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newDocName.trim() }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to create document')
      }

      setNewDocName('')
      setShowAddForm(false)
      setAddError(null)
      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setAddError(String(e))
    }
  }

  const handleDeleteDocument = async (uuid: string, name: string) => {
    if (!confirm(`Delete document "${name}"?`)) {
      return
    }

    try {
      const response = await fetch(`/api/documents/${uuid}`, {
        method: 'DELETE',
      })

      if (!response.ok) {
        throw new Error('Failed to delete document')
      }

      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDuplicate = async (uuid: string) => {
    try {
      const response = await fetch(`/api/documents/${uuid}/duplicate`, {
        method: 'POST',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to duplicate document')
      }

      fetchDocuments(activeFilter, debouncedSearch)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleClone = async (uuid: string) => {
    try {
      const response = await fetch(`/api/documents/${uuid}/clone`, {
        method: 'POST',
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to clone document')
      }

      const data = await response.json()
      window.location.href = `/documents/${data.uuid}`
    } catch (e) {
      setError(String(e))
    }
  }

  const handleExport = async (uuid: string, name: string) => {
    try {
      const response = await fetch(`/api/documents/${uuid}/export`)
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to export document')
      }

      const data = await response.json()
      const blob = new Blob([data.content], { type: 'text/yaml' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `${name}.yaml`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(String(e))
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
      const response = await fetch('/api/documents/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, content: text }),
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to import document')
      }

      fetchDocuments(activeFilter, debouncedSearch)
    } catch (err) {
      setError(String(err))
    }
  }

  const formatDate = (isoString: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
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
          <button className="toolbar-btn" onClick={() => setShowAddForm(!showAddForm)} title="Add document">
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
              className={`sidebar-item ${activeFilter === item.filter ? 'active' : ''}`}
              onClick={() => setActiveFilter(item.filter)}
            >
              <span className="material-icons sidebar-item-icon">{item.icon}</span>
              <span className="sidebar-item-label">{item.label}</span>
            </div>
          ))}
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
            {addError && <p className="error-text">{addError}</p>}
          </Dialog>

          {shareDoc && (
            <ShareDialog
              isOpen={!!shareDoc}
              documentUuid={shareDoc.uuid}
              documentName={shareDoc.name}
              isOwner={shareDoc.is_owner}
              onClose={() => setShareDoc(null)}
            />
          )}

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
                <div key={doc.uuid} className={`doc-tile${doc.is_owner ? '' : ' shared'}`}>
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
                      <span className="doc-tile-name" title={doc.name}>{doc.name}</span>
                      <div className="doc-tile-actions">
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
                            handleClone(doc.uuid)
                          }}
                          title="Clone document"
                        >
                          <span className="material-icons">file_copy</span>
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
                              handleDeleteDocument(doc.uuid, doc.name)
                            }}
                            title="Delete document"
                          >
                            <span className="material-icons">delete</span>
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="doc-tile-meta">
                      <span className="doc-tile-date">Modified: {formatDate(doc.updated_at)}</span>
                      <span className="doc-tile-owner">
                        owned by {doc.is_owner ? 'me' : doc.owner_username}
                      </span>
                    </div>
                    {!doc.is_owner && (
                      <div className="doc-tile-shared-indicator">
                        <span className="material-icons">people</span>
                      </div>
                    )}
                  </Link>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
