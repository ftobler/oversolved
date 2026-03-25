import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import AppHeader from '../components/AppHeader'
import './Documents.css'

interface DocumentMeta {
  uuid: string
  name: string
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

      <div className="doc-list">
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

        {documents.length > 0 && (
          <ul>
            {documents.map(doc => (
              <li key={doc.uuid} className="doc-item">
                <Link to={`/documents/${doc.uuid}`} className="doc-link">
                  <span className="doc-name">{doc.name}</span>
                </Link>
                <button
                  className="btn btn-delete"
                  onClick={e => {
                    e.preventDefault()
                    handleDeleteDocument(doc.uuid, doc.name)
                  }}
                  title="Delete document"
                >
                  <span className="material-icons">delete</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
