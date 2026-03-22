import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import Viewport from '../components/Viewport'
import type { Feature, PartDoc } from '../types/cad'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { registerCommand, unregisterCommand, dispatchKey } from '../stores/commandRegistry'
import SketchToolbar from '../components/Toolbar/SketchToolbar'
import { usePartDoc } from '../hooks/usePartDoc'
import './Part.css'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureCodeIcon from '../assets/icons/icon-code.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'

const BUILT_IN_FEATURES: Array<{ id: string; kind?: string }> = [
  { id: 'Origin', kind: 'origin' },
  { id: 'Top', kind: 'plane' },
  { id: 'Front', kind: 'plane' },
  { id: 'Right', kind: 'plane' },
]

function extractFeatures(doc: PartDoc | null): Array<{ id: string; kind?: string }> {
  if (!doc) return BUILT_IN_FEATURES
  return [...BUILT_IN_FEATURES, ...(doc.features ?? []).map(f => ({ id: f.id, kind: f.kind }))]
}

export default function Part() {
  const { docId } = useParams<{ docId: string }>()
  const navigate = useNavigate()
  const [codeText, setCodeText] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState(docId || '')
  const [visibleFeatures, setVisibleFeatures] = useState<Set<string>>(new Set())
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackPosition, setRollbackPosition] = useState<number | null>(null)
  const [viewportReset, setViewportReset] = useState(0)

  const {
    doc,
    setDoc,
    docRef,
    loading,
    error,
    setError,
    solveResults,
    solving,
    solveTime,
    solveError,
    setSolveError,
    solveResult,
    undoStack,
    redoStack,
    reSolve,
    handleMutation,
    handleUndo,
    handleRedo,
    saveDoc,
  } = usePartDoc(docId, mode, setCodeText)

  const features = useMemo(() => extractFeatures(doc), [doc])

  useEffect(() => {
    if (doc && visibleFeatures.size === 0) {
      const extracted = extractFeatures(doc)
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setVisibleFeatures(new Set(extracted.map(f => f.id)))
      setRollbackPosition(extracted.length)
    }
  }, [doc, visibleFeatures.size])

  const activeSketchFeatureId = useMemo(() => {
    const limit = rollbackPosition ?? features.length
    const sketches = features
      .slice(0, limit)
      .filter(f => f.kind === 'sketch' && visibleFeatures.has(f.id))
    return sketches.length > 0 ? sketches[sketches.length - 1].id : undefined
  }, [features, rollbackPosition, visibleFeatures])

  const setMode = useCallback((newMode: 'sketch' | 'feature' | 'code') => {
    setModeRaw(prev => {
      if (prev === 'code' && newMode !== 'code') {
        try {
          const parsed = parseYaml(codeText) as PartDoc
          docRef.current = parsed
          setDoc(parsed)
        } catch { /* ignore parse errors */ }
      }
      if (newMode === 'code' && docRef.current) {
        setCodeText(stringifyYaml(docRef.current))
      }
      return newMode
    })
  }, [codeText, docRef, setDoc, setCodeText])

  useEffect(() => {
    useSketchEditorStore.getState().setOnMutation(handleMutation)
    return () => useSketchEditorStore.getState().setOnMutation(null)
  }, [handleMutation])

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

  const handleRename = async () => {
    if (!editName.trim() || editName === docId) {
      setIsEditing(false)
      return
    }
    try {
      if (!doc) return
      const success = await saveDoc(editName, doc)
      if (success) {
        await fetch(`/api/documents/${docId}`, { method: 'DELETE' })
        setIsEditing(false)
        navigate(`/documents/${editName}`)
      }
    } catch (e) {
      setError(String(e))
      setEditName(docId || '')
    }
  }

  const handleSave = async () => {
    if (!docId || !doc) return
    const success = await saveDoc(docId, doc)
    if (success) setError(null)
  }

  const handleRun = async () => {
    try {
      const parsed = parseYaml(codeText) as PartDoc
      docRef.current = parsed
      setDoc(parsed)
      reSolve(parsed)
    } catch (e) {
      setSolveError(`Parse error: ${e}`)
    }
  }

  const handleRollbackDragOver = (e: React.DragEvent, featureIndex: number) => {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (featureIndex >= 1) setRollbackPosition(featureIndex + 1)
  }

  const handleRollbackDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleRollbackDrop = (e: React.DragEvent, featureIndex: number) => {
    e.preventDefault()
    if (featureIndex >= 1) setRollbackPosition(featureIndex + 1)
  }

  const toggleVisibility = (featureId: string) => {
    setVisibleFeatures(prev => {
      const newSet = new Set(prev)
      if (newSet.has(featureId)) newSet.delete(featureId)
      else newSet.add(featureId)
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
              <button className={`mode-btn ${mode === 'sketch' ? 'active' : ''}`} onClick={() => setMode('sketch')} title="Sketch mode">
                <img src={featureSketchIcon} alt="Sketch" />
              </button>
              <button className={`mode-btn ${mode === 'feature' ? 'active' : ''}`} onClick={() => setMode('feature')} title="Feature mode">
                <img src={featurePartIcon} alt="Feature" />
              </button>
              <button className={`mode-btn ${mode === 'code' ? 'active' : ''}`} onClick={() => setMode('code')} title="Code mode">
                <img src={featureCodeIcon} alt="Code" />
              </button>
            </div>
            <div className="toolbar-separator" />
            {mode === 'code' && (
              <>
                <button className="editor-btn" title="Run" onClick={handleRun} disabled={solving}>
                  <img src={toolbarPlayIcon} alt="Run" />
                </button>
                {solveTime !== null && <span className="solve-time">{solveTime}ms</span>}
              </>
            )}
            {mode === 'sketch' && <SketchToolbar onResetViewport={() => setViewportReset(v => v + 1)} />}
            {mode === 'feature' && (
              <>
                <button className="editor-btn" title="Extrude"><img src={featureExtrudeIcon} alt="Extrude" /></button>
                <button className="editor-btn" title="Sketch"><img src={featureSketchIcon} alt="Sketch" /></button>
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
                  <textarea className="code-input" value={codeText} onChange={e => setCodeText(e.target.value)} placeholder="Document content..." spellCheck="false" />
                  <div className="code-result">
                    {solving ? <span className="code-result-status">Solving...</span> : solveResult ? <pre>{solveResult}</pre> : <span className="code-result-status">Press Run to solve</span>}
                  </div>
                </div>
              )}
              {mode !== 'code' && <Viewport features={features as Feature[]} featureDefs={doc?.features} rollbackPosition={rollbackPosition ?? undefined} visibleFeatures={visibleFeatures} solveResults={solveResults} resetTrigger={viewportReset} activeFeatureId={activeSketchFeatureId} />}
            </>
          )}
        </div>
      </div>
      <footer className="doc-footer"><p>Copyright 2026 - Oversolved</p></footer>
    </div>
  )
}
