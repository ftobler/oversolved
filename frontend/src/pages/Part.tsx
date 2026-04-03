import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import Viewport from '../components/Viewport'
import type { Feature, PartDoc, PartFeature } from '../types/cad'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { useCommandRegistration } from './hooks/useCommandRegistration'
import { buildCommandEntries } from './commandEntries'
import SketchToolbar from '../components/Toolbar/SketchToolbar'
import AppHeader from '../components/AppHeader'
import { usePartDoc } from '../hooks/usePartDoc'
import { planeLabel } from '../components/Geometry3D/utils'
import RightClickMenu from '../components/RightClickMenu'
import type { ContextMenuItem } from '../components/RightClickMenu'
import { BugReporter } from '../components/BugReporter'
import './Part.css'

import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureCodeIcon from '../assets/icons/icon-code.svg'
import featureOriginIcon from '../assets/icons/feature-origin.svg'
import featurePlaneIcon from '../assets/icons/feature-plane.svg'
import featureAddPlaneIcon from '../assets/icons/feature-add-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'
import toolbarCopyCodeIcon from '../assets/icons/toolbar-copy-code.svg'
import toolbarCopyResultIcon from '../assets/icons/toolbar-copy-result.svg'

import contextRebuildIcon from '../assets/icons/context-rebuild.svg'
import contextExitIcon from '../assets/icons/context-exit.svg'
import contextHideIcon from '../assets/icons/context-hide.svg'
import contextDeleteIcon from '../assets/icons/context-delete.svg'

// IDs of built-in features that cannot be deleted.
const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

