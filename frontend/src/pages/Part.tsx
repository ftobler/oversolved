import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import Viewport from '../components/Viewport'
import type { Feature, PartDoc } from '../types/cad'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { registerCommand, unregisterCommand, dispatchKey, SHORTCUT_CONSTRAINT_KINDS } from '../stores/commandRegistry'
import SketchToolbar from '../components/Toolbar/SketchToolbar'
import AppHeader from '../components/AppHeader'
import { usePartDoc } from '../hooks/usePartDoc'
import { planeLabel } from '../components/Geometry3D/utils'
import './Part.css'
import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureCodeIcon from '../assets/icons/icon-code.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'
import toolbarCopyCodeIcon from '../assets/icons/toolbar-copy-code.svg'
import toolbarCopyResultIcon from '../assets/icons/toolbar-copy-result.svg'

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
  const { uuid } = useParams<{ uuid: string }>()
  const [codeText, setCodeText] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [visibleFeatures, setVisibleFeatures] = useState<Set<string>>(new Set())
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackPosition, setRollbackPosition] = useState<number | null>(null)
  const [viewportReset, setViewportReset] = useState(0)
  const [editingSketchId, setEditingSketchId] = useState<string | null>(null)
  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const setPlaneSelectionFeatureId = useSketchEditorStore(s => s.setPlaneSelectionFeatureId)

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
    renameDoc,
    docName,
  } = usePartDoc(uuid, mode, setCodeText)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (docName) setEditName(docName)
  }, [docName])

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
    if (!editingSketchId) return undefined
    const limit = rollbackPosition ?? features.length
    const sketches = features.slice(0, limit).filter(f => f.kind === 'sketch' && visibleFeatures.has(f.id))
    return sketches.some(f => f.id === editingSketchId) ? editingSketchId : undefined
  }, [features, rollbackPosition, visibleFeatures, editingSketchId])

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
    useSketchEditorStore.getState().setActiveFeatureId(activeSketchFeatureId ?? null)
  }, [activeSketchFeatureId])

  useEffect(() => {
    registerCommand('undo', handleUndo)
    registerCommand('redo', handleRedo)
    registerCommand('delete_selected', () => useSketchEditorStore.getState().deleteSelected())
    registerCommand('apply_dimension', () => useSketchEditorStore.getState().setActiveTool('dimension'))
    registerCommand('toggle_construction', () => useSketchEditorStore.getState().toggleConstruction())
    for (const kind of SHORTCUT_CONSTRAINT_KINDS) {
      registerCommand(`apply_${kind}`, () => useSketchEditorStore.getState().applyConstraint(kind))
    }
    registerCommand('cancel_draw', () => {
      useSketchEditorStore.getState().clearDraw()
      useSketchEditorStore.getState().setActiveTool('select')
      useSketchEditorStore.getState().setPlaneSelectionFeatureId(null)
    })
    registerCommand('cancel_plane_selection', () => {
      useSketchEditorStore.getState().setPlaneSelectionFeatureId(null)
    })
    window.addEventListener('keydown', dispatchKey)
    return () => {
      window.removeEventListener('keydown', dispatchKey)
      unregisterCommand('undo')
      unregisterCommand('redo')
      unregisterCommand('delete_selected')
      unregisterCommand('apply_dimension')
      unregisterCommand('toggle_construction')
      for (const kind of SHORTCUT_CONSTRAINT_KINDS) {
        unregisterCommand(`apply_${kind}`)
      }
      unregisterCommand('cancel_draw')
      unregisterCommand('cancel_plane_selection')
    }
  }, [handleUndo, handleRedo])

  const handleRename = async () => {
    if (!editName.trim() || editName === docName) {
      setIsEditing(false)
      return
    }
    const success = await renameDoc(uuid!, editName)
    if (success) {
      setIsEditing(false)
    } else {
      setEditName(docName)
    }
  }

  const handleSave = async () => {
    if (!uuid || !doc) return
    const success = await saveDoc(uuid, doc)
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

  const enterEditSketch = (featureId: string) => {
    setEditingSketchId(featureId)
    setMode('sketch')
  }

  const exitEditSketch = () => {
    setEditingSketchId(null)
  }

  return (
    <div className="document-viewer">
      <AppHeader>
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
            {docName}
          </h2>
        )}
      </AppHeader>

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
                    className={`feature-item ${index >= (rollbackPosition ?? features.length) ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''} ${feature.id === editingSketchId ? 'editing' : ''}`}
                    onDragOver={(e) => handleRollbackDragOver(e, index)}
                    onDrop={(e) => handleRollbackDrop(e, index)}
                    onDoubleClick={() => feature.kind === 'sketch' ? enterEditSketch(feature.id) : undefined}
                    style={{ flexWrap: 'wrap' }}
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
                    {feature.kind === 'sketch' && feature.id !== editingSketchId && (
                      <button
                        className="feature-edit-btn"
                        onClick={() => enterEditSketch(feature.id)}
                        title="Edit sketch"
                      >
                        <span className="material-icons-outlined">edit</span>
                      </button>
                    )}
                    {feature.kind === 'sketch' && feature.id === editingSketchId && (
                      <button
                        className="exit-sketch-btn"
                        onClick={(e) => { e.stopPropagation(); exitEditSketch() }}
                        title="Exit sketch"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    <button
                      className="feature-visibility-btn"
                      onClick={() => toggleVisibility(feature.id)}
                      title={visibleFeatures.has(feature.id) ? 'Hide' : 'Show'}
                    >
                      <span className="material-icons-outlined">
                        {visibleFeatures.has(feature.id) ? 'visibility' : 'visibility_off'}
                      </span>
                    </button>
                    {feature.kind === 'sketch' && feature.id === editingSketchId && (() => {
                      const featureDef = doc?.features?.find(f => f.id === feature.id)
                      const isPicking = planeSelectionFeatureId === feature.id
                      return (
                        <div className="feature-plane-selector">
                          <span className="feature-plane-label">Plane: {planeLabel(featureDef?.plane)}</span>
                          {isPicking ? (
                            <div className="feature-plane-picking">
                              <span className="feature-plane-hint">Click a plane or face...</span>
                              <button
                                className="feature-plane-btn"
                                onClick={(e) => { e.stopPropagation(); setPlaneSelectionFeatureId(null) }}
                              >
                                Cancel
                              </button>
                            </div>
                          ) : (
                            <button
                              className="feature-plane-btn"
                              onClick={(e) => { e.stopPropagation(); setPlaneSelectionFeatureId(feature.id) }}
                            >
                              Change
                            </button>
                          )}
                        </div>
                      )
                    })()}
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
                <div className="toolbar-separator" />
                <button className="editor-btn" title="Copy code" onClick={() => navigator.clipboard.writeText(codeText)}>
                  <img src={toolbarCopyCodeIcon} alt="Copy code" />
                </button>
                <button className="editor-btn" title="Copy result" onClick={() => navigator.clipboard.writeText(solveResult)}>
                  <img src={toolbarCopyResultIcon} alt="Copy result" />
                </button>
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
