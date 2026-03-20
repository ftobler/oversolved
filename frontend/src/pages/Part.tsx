import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import './Part.css'

export default function Part() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docId || '')
  const [features, setFeatures] = useState<string[]>([])
  const [mode, setMode] = useState<'sketch' | 'feature'>('sketch')

  useEffect(() => {
    if (!docId) return

    fetch(`/api/documents/${docId}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        setContent(data.content)
        // Extract feature IDs from YAML (lines starting with "- id:")
        const featureMatches = data.content.match(/^\s*- id:\s*(.+?)$/gm) || []
        const featureIds = featureMatches.map((line: string) => line.replace(/^\s*- id:\s*/, '').trim())
        setFeatures(featureIds)
        setLoading(false)
      })
      .catch(e => {
        setError(String(e))
        setLoading(false)
      })
  }, [docId])

  const handleRename = async () => {
    if (!editName.trim() || editName === docId) {
      setIsEditing(false)
      return
    }

    try {
      // Copy content to new ID
      const response = await fetch(`/api/documents/${editName}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) throw new Error('Failed to rename document')

      // Delete old ID
      await fetch(`/api/documents/${docId}`, { method: 'DELETE' })

      setIsEditing(false)
      navigate(`/documents/${editName}`)
    } catch (e) {
      setError(String(e))
      setEditName(docId || '')
    }
  }

  return (
    <div className="document-viewer">
      <header className="doc-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn burger" title="Menu" onClick={() => navigate('/documents')}>
            <span className="material-icons">menu</span>
          </button>
          <button className="logo" onClick={() => navigate('/')}>
            Oversolve
          </button>
          <button className="toolbar-btn" title="Undo">
            <span className="material-icons">undo</span>
          </button>
          <button className="toolbar-btn" title="Redo">
            <span className="material-icons">redo</span>
          </button>
          <button className="toolbar-btn" title="Save">
            <span className="material-icons">save</span>
          </button>
          {isEditing ? (
            <input
              className="doc-name-input"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onBlur={handleRename}
              onKeyPress={e => {
                if (e.key === 'Enter') handleRename()
              }}
              autoFocus
            />
          ) : (
            <h2 className="doc-name" onClick={() => setIsEditing(true)}>
              {docId}
            </h2>
          )}
        </div>

        <div className="toolbar-center">
        </div>

        <div className="toolbar-right">
          <Link to="/docs" className="toolbar-btn" title="Documentation">
            <span className="material-icons">help</span>
          </Link>
          <Link to="/visualizer" className="toolbar-btn" title="Visualizer">
            <span className="material-icons">bug_report</span>
          </Link>
        </div>
      </header>

      <div className="doc-container">
        <aside className="doc-sidebar">
          <div className="sidebar-header">Features</div>
          <ul className="features-list">
            {features.length === 0 ? (
              <li className="empty">No features</li>
            ) : (
              features.map(feature => (
                <li key={feature} className="feature-item">
                  {feature}
                </li>
              ))
            )}
          </ul>
        </aside>

        <div className="doc-editor">
          <div className="editor-toolbar">
            <div className="mode-selector">
              <button
                className={`mode-btn ${mode === 'sketch' ? 'active' : ''}`}
                onClick={() => setMode('sketch')}
                title="Sketch mode"
              >
                Sketch
              </button>
              <button
                className={`mode-btn ${mode === 'feature' ? 'active' : ''}`}
                onClick={() => setMode('feature')}
                title="Feature mode"
              >
                Feature
              </button>
            </div>

            <div className="toolbar-separator" />

            {mode === 'sketch' && (
              <>
                <button className="editor-btn" title="Line">
                  <span className="material-icons">minus</span>
                </button>
                <button className="editor-btn" title="Rectangle">
                  <span className="material-icons">rectangle</span>
                </button>
                <button className="editor-btn" title="Circle">
                  <span className="material-icons">circle</span>
                </button>
                <button className="editor-btn" title="Arc">
                  <span className="material-icons">arc</span>
                </button>
                <button className="editor-btn" title="Point">
                  <span className="material-icons">fiber_manual_record</span>
                </button>

                <div className="toolbar-separator" />

                <button className="editor-btn" title="Horizontal">
                  <span className="material-icons">drag_handle</span>
                </button>
                <button className="editor-btn" title="Vertical">
                  <span className="material-icons">unfold_more</span>
                </button>
                <button className="editor-btn" title="Coincident">
                  <span className="material-icons">ads_click</span>
                </button>
                <button className="editor-btn" title="Concentric">
                  <span className="material-icons">donut_large</span>
                </button>
                <button className="editor-btn" title="Equal">
                  <span className="material-icons">balance</span>
                </button>
                <button className="editor-btn" title="Fixed">
                  <span className="material-icons">lock</span>
                </button>
                <button className="editor-btn" title="Midpoint">
                  <span className="material-icons">location_on</span>
                </button>
                <button className="editor-btn" title="Normal">
                  <span className="material-icons">perpendicular</span>
                </button>
                <button className="editor-btn" title="Parallel">
                  <span className="material-icons">unfold_more</span>
                </button>
                <button className="editor-btn" title="Perpendicular">
                  <span className="material-icons">crop_square</span>
                </button>
                <button className="editor-btn" title="Tangent">
                  <span className="material-icons">gesture</span>
                </button>
                <button className="editor-btn" title="Collinear">
                  <span className="material-icons">shows_slash</span>
                </button>

                <div className="toolbar-separator" />

                <button className="editor-btn" title="Dimension">
                  <span className="material-icons">straighten</span>
                </button>
              </>
            )}

          </div>

          {loading && <p className="status">Loading document...</p>}
          {error && <p className="status error">Error: {error}</p>}
          {!loading && !error && (
            <textarea
              value={content}
              onChange={e => {
                setContent(e.target.value)
                // Update features list as user types
                const featureMatches = e.target.value.match(/^\s*- id:\s*(.+?)$/gm) || []
                const featureIds = featureMatches.map((line: string) => line.replace(/^\s*- id:\s*/, '').trim())
                setFeatures(featureIds)
              }}
              placeholder="Document content..."
              spellCheck="false"
            />
          )}
        </div>
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolve</p>
      </footer>
    </div>
  )
}
