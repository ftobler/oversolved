import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { parse as parseYaml } from 'yaml'
import Viewport from '../components/Viewport'
import type { Sketch, Constraints } from '../components/SketchSvg'
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
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'
import viewportResetIcon from '../assets/icons/viewport-reset.svg'

export default function Part() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const [content, setContent] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docId || '')
  const [features, setFeatures] = useState<Array<{ id: string; kind?: string }>>([])
  const [visibleFeatures, setVisibleFeatures] = useState<Set<string>>(new Set())

  const extractFeatures = (yaml: string) => {
    // Built-in features
    const builtInFeatures: Array<{ id: string; kind?: string }> = [
      { id: 'Origin', kind: 'origin' },
      { id: 'Top', kind: 'plane' },
      { id: 'Front', kind: 'plane' },
      { id: 'Right', kind: 'plane' },
    ]

    // Extract top-level features with their kind
    const lines = yaml.split('\n')
    const features: Array<{ id: string; kind?: string }> = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const idMatch = line.match(/^\s{0,3}- id:\s*(.+?)$/)
      if (idMatch) {
        const feature: { id: string; kind?: string } = { id: idMatch[1].trim() }

        // Look ahead for kind field (within next 10 lines)
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const nextLine = lines[j]
          // Stop looking if we hit another top-level item
          if (nextLine.match(/^\s{0,3}- id:/)) {
            break
          }
          const kindMatch = nextLine.match(/^\s+kind:\s*(.+?)$/)
          if (kindMatch) {
            feature.kind = kindMatch[1].trim()
            break
          }
        }

        features.push(feature)
      }
    }

    return [...builtInFeatures, ...features]
  }
  const [mode, setMode] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackPosition, setRollbackPosition] = useState<number>(4) // Start after built-in features
  const [solveResult, setSolveResult] = useState<string>('')
  const [solveSketch, setSolveSketch] = useState<{ initial: Sketch; solved: Sketch; constraints?: Constraints } | null>(null)
  const [viewportReset, setViewportReset] = useState(0)
  const [solving, setSolving] = useState(false)
  const [solveTime, setSolveTime] = useState<number | null>(null)

  useEffect(() => {
    if (!docId) return

    fetch(`/api/documents/${docId}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        setContent(data.content)
        const extracted = extractFeatures(data.content)
        setFeatures(extracted)
        setVisibleFeatures(new Set(extracted.map(f => f.id)))
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

  const handleSave = async () => {
    if (!docId) return

    try {
      const response = await fetch(`/api/documents/${docId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      })

      if (!response.ok) throw new Error('Failed to save document')
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleRun = async () => {
    setSolving(true)
    setSolveResult('')
    setSolveTime(null)
    const startTime = performance.now()
    try {
      // Parse YAML content to structured object
      const parsedContent = parseYaml(content)
      const response = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(parsedContent),
      })
      const data = await response.json()
      const endTime = performance.now()
      setSolveTime(Math.round((endTime - startTime) * 100) / 100)
      if (!response.ok) {
        setSolveResult(data.error || 'Solve failed')
        setSolveSketch(null)
      } else {
        // Convert JSON result to YAML format
        const jsonToYaml = (obj: unknown, indent = 0): string => {
          if (obj === null || obj === undefined) return 'null'
          if (typeof obj === 'string') return obj
          if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj)

          const nextSpaces = '  '.repeat(indent + 1)

          if (Array.isArray(obj)) {
            if (obj.length === 0) return '[]'
            return obj
              .map(item => `${nextSpaces}- ${jsonToYaml(item, indent + 1).trimStart()}`)
              .join('\n')
          }

          if (typeof obj === 'object') {
            const lines = Object.entries(obj).map(([key, value]) => {
              const yamlValue = jsonToYaml(value, indent + 1)
              if (typeof value === 'object' && value !== null) {
                return `${nextSpaces}${key}:\n${yamlValue}`
              }
              return `${nextSpaces}${key}: ${yamlValue}`
            })
            return lines.join('\n')
          }

          return String(obj)
        }
        const yamlStr = jsonToYaml(data.result)
        setSolveResult(yamlStr)

        // Extract first sketch geometry for 3D viewport
        const result = data.result as Record<string, { geometry?: { initial?: Sketch; solved?: Sketch }; constraints?: Constraints }>
        const firstSketch = Object.values(result).find(f => f.geometry?.solved)
        if (firstSketch?.geometry?.initial && firstSketch?.geometry?.solved) {
          setSolveSketch({
            initial: firstSketch.geometry.initial,
            solved: firstSketch.geometry.solved,
            constraints: firstSketch.constraints,
          })
        }
      }
    } catch (e) {
      setSolveResult(String(e))
    } finally {
      setSolving(false)
    }
  }

  const handleRollbackDragOver = (e: React.DragEvent, featureIndex: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    // Update position if after Origin (index >= 1)
    if (featureIndex >= 1) {
      setRollbackPosition(featureIndex + 1)
    }
  }

  const handleRollbackDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleRollbackDrop = (e: React.DragEvent, featureIndex: number) => {
    e.preventDefault()
    if (featureIndex >= 1) {
      setRollbackPosition(featureIndex + 1)
    }
  }

  const toggleVisibility = (featureId: string) => {
    setVisibleFeatures(prev => {
      const newSet = new Set(prev)
      if (newSet.has(featureId)) {
        newSet.delete(featureId)
      } else {
        newSet.add(featureId)
      }
      return newSet
    })
  }

  return (
    <div className="document-viewer">
      <header className="doc-toolbar">
        <div className="toolbar-left">
          <button className="toolbar-btn burger" title="Menu" onClick={() => navigate('/documents')}>
            <span className="material-icons-outlined">menu</span>
          </button>
          <button className="logo" onClick={() => navigate('/')}>
            Oversolve
          </button>
          <button className="toolbar-btn" title="Undo">
            <span className="material-icons-outlined">undo</span>
          </button>
          <button className="toolbar-btn" title="Redo">
            <span className="material-icons-outlined">redo</span>
          </button>
          <button className="toolbar-btn" title="Save" onClick={handleSave}>
            <span className="material-icons-outlined">save</span>
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
            <span className="material-icons-outlined">book_2</span>
          </Link>
          <Link to="/visualizer" className="toolbar-btn" title="Visualizer">
            <span className="material-icons-outlined">bug_report</span>
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
              features.map((feature, index) => (
                <div key={`feature-${feature.id}`}>
                  {rollbackPosition === index && (
                    <li
                      className="rollback-bar"
                      title="Rollback"
                      draggable
                      onDragStart={handleRollbackDragStart}
                      onDragOver={(e) => handleRollbackDragOver(e, index)}
                      onDrop={(e) => handleRollbackDrop(e, index)}
                    ></li>
                  )}
                  <li
                    key={feature.id}
                    className={`feature-item ${index >= rollbackPosition ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''}`}
                    onDragOver={(e) => handleRollbackDragOver(e, index)}
                    onDrop={(e) => handleRollbackDrop(e, index)}
                  >
                    <img
                      src={
                        feature.kind?.toLowerCase() === 'sketch'
                          ? featureSketchIcon
                          : feature.kind?.toLowerCase() === 'extrude'
                          ? featureExtrudeIcon
                          : feature.kind?.toLowerCase() === 'origin'
                          ? featureOriginIcon
                          : featurePlaneIcon
                      }
                      alt={feature.kind || 'feature'}
                      className="feature-icon"
                    />
                    <span className="feature-name">{feature.id}</span>
                    <button
                      className="feature-visibility-btn"
                      onClick={() => toggleVisibility(feature.id)}
                      title={visibleFeatures.has(feature.id) ? 'Hide' : 'Show'}
                    >
                      <span className="material-icons-outlined">
                        {visibleFeatures.has(feature.id) ? 'visibility' : 'visibility_off'}
                      </span>
                    </button>
                  </li>
                </div>
              ))
            )}
            {rollbackPosition === features.length && (
              <li
                className="rollback-bar"
                title="Rollback"
                draggable
                onDragStart={handleRollbackDragStart}
                onDragOver={(e) => {
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                }}
                onDrop={(e) => {
                  e.preventDefault()
                  setRollbackPosition(features.length)
                }}
              ></li>
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
                <button className="editor-btn" title="Run" onClick={handleRun} disabled={solving}>
                  <img src={toolbarPlayIcon} alt="Run" />
                </button>
                {solveTime !== null && (
                  <span className="solve-time">{solveTime}ms</span>
                )}
              </>
            )}

            {mode === 'sketch' && (
              <>
                <button className="editor-btn" title="Reset Viewport" onClick={() => setViewportReset(v => v + 1)}>
                  <img src={viewportResetIcon} alt="Reset Viewport" />
                </button>

                <div className="toolbar-separator" />

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
                  <img src={featureExtrudeIcon} alt="Extrude" />
                </button>
                <button className="editor-btn" title="Sketch">
                  <img src={featureSketchIcon} alt="Sketch" />
                </button>
              </>
            )}

          </div>

          {loading && <p className="status">Loading document...</p>}
          {error && <p className="status error">Error: {error}</p>}
          {!loading && !error && (
            <>
              {mode === 'code' && (
                <div className="code-split">
                  <textarea
                    className="code-input"
                    value={content}
                    onChange={e => {
                      setContent(e.target.value)
                      setFeatures(extractFeatures(e.target.value))
                    }}
                    placeholder="Document content..."
                    spellCheck="false"
                  />
                  <div className="code-result">
                    {solving
                      ? <span className="code-result-status">Solving...</span>
                      : solveResult
                      ? <pre>{solveResult}</pre>
                      : <span className="code-result-status">Press Run to solve</span>
                    }
                  </div>
                </div>
              )}
              {mode === 'sketch' && <Viewport sketch={solveSketch} resetTrigger={viewportReset} />}
              {mode === 'feature' && <Viewport sketch={solveSketch} resetTrigger={viewportReset} />}
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
