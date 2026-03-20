import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import './Part.css'
import toolbarLineIcon from '../assets/icons/toolbar-line.svg'
import toolbarRectangleIcon from '../assets/icons/toolbar-rectangle.svg'
import toolbarCircleIcon from '../assets/icons/toolbar-circle.svg'
import toolbarArcIcon from '../assets/icons/toolbar-arc.svg'
import toolbarPointIcon from '../assets/icons/toolbar-point.svg'
import toolbarHorizontalIcon from '../assets/icons/constraint-horizontal.svg'
import toolbarVerticalIcon from '../assets/icons/constraint-vertical.svg'
import toolbarCoincidentIcon from '../assets/icons/constraint-coincident.svg'
import toolbarConcentricIcon from '../assets/icons/constraint-concentric.svg'
import toolbarEqualIcon from '../assets/icons/constraint-equal.svg'
import toolbarFixedIcon from '../assets/icons/constraint-fixed.svg'
import toolbarMidpointIcon from '../assets/icons/constraint-midpoint.svg'
import toolbarNormalIcon from '../assets/icons/constraint-normal.svg'
import toolbarParallelIcon from '../assets/icons/constraint-parallel.svg'
import toolbarPerpendicularIcon from '../assets/icons/constraint-square.svg'
import toolbarTangentIcon from '../assets/icons/constraint-tangent.svg'
import toolbarCollinearIcon from '../assets/icons/constraint-colinear.svg'
import toolbarDimensionIcon from '../assets/icons/constraint-dimension.svg'
import toolbarExtrudeIcon from '../assets/icons/toolbar-extrude.svg'
import toolbarSketchIcon from '../assets/icons/toolbar-sketch.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'

export default function Part() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docId || '')
  const [features, setFeatures] = useState<string[]>([])
  const [mode, setMode] = useState<'sketch' | 'feature' | 'code'>('sketch')

  useEffect(() => {
    if (!docId) return

    fetch(`/api/documents/${docId}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        setContent(data.content)
        // Extract top-level feature IDs from YAML (lines starting with "- id:" at column 0)
        const featureMatches = data.content.match(/^- id:\s*(.+?)$/gm) || []
        const featureIds = featureMatches.map((line: string) => line.replace(/^- id:\s*/, '').trim())
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
                <span className="btn-text">Sketch</span>
                <span className="btn-abbr">S</span>
              </button>
              <button
                className={`mode-btn ${mode === 'feature' ? 'active' : ''}`}
                onClick={() => setMode('feature')}
                title="Feature mode"
              >
                <span className="btn-text">Feature</span>
                <span className="btn-abbr">F</span>
              </button>
              <button
                className={`mode-btn ${mode === 'code' ? 'active' : ''}`}
                onClick={() => setMode('code')}
                title="Code mode"
              >
                <span className="btn-text">Code</span>
                <span className="btn-abbr">C</span>
              </button>
            </div>

            <div className="toolbar-separator" />

            {mode === 'code' && (
              <>
                <button className="editor-btn" title="Run">
                  <img src={toolbarPlayIcon} alt="Run" />
                </button>
              </>
            )}

            {mode === 'sketch' && (
              <>
                <button className="editor-btn" title="Line">
                  <img src={toolbarLineIcon} alt="Line" />
                </button>
                <button className="editor-btn" title="Rectangle">
                  <img src={toolbarRectangleIcon} alt="Rectangle" />
                </button>
                <button className="editor-btn" title="Circle">
                  <img src={toolbarCircleIcon} alt="Circle" />
                </button>
                <button className="editor-btn" title="Arc">
                  <img src={toolbarArcIcon} alt="Arc" />
                </button>
                <button className="editor-btn" title="Point">
                  <img src={toolbarPointIcon} alt="Point" />
                </button>

                <div className="toolbar-separator" />

                <button className="editor-btn" title="Horizontal">
                  <img src={toolbarHorizontalIcon} alt="Horizontal" />
                </button>
                <button className="editor-btn" title="Vertical">
                  <img src={toolbarVerticalIcon} alt="Vertical" />
                </button>
                <button className="editor-btn" title="Coincident">
                  <img src={toolbarCoincidentIcon} alt="Coincident" />
                </button>
                <button className="editor-btn" title="Concentric">
                  <img src={toolbarConcentricIcon} alt="Concentric" />
                </button>
                <button className="editor-btn" title="Equal">
                  <img src={toolbarEqualIcon} alt="Equal" />
                </button>
                <button className="editor-btn" title="Fixed">
                  <img src={toolbarFixedIcon} alt="Fixed" />
                </button>
                <button className="editor-btn" title="Midpoint">
                  <img src={toolbarMidpointIcon} alt="Midpoint" />
                </button>
                <button className="editor-btn" title="Normal">
                  <img src={toolbarNormalIcon} alt="Normal" />
                </button>
                <button className="editor-btn" title="Parallel">
                  <img src={toolbarParallelIcon} alt="Parallel" />
                </button>
                <button className="editor-btn" title="Perpendicular">
                  <img src={toolbarPerpendicularIcon} alt="Perpendicular" />
                </button>
                <button className="editor-btn" title="Tangent">
                  <img src={toolbarTangentIcon} alt="Tangent" />
                </button>
                <button className="editor-btn" title="Collinear">
                  <img src={toolbarCollinearIcon} alt="Collinear" />
                </button>

                <div className="toolbar-separator" />

                <button className="editor-btn" title="Dimension">
                  <img src={toolbarDimensionIcon} alt="Dimension" />
                </button>
              </>
            )}

            {mode === 'feature' && (
              <>
                <button className="editor-btn" title="Extrude">
                  <img src={toolbarExtrudeIcon} alt="Extrude" />
                </button>
                <button className="editor-btn" title="Sketch">
                  <img src={toolbarSketchIcon} alt="Sketch" />
                </button>
              </>
            )}

          </div>

          {loading && <p className="status">Loading document...</p>}
          {error && <p className="status error">Error: {error}</p>}
          {!loading && !error && (
            <>
              {mode === 'code' && (
                <textarea
                  value={content}
                  onChange={e => {
                    setContent(e.target.value)
                    // Update features list as user types (only top-level)
                    const featureMatches = e.target.value.match(/^- id:\s*(.+?)$/gm) || []
                    const featureIds = featureMatches.map((line: string) => line.replace(/^- id:\s*/, '').trim())
                    setFeatures(featureIds)
                  }}
                  placeholder="Document content..."
                  spellCheck="false"
                />
              )}
              {mode === 'sketch' && (
                <div className="viewer-placeholder">
                  Sketch Viewer
                </div>
              )}
              {mode === 'feature' && (
                <div className="viewer-placeholder">
                  Feature Viewer
                </div>
              )}
            </>
          )}
        </div>
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolve</p>
      </footer>
    </div>
  )
}
