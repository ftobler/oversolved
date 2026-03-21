import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import Viewport from '../components/Viewport'
import type { Feature, SketchData } from '../components/Viewport'
import type { Sketch } from '../components/SketchSvg'
import { unflattenGeometry } from '../components/SketchSvg'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import type { Mutation } from '../stores/sketchEditorStore'
import type { PartDoc } from '../utils/yamlMutations'
import { applyMoveVertex, applyMoveEntity, applyAddConstraint, applyDeleteElements, applySetConstraintValue, applyAddEntity, applyAddRect } from '../utils/yamlMutations'
import { registerCommand, unregisterCommand, dispatchKey } from '../stores/commandRegistry'
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
import toolbarLineSwapIcon from '../assets/icons/constraint-line-swap.svg'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureCodeIcon from '../assets/icons/icon-code.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'
import viewportResetIcon from '../assets/icons/viewport-reset.svg'

function SketchToolbar({ onResetViewport }: { onResetViewport: () => void }) {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)
  const store = useSketchEditorStore.getState

  return (
    <>
      <button className="editor-btn" title="Reset Viewport" onClick={onResetViewport}>
        <img src={viewportResetIcon} alt="Reset Viewport" />
      </button>

      <div className="toolbar-separator" />

      {/* Dimension tool — activatable, appears before drawing tools */}
      <button
        className={`editor-btn ${activeTool === 'dimension' ? 'active' : ''}`}
        title="Dimension (D)"
        onClick={() => setActiveTool('dimension')}
      >
        <img src={toolbarDimensionIcon} alt="Dimension" />
      </button>

      {/* Drawing tools — TODO: insertion logic */}
      <button className={`editor-btn ${activeTool === 'line' ? 'active' : ''}`} title="Line" onClick={() => setActiveTool('line')}>
        <img src={toolbarLineIcon} alt="Line" />
      </button>
      <button className={`editor-btn ${activeTool === 'rect' ? 'active' : ''}`} title="Rectangle" onClick={() => setActiveTool('rect')}>
        <img src={toolbarRectangleIcon} alt="Rectangle" />
      </button>
      <button className={`editor-btn ${activeTool === 'circle' ? 'active' : ''}`} title="Circle" onClick={() => setActiveTool('circle')}>
        <img src={toolbarCircleIcon} alt="Circle" />
      </button>
      <button className={`editor-btn ${activeTool === 'arc' ? 'active' : ''}`} title="Arc" onClick={() => setActiveTool('arc')}>
        <img src={toolbarArcIcon} alt="Arc" />
      </button>
      <button className={`editor-btn ${activeTool === 'point' ? 'active' : ''}`} title="Point" onClick={() => setActiveTool('point')}>
        <img src={toolbarPointIcon} alt="Point" />
      </button>
      <button className="editor-btn" title="Line Swap" onClick={() => store().applyConstraint('colinear')}>
        <img src={toolbarLineSwapIcon} alt="Line Swap" />
      </button>

      <div className="toolbar-separator" />

      {/* Constraint buttons — act immediately, no mode change */}
      <button className="editor-btn" title="Horizontal (H)" onClick={() => store().applyConstraint('horizontal')}>
        <img src={toolbarHorizontalIcon} alt="Horizontal" />
      </button>
      <button className="editor-btn" title="Vertical (V)" onClick={() => store().applyConstraint('vertical')}>
        <img src={toolbarVerticalIcon} alt="Vertical" />
      </button>
      <button className="editor-btn" title="Coincident" onClick={() => store().applyConstraint('coincident')}>
        <img src={toolbarCoincidentIcon} alt="Coincident" />
      </button>
      <button className="editor-btn" title="Concentric" onClick={() => store().applyConstraint('concentric')}>
        <img src={toolbarConcentricIcon} alt="Concentric" />
      </button>
      <button className="editor-btn" title="Equal" onClick={() => store().applyConstraint('equal_length')}>
        <img src={toolbarEqualIcon} alt="Equal" />
      </button>
      <button className="editor-btn" title="Fixed" onClick={() => store().applyConstraint('fixed')}>
        <img src={toolbarFixedIcon} alt="Fixed" />
      </button>
      <button className="editor-btn" title="Midpoint" onClick={() => store().applyConstraint('midpoint')}>
        <img src={toolbarMidpointIcon} alt="Midpoint" />
      </button>
      <button className="editor-btn" title="Normal" onClick={() => store().applyConstraint('normal')}>
        <img src={toolbarNormalIcon} alt="Normal" />
      </button>
      <button className="editor-btn" title="Parallel" onClick={() => store().applyConstraint('parallel')}>
        <img src={toolbarParallelIcon} alt="Parallel" />
      </button>
      <button className="editor-btn" title="Perpendicular" onClick={() => store().applyConstraint('perpendicular')}>
        <img src={toolbarPerpendicularIcon} alt="Perpendicular" />
      </button>
      <button className="editor-btn" title="Tangent" onClick={() => store().applyConstraint('tangent')}>
        <img src={toolbarTangentIcon} alt="Tangent" />
      </button>
      <button className="editor-btn" title="Collinear" onClick={() => store().applyConstraint('collinear')}>
        <img src={toolbarCollinearIcon} alt="Collinear" />
      </button>
    </>
  )
}