export default function Part() {
  const { uuid } = useParams<{ uuid: string }>()
  const [codeText, setCodeText] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackPosition, setRollbackPosition] = useState<number | null>(null)
  const rollbackInitialized = useRef(false)
  const [viewportReset, setViewportReset] = useState(0)
  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ position: [number, number]; targetId?: string; items: ContextMenuItem[] } | null>(null)

  const [debugOpen, setDebugOpen] = useState(false)
  const [debugTab, setDebugTab] = useState<'selection' | 'bug-report'>('selection')
  const [bugReportForm, setBugReportForm] = useState({ title: '', description: '' })
  const [bugReporting, setBugReporting] = useState(false)
  const [bugReportError, setBugReportError] = useState<string | null>(null)
  const [bugReportAttachments, setBugReportAttachments] = useState({
    ast: true,
    selection: true,
    solveResults: true,
    internalState: true,
  })

  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const setPlaneSelectionFeatureId = useSketchEditorStore(s => s.setPlaneSelectionFeatureId)
  const fieldPickState = useSketchEditorStore(s => s.fieldPickState)
  const setFieldPickState = useSketchEditorStore(s => s.setFieldPickState)
  const selection = useSketchEditorStore(s => s.selection)
  const hoveredEntityId = useSketchEditorStore(s => s.hoveredEntityId)
  const toggleSelect = useSketchEditorStore(s => s.toggleSelect)

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

  // Derive visibility from the doc: features without explicit visible:false are visible.
  const visibleFeatures = useMemo(
    () => new Set(features.filter(f => f.visible !== false).map(f => f.id)),
    [features]
  )

  // Initialize rollback position once on first doc load.
  useEffect(() => {
    if (doc && !rollbackInitialized.current) {
      rollbackInitialized.current = true
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setRollbackPosition(extractFeatures(doc).length)
    }
  }, [doc])

  const activeSketchFeatureId = useMemo(() => {
    if (!editingFeatureId) return undefined
    const feature = features.find(f => f.id === editingFeatureId)
    if (!feature || feature.kind !== 'sketch') return undefined
    const limit = rollbackPosition ?? features.length
    const sketches = features.slice(0, limit).filter(f => f.kind === 'sketch' && visibleFeatures.has(f.id))
    return sketches.some(f => f.id === editingFeatureId) ? editingFeatureId : undefined
  }, [features, rollbackPosition, visibleFeatures, editingFeatureId])

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

  const handleRebuild = useCallback(() => {
    if (docRef.current) reSolve(docRef.current)
    setContextMenu(null)
  }, [docRef, reSolve])

  const handleExitSketch = useCallback(() => {
    setEditingFeatureId(null)
    setContextMenu(null)
  }, [])

  const handleDeleteFeature = useCallback((featureId: string) => {
    if (BUILT_IN_IDS.has(featureId)) return
    if (featureId === editingFeatureId) {
      setEditingFeatureId(null)
      setFieldPickState(null)
    }
    handleMutation({ type: 'delete_feature', featureId })
    useSketchEditorStore.getState().clearSelection()
    setContextMenu(null)
  }, [editingFeatureId, handleMutation, setFieldPickState])

  const handleDeleteSelectedFeatures = useCallback(() => {
    const sel = useSketchEditorStore.getState().selection
    const featureIds = [...sel]
      .filter(id => id.startsWith('@') && !id.startsWith('@builtin_'))
      .map(id => id.slice(1))
    for (const featureId of featureIds) {
      if (featureId === editingFeatureId) {
        setEditingFeatureId(null)
        setFieldPickState(null)
      }
      handleMutation({ type: 'delete_feature', featureId })
    }
    if (featureIds.length > 0) useSketchEditorStore.getState().clearSelection()
  }, [editingFeatureId, handleMutation, setFieldPickState])

  const handleAddPlane = useCallback(() => {
    if (!doc) return
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const featureId = `plane${planeCount + 1}`
    setRollbackPosition(prev => prev === features.length ? features.length + 1 : prev)
    handleMutation({ type: 'add_plane', featureId })
    setEditingFeatureId(featureId)
  }, [doc, features.length, handleMutation])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const featureId = `sketch${sketchCount + 1}`
    setRollbackPosition(prev => prev === features.length ? features.length + 1 : prev)
    setEditingFeatureId(null)
    setFieldPickState(null)
    handleMutation({ type: 'add_sketch', featureId })
    setPlaneSelectionFeatureId(featureId)
  }, [doc, features.length, handleMutation, setPlaneSelectionFeatureId, setFieldPickState])

  useEffect(() => {
    useSketchEditorStore.getState().setOnMutation(handleMutation)
    return () => useSketchEditorStore.getState().setOnMutation(null)
  }, [handleMutation])

  useEffect(() => {
    useSketchEditorStore.getState().setOnRebuild(handleRebuild)
    return () => useSketchEditorStore.getState().setOnRebuild(null)
  }, [handleRebuild])

  useEffect(() => {
    useSketchEditorStore.getState().setOnExitSketch(handleExitSketch)
    return () => useSketchEditorStore.getState().setOnExitSketch(null)
  }, [handleExitSketch])

  useEffect(() => {
    useSketchEditorStore.getState().setActiveFeatureId(activeSketchFeatureId ?? null)
  }, [activeSketchFeatureId])

  const commands = useMemo(
    () => buildCommandEntries(handleUndo, handleRedo, handleDeleteSelectedFeatures),
    [handleUndo, handleRedo, handleDeleteSelectedFeatures],
  )

  useCommandRegistration(commands)

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

  const handleSubmitBugReport = async () => {
    if (!bugReportForm.title.trim() || !bugReportForm.description.trim()) {
      setBugReportError('Title and description are required')
      return
    }
    setBugReporting(true)
    setBugReportError(null)
    try {
      const activeTool = useSketchEditorStore.getState().activeTool
      const report: Record<string, unknown> = {
        title: bugReportForm.title,
        description: bugReportForm.description,
      }
      if (bugReportAttachments.ast) report.ast = doc
      if (bugReportAttachments.selection) report.selection = [...selection]
      if (bugReportAttachments.solveResults) {
        report.solveResults = editingFeatureId && solveResults?.[editingFeatureId] ? solveResults[editingFeatureId] : null
      }
      if (bugReportAttachments.internalState) {
        report.internalState = {
          mode,
          activeTool,
          editingFeatureId,
          activeSketchFeatureId,
        }
      }
      const response = await fetch('/api/bug-report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(report),
      })
      if (!response.ok) {
        throw new Error(`Server responded with ${response.status}`)
      }
      setBugReportForm({ title: '', description: '' })
      alert('Bug report submitted successfully!')
      setDebugTab('selection')
    } catch (e) {
      setBugReportError(`Failed to submit: ${e}`)
    } finally {
      setBugReporting(false)
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

  const toggleVisibility = useCallback((featureId: string) => {
    handleMutation({ type: 'set_feature_visibility', featureId, visible: !visibleFeatures.has(featureId) })
    setContextMenu(null)
  }, [handleMutation, visibleFeatures])

  const enterEditSketch = (featureId: string) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx >= 0) setRollbackPosition(idx + 1)
    setEditingFeatureId(featureId)
    setMode('sketch')
  }

  const exitEditSketch = () => {
    setEditingFeatureId(null)
  }

  const handleRightClick = useCallback((pos: [number, number], featureId?: string) => {
    const items: ContextMenuItem[] = [
      {
        label: 'Rebuild',
        icon: contextRebuildIcon,
        onClick: handleRebuild,
      },
    ]

    if (activeSketchFeatureId) {
      items.push({
        label: 'Exit Sketch',
        icon: contextExitIcon,
        onClick: handleExitSketch,
        className: 'right-click-menu-item--exit',
      })
    }

    if (featureId) {
      const target = features.find(f => f.id === featureId)
      if (target?.kind === 'plane') {
        const isVisible = visibleFeatures.has(target.id)
        items.push({
          label: isVisible ? 'Hide' : 'Show',
          icon: contextHideIcon,
          onClick: () => toggleVisibility(target.id),
        })
      }
      if (!BUILT_IN_IDS.has(featureId)) {
        items.push({
          label: 'Delete',
          icon: contextDeleteIcon,
          onClick: () => handleDeleteFeature(featureId),
          className: 'right-click-menu-item--delete',
        })
      }
    }

    setContextMenu({
      position: pos,
      targetId: featureId,
      items,
    })
  }, [handleRebuild, activeSketchFeatureId, handleExitSketch, features, visibleFeatures, toggleVisibility, handleDeleteFeature])

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
                    className={`feature-item ${index >= (rollbackPosition ?? features.length) ? 'rolled-back' : ''} ${!visibleFeatures.has(feature.id) ? 'invisible' : ''} ${feature.id === editingFeatureId ? 'editing' : ''} ${selection.has(`@${feature.id}`) ? 'selected' : ''}`}
                    onDragOver={(e) => handleRollbackDragOver(e, index)}
                    onDrop={(e) => handleRollbackDrop(e, index)}
                    onClick={() => toggleSelect(`@${feature.id}`)}
                    onDoubleClick={() => feature.kind === 'sketch' ? enterEditSketch(feature.id) : undefined}
                    onContextMenu={(e) => { e.stopPropagation(); handleRightClick([e.clientX, e.clientY], feature.id) }}
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
                    {feature.kind === 'sketch' && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={() => enterEditSketch(feature.id)}
                        title="Edit sketch"
                      >
                        <span className="material-icons-outlined">edit</span>
                      </button>
                    )}
                    {feature.kind === 'sketch' && feature.id === editingFeatureId && (
                      <button
                        className="exit-sketch-btn"
                        onClick={(e) => { e.stopPropagation(); exitEditSketch() }}
                        title="Exit sketch"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id !== editingFeatureId && (
                      <button
                        className="feature-edit-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          const idx = features.findIndex(f => f.id === feature.id)
                          if (idx >= 0) setRollbackPosition(idx + 1)
                          setEditingFeatureId(feature.id)
                        }}
                        title="Edit plane"
                      >
                        <span className="material-icons-outlined">edit</span>
                      </button>
                    )}
                    {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (
                      <button
                        className="exit-sketch-btn"
                        onClick={(e) => { e.stopPropagation(); setEditingFeatureId(null); setFieldPickState(null) }}
                        title="Exit plane editor"
                      >
                        <span className="material-icons-outlined">close</span>
                      </button>
                    )}
                    <button
                      className="feature-visibility-btn"
                      onClick={(e) => { e.stopPropagation(); toggleVisibility(feature.id) }}
                      title={visibleFeatures.has(feature.id) ? 'Hide' : 'Show'}
                    >
                      <span className="material-icons-outlined">
                        {visibleFeatures.has(feature.id) ? 'visibility' : 'visibility_off'}
                      </span>
                    </button>
                    {feature.kind === 'plane' && !BUILT_IN_IDS.has(feature.id) && feature.id === editingFeatureId && (() => {
                      const featureDef = doc?.features?.find(f => f.id === feature.id)
                      const def = featureDef?.definition ?? { mode: 'offset' }
                      const mode = def.mode ?? 'offset'
                      const fid = feature.id
                      const isPickingKind = (field: string, kind: 'plane' | 'point' | 'line') =>
                        fieldPickState?.featureId === fid && fieldPickState.field === field && fieldPickState.kind === kind
                      const pickBtn = (field: string, kind: 'plane' | 'point' | 'line', label: string) =>
                        isPickingKind(field, kind)
                          ? <button className="feature-plane-btn active" onClick={(e) => { e.stopPropagation(); setFieldPickState(null) }}>Cancel</button>
                          : <button className="feature-plane-btn" onClick={(e) => { e.stopPropagation(); setFieldPickState({ featureId: fid, field, kind }) }}>{label}</button>
                      const numField = (field: 'offset' | 'angle' | 'rotation', label: string, defaultVal: number) => (
                        <div className="plane-editor-row">
                          <span className="plane-editor-label">{label}:</span>
                          <input
                            type="number"
                            className="plane-editor-input"
                            defaultValue={def[field] ?? defaultVal}
                            onClick={(e) => e.stopPropagation()}
                            onBlur={(e) => {
                              const v = parseFloat(e.target.value)
                              if (!isNaN(v)) handleMutation({ type: 'set_plane_definition_field', featureId: fid, field, value: v })
                            }}
                            onKeyDown={(e) => { if (e.key === 'Enter') { e.currentTarget.blur() } e.stopPropagation() }}
                          />
                        </div>
                      )
                      const refPlaneRow = (
                        <div className="plane-editor-row">
                          <span className="plane-editor-label">Plane:</span>
                          <span className="plane-editor-value">{planeLabel(def.plane)}</span>
                          {pickBtn('plane', 'plane', 'Pick')}
                        </div>
                      )
                      return (
                        <div className="plane-editor">
                          <div className="plane-editor-row">
                            <span className="plane-editor-label">Type:</span>
                            <select
                              className="plane-editor-select"
                              value={mode}
                              onChange={(e) => { e.stopPropagation(); handleMutation({ type: 'set_plane_definition_field', featureId: fid, field: 'mode', value: e.target.value }) }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value="offset">Offset from plane</option>
                              <option value="through_point">Through point</option>
                              <option value="three_point">Three-point plane</option>
                              <option value="line_angle">Rotate on line</option>
                              <option value="edge_point">Line and point</option>
                            </select>
                          </div>
                          {mode === 'offset' && (
                            <>
                              {refPlaneRow}
                              {numField('offset', 'Offset', 0)}
                            </>
                          )}
                          {mode === 'through_point' && (
                            <>
                              {refPlaneRow}
                              <div className="plane-editor-row">
                                <span className="plane-editor-label">Point:</span>
                                <span className="plane-editor-value">{def.point ?? 'None'}</span>
                                {pickBtn('point', 'point', 'Pick')}
                              </div>
                            </>
                          )}
                          {mode === 'three_point' && (['p1', 'p2', 'p3'] as const).map((field, i) => (
                            <div key={field} className="plane-editor-row">
                              <span className="plane-editor-label">P{i + 1}:</span>
                              <span className="plane-editor-value">{def[field] ?? 'None'}</span>
                              {pickBtn(field, 'point', 'Pick')}
                            </div>
                          ))}
                          {mode === 'line_angle' && (
                            <>
                              <div className="plane-editor-row">
                                <span className="plane-editor-label">Line:</span>
                                <span className="plane-editor-value">{def.line ?? 'None'}</span>
                                {pickBtn('line', 'line', 'Pick')}
                              </div>
                              {numField('angle', 'Angle', 0)}
                            </>
                          )}
                          {mode === 'edge_point' && (
                            <>
                              <div className="plane-editor-row">
                                <span className="plane-editor-label">Line:</span>
                                <span className="plane-editor-value">{def.edge ?? 'None'}</span>
                                {pickBtn('edge', 'line', 'Pick')}
                              </div>
                              <div className="plane-editor-row">
                                <span className="plane-editor-label">Point:</span>
                                <span className="plane-editor-value">{def.point ?? 'None'}</span>
                                {pickBtn('point', 'point', 'Pick')}
                              </div>
                            </>
                          )}
                          {numField('rotation', 'Rotation', 0)}
                        </div>
                      )
                    })()}
                    {feature.kind === 'sketch' && feature.id === editingFeatureId && (() => {
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
                <button className="editor-btn" title="Sketch" onClick={handleAddSketch}><img src={featureSketchIcon} alt="Sketch" /></button>
                <button className="editor-btn" title="Add plane" onClick={handleAddPlane}><img src={featureAddPlaneIcon} alt="Add plane" /></button>
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
              {mode !== 'code' && <Viewport features={features as Feature[]} featureDefs={doc?.features} rollbackPosition={rollbackPosition ?? undefined} visibleFeatures={visibleFeatures} solveResults={solveResults} resetTrigger={viewportReset} activeFeatureId={activeSketchFeatureId} onRightClick={(pos) => handleRightClick(pos)} />}
            </>
          )}
        </div>

        {debugOpen && (
          <aside className="debug-drawer">
            <div className="debug-tabs">
              <button
                className={`debug-tab ${debugTab === 'selection' ? 'active' : ''}`}
                onClick={() => setDebugTab('selection')}
              >
                Selection
              </button>
              <button
                className={`debug-tab ${debugTab === 'bug-report' ? 'active' : ''}`}
                onClick={() => setDebugTab('bug-report')}
              >
                Bug Report
              </button>
            </div>
            {debugTab === 'selection' && (
              <div className="debug-content">
                <div className="debug-section">
                  <div className="debug-section-title">Hover</div>
                  {hoveredEntityId
                    ? <div className="debug-value">{hoveredEntityId}</div>
                    : <div className="debug-empty">none</div>}
                </div>
                <div className="debug-section">
                  <div className="debug-section-title">Selection ({selection.size})</div>
                  {selection.size === 0
                    ? <div className="debug-empty">none</div>
                    : [...selection].map(id => (
                      <div key={id} className="debug-value">{id}</div>
                    ))}
                </div>
              </div>
            )}
            {debugTab === 'bug-report' && (
              <BugReporter
                bugReportForm={bugReportForm}
                setBugReportForm={setBugReportForm}
                bugReporting={bugReporting}
                bugReportError={bugReportError}
                bugReportAttachments={bugReportAttachments}
                setBugReportAttachments={setBugReportAttachments}
                onSubmit={handleSubmitBugReport}
                selectionCount={selection.size}
                hasSolveResults={!!(editingFeatureId && solveResults?.[editingFeatureId])}
              />
            )}
          </aside>
        )}
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
        <button
          className={`footer-debug-btn ${debugOpen ? 'active' : ''}`}
          title="Toggle debug panel"
          onClick={() => setDebugOpen(v => !v)}
        >
          <span className="material-icons-outlined">bug_report</span>
        </button>
      </footer>
      {contextMenu && (
        <RightClickMenu
          items={contextMenu.items}
          position={contextMenu.position}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
