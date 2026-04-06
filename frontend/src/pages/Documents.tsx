import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import './Documents.css'

interface DocumentMeta {
  uuid: string
  name: string
  preview_image?: string
}

export default function Documents() {
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newDocName, setNewDocName] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

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

  return (
    <div className="documents">
      <AppHeader title="Documents" />

      <div className="doc-grid-container">
        <div className="doc-controls">
          <button className="btn btn-add" onClick={() => setShowAddForm(!showAddForm)}>
            <span className="material-icons">add</span>
            Add
          </button>
        </div>

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
        {!loading && documents.length === 0 && <p className="status">No documents yet.</p>}

        {!loading && documents.length > 0 && (
          <div className="doc-tiles">
            {documents.map(doc => (
              <div key={doc.uuid} className="doc-tile">
                <Link to={`/documents/${doc.uuid}`} className="doc-tile-link">
                  <div className="doc-tile-preview">
                    {doc.preview_image
                      ? <img src={`data:image/png;base64,${doc.preview_image}`} alt={doc.name} />
                      : <div className="doc-tile-placeholder" />}
                  </div>
                  <div className="doc-tile-info">
                    <span className="doc-tile-name" title={doc.name}>{doc.name}</span>
                  </div>
                </Link>
                <button
                  className="btn btn-delete-tile"
                  onClick={e => {
                    e.preventDefault()
                    handleDeleteDocument(doc.uuid, doc.name)
                  }}
                  title="Delete document"
                >
                  <span className="material-icons">delete</span>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
