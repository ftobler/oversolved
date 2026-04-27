import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import './Documents.css'

interface DocumentMeta {
  uuid: string
  name: string
  preview_image?: string
  created_at: string
  updated_at: string
}

export default function Documents() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState('')

  const fetchDocuments = () => {
    fetch('/api/documents')
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
  }

  useEffect(() => {
    setLoading(true)
    fetchDocuments()
    setLoading(false)
  }, [])

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
      fetchDocuments()
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

      fetchDocuments()
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

      fetchDocuments()
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

      fetchDocuments()
    } catch (err) {
      setError(String(err))
    }
  }

  const filteredDocuments = documents.filter(doc =>
    doc.name.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const formatDate = (isoString: string) => {
    if (!isoString) return ''
    const date = new Date(isoString)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

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

      <div className="doc-grid-container">

        {showAddForm && (
          <div className="add-form">
            <input
              type="text"
              placeholder="Document name"
              value={newDocName}
              onChange={e => setNewDocName(e.target.value)}
              onKeyPress={e => {
                if (e.key === 'Enter') handleAddDocument()
              }}
              autoFocus
            />
            <button className="btn btn-primary" onClick={handleAddDocument}>
              Create
            </button>
            <button className="btn btn-secondary" onClick={() => setShowAddForm(false)}>
              Cancel
            </button>
            {addError && <p className="error-text">{addError}</p>}
          </div>
        )}

        {loading && <p className="status">Loading documents...</p>}
        {error && <p className="status error">Error: {error}</p>}
        {!loading && filteredDocuments.length === 0 && documents.length > 0 && searchQuery && (
          <p className="status">No documents match "{searchQuery}"</p>
        )}
        {!loading && documents.length === 0 && <p className="status">No documents yet.</p>}

        {!loading && filteredDocuments.length > 0 && (
          <div className="doc-tiles">
            {filteredDocuments.map(doc => (
              <div key={doc.uuid} className="doc-tile">
                <Link to={`/documents/${doc.uuid}`} className="doc-tile-link">
                  <div className="doc-tile-preview">
                    {doc.preview_image
                      ? <img src={`data:image/png;base64,${doc.preview_image}`} alt={doc.name} />
                      : <div className="doc-tile-placeholder" />}
                  </div>
                  <div className="doc-tile-info">
                    <span className="doc-tile-name" title={doc.name}>{doc.name}</span>
                    <div className="doc-tile-actions">
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
                    </div>
                  </div>
                  <div className="doc-tile-date">
                    Modified: {formatDate(doc.updated_at)}
                  </div>
                </Link>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