const BUILT_IN_FEATURES: Array<{ id: string; kind?: string }> = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
]

function extractFeatures(doc: PartDoc): Array<{ id: string; kind?: string }> {
  return [...BUILT_IN_FEATURES, ...(doc.features ?? []).map(f => ({ id: f.id, kind: f.kind }))]
}

export default function Part() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<PartDoc | null>(null)
  const docRef = useRef<PartDoc | null>(null)
  const [codeText, setCodeText] = useState('')  // textarea content in code mode
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docId || '')
  const [features, setFeatures] = useState<Array<{ id: string; kind?: string }>>([])
  const [visibleFeatures, setVisibleFeatures] = useState<Set<string>>(new Set())
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackPosition, setRollbackPosition] = useState<number | null>(null)

  const activeSketchFeatureId = useMemo(() => {
    const limit = rollbackPosition ?? features.length
    const sketches = features
      .slice(0, limit)
      .filter(f => f.kind === 'sketch' && visibleFeatures.has(f.id))
    return sketches.length > 0 ? sketches[sketches.length - 1].id : undefined
  }, [features, rollbackPosition, visibleFeatures])
  const [solveResult, setSolveResult] = useState<string>('')
  const [solveResults, setSolveResults] = useState<Record<string, SketchData>>({})
  const [viewportReset, setViewportReset] = useState(0)
  const [solving, setSolving] = useState(false)
  const [solveTime, setSolveTime] = useState<number | null>(null)
  const [undoStack, setUndoStack] = useState<PartDoc[]>([])
  const [redoStack, setRedoStack] = useState<PartDoc[]>([])
  const [solveError, setSolveError] = useState<string | null>(null)

  // Switching modes: serialize doc → codeText when entering code; parse codeText → doc when leaving code
  const setMode = useCallback((newMode: 'sketch' | 'feature' | 'code') => {
    setModeRaw(prev => {
      if (prev === 'code' && newMode !== 'code') {
        // Leaving code tab — parse edited text back into doc
        try {
          const parsed = parseYaml(codeText) as PartDoc
          docRef.current = parsed
          setDoc(parsed)
          setFeatures(extractFeatures(parsed))
        } catch { /* ignore parse errors — keep existing doc */ }
      }
      if (newMode === 'code' && docRef.current) {
        setCodeText(stringifyYaml(docRef.current))
      }
      return newMode
    })
  }, [codeText])

  // Re-solve: POST doc as JSON to /api/solve, update results.
  // On error: keep previous geometry visible; show error banner.
  // TODO: backend should return 200 with partial results instead of 400 for solver errors.
  const reSolve = useCallback(async (d: PartDoc) => {
    setSolving(true)
    setSolveTime(null)
    const startTime = performance.now()
    try {
      const response = await fetch('/api/solve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(d),
      })
      const data = await response.json()
      const endTime = performance.now()
      setSolveTime(Math.round((endTime - startTime) * 100) / 100)
      if (!response.ok) {
        setSolveError(data.error || `Solve failed (${response.status})`)
        // Keep previous solveResults visible — do NOT clear them
      } else {
        // Server returns solve results only — no echo of the input document.
        // geometry is flat array format: {entity_id: [x1, y1, x2, y2]} for lines, etc.
        // constraints are no longer included per new spec.
        const result = data.result as Record<string, { geometry?: Record<string, number[]>; status?: string; features?: Record<string, { status?: string }>; topology?: import('../components/SketchSvg').Topology }>

        const results: Record<string, SketchData> = {}
        for (const [id, feature] of Object.entries(result)) {
          if (feature.geometry) {
            // Find the feature definition
            const featureDef = (d.features ?? []).find(f => f.id === id)
            if (featureDef) {
              // Feed solved geometry back into the document's initial state
              featureDef.initial = feature.geometry
            }
            const solved = unflattenGeometry(feature.geometry, featureDef?.entities)

            results[id] = {
              solved,
              // Constraints no longer in response per new spec
              topology: feature.topology,
            }
          }
        }
        // Update both the cached solve results AND the primary document state
        setSolveResults(prev => ({ ...prev, ...results }))
        setDoc(d)
        docRef.current = d
        if (mode === 'code') {
          setCodeText(stringifyYaml(d))
        }
        setSolveError(null)
      }
    } catch (e) {
      setSolveError(String(e))
    } finally {
      setSolving(false)
    }
  }, [mode])

  // Mutation handler: deep-clone doc, apply mutation, update state, re-solve
  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    const current = docRef.current
    if (!current) return

    // Clear solveResults for the affected feature(s) to ensure the Viewport
    // renders the document AST state (initial) immediately instead of a stale
    // solved state. The conceptual contract is that the AST is the source of
    // truth for the client while solving happens in the background.
    setSolveResults(prev => {
      const next = { ...prev }
      if ('featureId' in m) {
        delete next[m.featureId]
      } else if (m.type === 'delete') {
        // Clear all or find affected features from targets
        return {}
      }
      return next
    })

    const next: PartDoc = JSON.parse(JSON.stringify(current))
    setUndoStack(prev => [...prev, current])
    setRedoStack([])
    switch (m.type) {
      case 'move_vertex':
        applyMoveVertex(next, m.featureId, m.entityId, m.vertexKey, m.to)
        break
      case 'move_entity':
        applyMoveEntity(next, m.featureId, m.entityId, m.delta)
        break
      case 'add_constraint':
        applyAddConstraint(next, m.featureId, m.kind, m.targets, m.value)
        break
      case 'set_constraint_value':
        applySetConstraintValue(next, m.featureId, m.constraintId, m.value)
        break
      case 'delete':
        applyDeleteElements(next, m.targets)
        break
      case 'add_entity':
        applyAddEntity(next, m.featureId, m.kind, m.params)
        break
      case 'add_rect':
        applyAddRect(next, m.featureId, m.p0, m.p1)
        break
    }
    docRef.current = next
    setDoc(next)
    setFeatures(extractFeatures(next))
    reSolve(next)
  }, [reSolve])

  // Register mutation handler in editor store
  useEffect(() => {
    useSketchEditorStore.getState().setOnMutation(handleMutation)
    return () => useSketchEditorStore.getState().setOnMutation(null)
  }, [handleMutation])

  // Undo handler
  const handleUndo = useCallback(() => {
    setUndoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const last = next.pop()!
      if (docRef.current) setRedoStack(r => [...r, docRef.current!])
      docRef.current = last
      setDoc(last)
      setFeatures(extractFeatures(last))
      reSolve(last)
      return next
    })
  }, [reSolve])

  // Redo handler
  const handleRedo = useCallback(() => {
    setRedoStack(prev => {
      if (prev.length === 0) return prev
      const next = [...prev]
      const last = next.pop()!
      if (docRef.current) setUndoStack(u => [...u, docRef.current!])
      docRef.current = last
      setDoc(last)
      setFeatures(extractFeatures(last))
      reSolve(last)
      return next
    })
  }, [reSolve])

  // Register commands and keyboard shortcuts via central command registry
  useEffect(() => {
    registerCommand('undo', handleUndo)
    registerCommand('redo', handleRedo)
    registerCommand('delete_selected', () => useSketchEditorStore.getState().deleteSelected())
    registerCommand('apply_dimension', () => useSketchEditorStore.getState().setActiveTool('dimension'))
    registerCommand('apply_horizontal', () => useSketchEditorStore.getState().applyConstraint('horizontal'))
    registerCommand('apply_vertical', () => useSketchEditorStore.getState().applyConstraint('vertical'))
    registerCommand('cancel_draw', () => {
      useSketchEditorStore.getState().clearDraw()
      useSketchEditorStore.getState().setActiveTool('select')
    })
    window.addEventListener('keydown', dispatchKey)
    return () => {
      window.removeEventListener('keydown', dispatchKey)
      unregisterCommand('undo')
      unregisterCommand('redo')
      unregisterCommand('delete_selected')
      unregisterCommand('apply_dimension')
      unregisterCommand('apply_horizontal')
      unregisterCommand('apply_vertical')
      unregisterCommand('cancel_draw')
    }
  }, [handleUndo, handleRedo])

  useEffect(() => {
    if (!docId) return

    fetch(`/api/documents/${docId}`)
      .then(r => {
        if (!r.ok) throw new Error('Failed to load document')
        return r.json()
      })
      .then(data => {
        const parsed = parseYaml(data.content) as PartDoc
        docRef.current = parsed
        setDoc(parsed)
        const extracted = extractFeatures(parsed)
        setFeatures(extracted)
        setVisibleFeatures(new Set(extracted.map(f => f.id)))
        setRollbackPosition(extracted.length)
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
        body: JSON.stringify({ content: stringifyYaml(doc ?? {}) }),
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
        body: JSON.stringify({ content: stringifyYaml(doc ?? {}) }),
      })

      if (!response.ok) throw new Error('Failed to save document')
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }

  const handleRun = async () => {
    setSolveResult('')
    // Parse the code tab textarea, update doc, then solve
    let parsed: PartDoc
    try {
      parsed = parseYaml(codeText) as PartDoc
    } catch (e) {
      setSolveResult(`Parse error: ${e}`)
      return
    }
    docRef.current = parsed
    setDoc(parsed)
    setFeatures(extractFeatures(parsed))
    reSolve(parsed)
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
            Oversolved
          </button>
          <button className="toolbar-btn" title="Undo" onClick={handleUndo} disabled={undoStack.length === 0}>
            <span className="material-icons-outlined">undo</span>
          </button>
          <button className="toolbar-btn" title="Redo" onClick={handleRedo} disabled={redoStack.length === 0}>
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
              onKeyDown={e => {
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
            <span className="material-icons-outlined">help</span>
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
                    className={`feature-item ${index >= (rollbackPosition ?? features.length) ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''}`}
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
                <img src={featureSketchIcon} alt="Sketch" />
              </button>
              <button
                className={`mode-btn ${mode === 'feature' ? 'active' : ''}`}
                onClick={() => setMode('feature')}
                title="Feature mode"
              >
                <img src={featurePartIcon} alt="Feature" />
              </button>
              <button
                className={`mode-btn ${mode === 'code' ? 'active' : ''}`}
                onClick={() => setMode('code')}
                title="Code mode"
              >
                <img src={featureCodeIcon} alt="Code" />
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

            {mode === 'sketch' && <SketchToolbar onResetViewport={() => setViewportReset(v => v + 1)} />}

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

          {solveError && (
            <div className="solve-error-banner">
              Solver error: {solveError}
              <button className="solve-error-dismiss" onClick={() => setSolveError(null)}>×</button>
            </div>
          )}
          {loading && <p className="status">Loading document...</p>}
          {error && <p className="status error">Error: {error}</p>}
          {!loading && !error && (
            <>
              {mode === 'code' && (
                <div className="code-split">
                  <textarea
                    className="code-input"
                    value={codeText}
                    onChange={e => setCodeText(e.target.value)}
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
              {mode !== 'code' && <Viewport features={features as Feature[]} featureDefs={doc?.features} rollbackPosition={rollbackPosition ?? undefined} visibleFeatures={visibleFeatures} solveResults={solveResults} resetTrigger={viewportReset} activeFeatureId={activeSketchFeatureId} />}
            </>
          )}
        </div>
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
      </footer>
    </div>
  )
}
