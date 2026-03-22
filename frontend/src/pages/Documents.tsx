import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import './Documents.css'

interface DocumentMeta {
  id: string
  preview: string
}

export default function Documents() {
  const navigate = useNavigate()
  const [documents, setDocuments] = useState<DocumentMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)
  const [newDocId, setNewDocId] = useState('')
  const [addError, setAddError] = useState<string | null>(null)

  const fetchDocuments = () => {
    fetch('/api/documents')
      .then(r => {
        if (!r.ok) throw new Error('Failed to fetch documents')
        return r.json()
      })
      .then(data => {
        const docs = (data.documents || []).map((id: string) => ({
          id,
          preview: '',
        }))
        setDocuments(docs)
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
    if (!newDocId.trim()) {
      setAddError('Document ID cannot be empty')
      return
    }

    try {
      const response = await fetch(`/api/documents/${newDocId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'version: 1\nkind: part\nfeatures: []\n' }),
      })

      if (!response.ok) {
        throw new Error('Failed to create document')
      }

      setNewDocId('')
      setShowAddForm(false)
      setAddError(null)
      fetchDocuments()
    } catch (e) {
      setAddError(String(e))
    }
  }

  const handleDeleteDocument = async (id: string) => {
    if (!confirm(`Delete document "${id}"?`)) {
      return
    }

    try {
      const response = await fetch(`/api/documents/${id}`, {
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
      <header className="doc-toolbar">
        <div className="toolbar-left">
          <button className="logo" onClick={() => navigate('/')}>
            Oversolved
          </button>
          <h2 className="doc-name">Documents</h2>
        </div>
        <div className="toolbar-right">
          <Link to="/docs" className="toolbar-btn" title="Documentation">
            <span className="material-icons-outlined">help</span>
          </Link>
          <Link to="/visualizer" className="toolbar-btn" title="Visualizer">
            <span className="material-icons-outlined">bug_report</span>
          </Link>
        </div>
      </header>

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
              placeholder="Document ID"
              value={newDocId}
              onChange={e => setNewDocId(e.target.value)}
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
              <li key={doc.id} className="doc-item">
                <Link to={`/documents/${doc.id}`} className="doc-link">
                  <span className="doc-name">{doc.id}</span>
                  {doc.preview && <span className="doc-preview">{doc.preview}</span>}
                </Link>
                <button
                  className="btn btn-delete"
                  onClick={e => {
                    e.preventDefault()
                    handleDeleteDocument(doc.id)
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
