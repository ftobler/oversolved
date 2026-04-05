import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import Viewport from '../components/Viewport'
import type { Feature, PartDoc, PartFeature, Mutation, Sketch } from '../types/cad'
import { randomId } from '../utils/yamlMutations'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { useCommandRegistration } from './hooks/useCommandRegistration'
import { buildCommandEntries } from './commandEntries'
import SketchToolbar from '../components/Toolbar/SketchToolbar'
import AppHeader from '../components/AppHeader'
import { usePartDoc } from '../hooks/usePartDoc'
import RightClickMenu from '../components/RightClickMenu'
import type { ContextMenuItem } from '../components/RightClickMenu'
import { BugReporter } from '../components/BugReporter'
import { Sidebar } from '../components/Sidebar'
import FooterMeasurementDisplay from '../components/FooterMeasurementDisplay'
import './Part.css'

import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureCodeIcon from '../assets/icons/icon-code.svg'
import featureAddPlaneIcon from '../assets/icons/feature-add-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'
import toolbarCopyCodeIcon from '../assets/icons/toolbar-copy-code.svg'
import toolbarCopyResultIcon from '../assets/icons/toolbar-copy-result.svg'
import measurementIcon from '../assets/icons/measurement.svg'

import contextRebuildIcon from '../assets/icons/context-rebuild.svg'
import contextExitIcon from '../assets/icons/context-exit.svg'
import contextHideIcon from '../assets/icons/context-hide.svg'
import contextDeleteIcon from '../assets/icons/context-delete.svg'
import contextEditIcon from '../assets/icons/context-edit.svg'

// IDs of built-in features that cannot be deleted.
const BUILT_IN_IDS = new Set(['Origin', 'Top', 'Front', 'Right'])

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

function describeMutation(m: Mutation): string {
  switch (m.type) {
    case 'move_vertex':
      return `move vertex ${m.vertexKey} on ${m.entityId} in ${m.featureId}`
    case 'move_entity':
      return `move ${m.entityId} in ${m.featureId}`
    case 'add_constraint':
      return `add ${m.kind} constraint in ${m.featureId}`
    case 'set_constraint_value':
      return `set ${m.constraintId} value in ${m.featureId}`
    case 'set_constraint_pos':
      return `set ${m.constraintId} pos in ${m.featureId}`
    case 'delete':
      return `delete ${m.targets.length} element(s)`
    case 'add_entity':
      return `add ${m.kind} in ${m.featureId}`
    case 'add_rect':
      return `add rect in ${m.featureId}`
    case 'add_center_rect':
      return `add center rect in ${m.featureId}`
    case 'toggle_construction':
      return `toggle construction on ${m.targets.length} element(s)`
    case 'set_feature_plane':
      return `set plane of ${m.featureId} to ${m.plane}`
    case 'add_sketch':
      return `add ${m.label || m.featureId}`
    case 'delete_feature':
      return `delete feature ${m.featureId}`
    case 'set_feature_visibility':
      return `${m.visible ? 'show' : 'hide'} ${m.featureId}`
    case 'add_plane':
      return `add ${m.label || m.featureId}`
    case 'set_plane_definition_field':
      return `edit plane ${m.featureId}: ${m.field}`
    case 'rename_feature':
      return `rename ${m.featureId} to ${m.label}`
    case 'toggle_sketch_plane_visibility':
      return 'toggle sketch/plane visibility'
  }
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
  const [debugTab, setDebugTab] = useState<'selection' | 'bug-report' | 'undo-redo'>('selection')
  const showDebugHit = useSketchEditorStore(s => s.showDebugHit)
  const setShowDebugHit = useSketchEditorStore(s => s.setShowDebugHit)
  const [bugReportForm, setBugReportForm] = useState({ title: '', description: '' })
  const [bugReporting, setBugReporting] = useState(false)
  const [bugReportError, setBugReportError] = useState<string | null>(null)
  const [bugReportAttachments, setBugReportAttachments] = useState({
    ast: true,
    selection: true,
    solveResults: true,
    internalState: true,
    history: true,
    historyCount: 5,
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

  // Measurement sketch: when editing a specific sketch, use its solve result;
  // otherwise combine sketches from all visible features.
  const measurementSketch = useMemo(() => {
    if (activeSketchFeatureId && solveResults?.[activeSketchFeatureId]?.solved) {
      return solveResults[activeSketchFeatureId].solved
    }
    const sketch: Sketch = {}
    for (const feature of features) {
      const solveResult = solveResults?.[feature.id]
      if (solveResult && solveResult.solved) {
        Object.assign(sketch, solveResult.solved)
      }
    }
    return sketch
  }, [activeSketchFeatureId, features, solveResults])

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
    const featureId = randomId(18)
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const label = `plane ${planeCount + 1}`
    setRollbackPosition(prev => prev === features.length ? features.length + 1 : prev)
    handleMutation({ type: 'add_plane', featureId, label })
    setEditingFeatureId(featureId)
  }, [doc, features.length, handleMutation])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setRollbackPosition(prev => prev === features.length ? features.length + 1 : prev)
    setFieldPickState(null)
    handleMutation({ type: 'add_sketch', featureId, label })
    handleMutation({ type: 'set_feature_plane', featureId, plane: 'Top' })
    setEditingFeatureId(featureId)
    setMode('sketch')
  }, [doc, features.length, handleMutation, setFieldPickState, setMode])

  const handleToggleSketchPlaneVisibility = useCallback(() => {
    handleMutation({ type: 'toggle_sketch_plane_visibility' })
  }, [handleMutation])

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
    () => buildCommandEntries(handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility),
    [handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility],
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
      if (bugReportAttachments.history) {
        const historyItems = undoStack.slice(-bugReportAttachments.historyCount).map(entry => ({
          mutation: entry.mutation,
          label: describeMutation(entry.mutation),
        }))
        report.history = historyItems
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
      const target = features.find(f => f.id === activeSketchFeatureId)
      const isVisible = target && visibleFeatures.has(target.id)
      if (isVisible) {
        items.push({
          label: 'Hide',
          icon: contextHideIcon,
          onClick: () => toggleVisibility(activeSketchFeatureId),
        })
      }
      items.push({
        label: 'Edit',
        icon: contextEditIcon,
        onClick: () => enterEditSketch(activeSketchFeatureId),
      })
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
        if (!BUILT_IN_IDS.has(target.id)) {
          items.push({
            label: 'Edit',
            icon: contextEditIcon,
            onClick: () => {
              handleRightClick(pos, target.id)
              enterEditSketch(target.id)
            },
          })
          items.push({
            label: isVisible ? 'Hide' : 'Show',
            icon: contextHideIcon,
            onClick: () => toggleVisibility(target.id),
          })
        }
      } else if (target?.kind === 'sketch') {
        const isVisible = visibleFeatures.has(target.id)
        if (!BUILT_IN_IDS.has(target.id)) {
          items.push({
            label: 'Edit',
            icon: contextEditIcon,
            onClick: () => {
              handleRightClick(pos, target.id)
              enterEditSketch(target.id)
            },
          })
        }
        if (isVisible) {
          items.push({
            label: 'Hide',
            icon: contextHideIcon,
            onClick: () => toggleVisibility(target.id),
          })
        }
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
        <Sidebar
          features={features}
          doc={doc}
          rollbackPosition={rollbackPosition}
          visibleFeatures={visibleFeatures}
          editingFeatureId={editingFeatureId}
          selection={selection}
          fieldPickState={fieldPickState}
          planeSelectionFeatureId={planeSelectionFeatureId}
          onToggleSelect={toggleSelect}
          onEnterEditSketch={enterEditSketch}
          onExitEditSketch={exitEditSketch}
          onToggleVisibility={toggleVisibility}
          onRightClick={handleRightClick}
          onRollbackDragStart={handleRollbackDragStart}
          onRollbackDragOver={handleRollbackDragOver}
          onRollbackDrop={handleRollbackDrop}
          onMutation={handleMutation}
          onSetRollbackPosition={setRollbackPosition}
          onSetEditingFeatureId={setEditingFeatureId}
          onSetFieldPickState={setFieldPickState}
          onSetPlaneSelectionFeatureId={setPlaneSelectionFeatureId}
        />

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
              {mode !== 'code' && <Viewport features={features as Feature[]} featureDefs={doc?.features} rollbackPosition={rollbackPosition ?? undefined} visibleFeatures={visibleFeatures} solveResults={solveResults} resetTrigger={viewportReset} activeFeatureId={activeSketchFeatureId} onRightClick={(pos) => handleRightClick(pos)} showDebugHit={showDebugHit} />}
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
              <button
                className={`debug-tab ${debugTab === 'undo-redo' ? 'active' : ''}`}
                onClick={() => setDebugTab('undo-redo')}
              >
                Undo
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
                undoStackCount={undoStack.length}
              />
            )}
            {debugTab === 'undo-redo' && (
              <div className="debug-content">
                <div className="debug-section">
                  <div className="debug-section-title">Undo Stack ({undoStack.length})</div>
                  {undoStack.length === 0
                    ? <div className="debug-empty">empty</div>
                    : undoStack.map((entry, idx) => (
                      <div key={idx} className="debug-value">
                        <div>[{idx}] {describeMutation(entry.mutation)}</div>
                        <div style={{ fontSize: '9px', color: '#666', marginTop: '2px' }}>
                          {JSON.stringify(entry.mutation).slice(0, 100)}
                        </div>
                      </div>
                    ))}
                </div>
                <div className="debug-section">
                  <div className="debug-section-title">Redo Stack ({redoStack.length})</div>
                  {redoStack.length === 0
                    ? <div className="debug-empty">empty</div>
                    : redoStack.map((entry, idx) => (
                      <div key={idx} className="debug-value">
                        <div>[{idx}] {describeMutation(entry.mutation)}</div>
                        <div style={{ fontSize: '9px', color: '#666', marginTop: '2px' }}>
                          {JSON.stringify(entry.mutation).slice(0, 100)}
                        </div>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </aside>
        )}
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
        <FooterMeasurementDisplay sketch={measurementSketch} measurementIcon={measurementIcon} />
        <div className="debug-buttons">
          <button
            className={`footer-debug-btn ${debugOpen ? 'active' : ''}`}
            title="Toggle debug panel"
            onClick={() => setDebugOpen(v => !v)}
          >
            <span className="material-icons-outlined">bug_report</span>
          </button>
          <button
            className="footer-debug-btn"
            title={showDebugHit ? "Hide debug collision rendering" : "Show debug collision rendering"}
            onClick={() => setShowDebugHit(!showDebugHit)}
          >
            {showDebugHit ? (
              <span className="material-icons-outlined">visibility</span>
            ) : (
              <span className="material-icons-outlined">visibility_off</span>
            )}
          </button>
        </div>
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
