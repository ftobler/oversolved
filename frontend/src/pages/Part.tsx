import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import Viewport, { type ViewportHandle } from '../components/Viewport'
import type { Feature, PartDoc, PartFeature, Mutation, Sketch } from '../types/cad'
import { randomId } from '../utils/yamlMutations'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import { useCommandRegistration } from './hooks/useCommandRegistration'
import { buildCommandEntries } from './commandEntries'
import SketchToolbar from '../components/Toolbar/SketchToolbar'
import AppHeader from '../components/AppHeader'
import { usePartDoc } from '../hooks/usePartDoc'
import { useAuth } from '../contexts/AuthContext'
import RightClickMenu from '../components/RightClickMenu'
import type { ContextMenuItem } from '../components/RightClickMenu'
import { Sidebar } from '../components/Sidebar'
import FooterMeasurementDisplay from '../components/FooterMeasurementDisplay'
import ExportDialog, { type ExportFormat } from '../components/ExportDialog'
import ShareDialog from '../components/ShareDialog'
import LoadingOverlay from '../components/LoadingOverlay'

import { useSolverStore } from '../stores/solverStore'
import { invalidateDocCache } from '../utils/buildCache'
import { describeMutation } from '../utils/mutationDescriptions'
import PartDebugPanel from './PartDebugPanel'
import './Part.css'

import featureExtrudeIcon from '../assets/icons/feature-extrude.svg'
import featureRevolveIcon from '../assets/icons/feature-revolve.svg'
import featureFilletIcon from '../assets/icons/feature-fillet.svg'
import featureChamferIcon from '../assets/icons/feature-chamfer.svg'
import featureBooleanIcon from '../assets/icons/feature-boolean.svg'
import featureArrayIcon from '../assets/icons/feature-array.svg'
import featureDeleteBodyIcon from '../assets/icons/feature-delete-body.svg'
import featureHoleIcon from '../assets/icons/feature-hole.svg'
import featureTransformIcon from '../assets/icons/feature-transform.svg'
import featureSketchIcon from '../assets/icons/feature-sketch.svg'
import featurePartIcon from '../assets/icons/feature-part.svg'
import featureCodeIcon from '../assets/icons/icon-code.svg'
import featureAddPlaneIcon from '../assets/icons/feature-add-plane.svg'
import toolbarPlayIcon from '../assets/icons/toolbar-play.svg'
import toolbarCopyCodeIcon from '../assets/icons/toolbar-copy-code.svg'
import toolbarCopyResultIcon from '../assets/icons/toolbar-copy-result.svg'
import measurementIcon from '../assets/icons/measurement.svg'
import featureImportIcon from '../assets/icons/icon-upload.svg'
import iconRenameIcon from '../assets/icons/rename.svg'
import featureExportIcon from '../assets/icons/icon-download.svg'

import contextRebuildIcon from '../assets/icons/context-rebuild.svg'
import contextExitIcon from '../assets/icons/context-exit.svg'
import contextHideIcon from '../assets/icons/context-hide.svg'
import contextDeleteIcon from '../assets/icons/context-delete.svg'
import contextEditIcon from '../assets/icons/context-edit.svg'
import contextColorIcon from '../assets/icons/context-color.svg'
import contextCameraIcon from '../assets/icons/context-camera.svg'

// IDs of built-in features that cannot be deleted.
import { PART_COLOR_PALETTE, normalizeHexColor } from '../utils/partColors'
import { BUILTIN_FEATURE_DEFAULTS } from '../hooks/usePartDoc'

const BUILT_IN_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

export default function Part() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const [codeText, setCodeText] = useState('')
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackPosition, setRollbackPosition] = useState<number | null>(null)
  const [savedRollbackPosition, setSavedRollbackPosition] = useState<number | null>(null)
  const [editForcedVisible, setEditForcedVisible] = useState<Set<string>>(new Set())
  const [bodiesVisibility, setBodiesVisibility] = useState<Record<string, boolean>>({})
  const rollbackInitialized = useRef(false)
  const [viewportReset, setViewportReset] = useState(0)
  const viewportRef = useRef<ViewportHandle>(null)
  const handleFirstSolve = useCallback(() => {
    viewportRef.current?.autoZoomToFit()
  }, [])
  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ position: [number, number]; targetId?: string; items: ContextMenuItem[] } | null>(null)
  const [partColorPopover, setPartColorPopover] = useState<{ bodyId: string; position: [number, number] } | null>(null)
  const [partColorDraft, setPartColorDraft] = useState<string>('#6AB59B')
  const [partTransparencyDraft, setPartTransparencyDraft] = useState(0)
  const [partMetalnessDraft, setPartMetalnessDraft] = useState(0.3)
  const partColorPopoverRef = useRef<HTMLDivElement>(null)
  const colorPreviewActive = useRef(false)
  const { user } = useAuth()

  const [debugOpen, setDebugOpen] = useState(false)
  const [debugTab, setDebugTab] = useState<'selection' | 'bug-report' | 'undo-redo' | 'cache-inspector'>('selection')
  const showDebugHit = useSketchEditorStore(s => s.showDebugHit)
  const setShowDebugHit = useSketchEditorStore(s => s.setShowDebugHit)
  const [bugReportForm, setBugReportForm] = useState({ title: '', description: '' })
  const [bugReporting, setBugReporting] = useState(false)
  const [bugReportError, setBugReportError] = useState<string | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [exportTargetBodyId, setExportTargetBodyId] = useState<string | null>(null)
  const [shareDocOpen, setShareDocOpen] = useState(false)
  const [exportDefaultName, setExportDefaultName] = useState<string>('export')
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
  const pendingPickField = useSketchEditorStore(s => s.pendingPickField)
  const setPendingPickField = useSketchEditorStore(s => s.setPendingPickField)
   const selection = useSketchEditorStore(s => s.normalSelection)
   // Temporary accumulation of elements while pointer is held down
   // Used for dynamic selection during mouse-down + hover (see feature_dynamic_select.md)
   const dynamicSelection = useSketchEditorStore(s => s.dynamicSelection)
  const hoveredEntityId = useSketchEditorStore(s => s.hoveredEntityId)
  const hoveredVertexId = useSketchEditorStore(s => s.hoveredVertexId)
  const hoveredPlaneId = useSketchEditorStore(s => s.hoveredPlaneId)
  const hoveredSurfaceId = useSketchEditorStore(s => s.hoveredSurfaceId)
  const hovered3DSurfaceId = useSketchEditorStore(s => s.hovered3DSurfaceId)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)

  const {
    doc,
    setDoc,
    docRef,
    loading,
    error,
    setError,
    solveResults,
    featureTimings,
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
      ownerUsername,
      bodies,
      pickBodies,
      setPickBodies,
      setPickBoundary,
      setRollbackPos,
      permission,
      startPreviewMode,
      commitPreview,
      cancelPreview,
    } = usePartDoc(uuid, mode, setCodeText, { onFirstSolve: handleFirstSolve })

  const readOnly = permission === 'view'

  useEffect(() => {
    if (docName) setEditName(docName)
  }, [docName])

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'p' || e.key === 'P') {
        e.preventDefault()
        handleMutation({ type: 'toggle_plane_visibility' })
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleMutation])

  const features = useMemo(() => extractFeatures(doc), [doc])
  const partStyle = useMemo(() => doc?.part_style ?? {}, [doc])
  const partLabels = useMemo(() => {
    const labels: Record<string, string> = {}
    for (const [bodyId, style] of Object.entries(partStyle)) {
      if (style.name?.trim()) labels[bodyId] = style.name.trim()
    }
    return labels
  }, [partStyle])
  const partColors = useMemo(() => {
    const colors: Record<string, string> = {}
    for (const [bodyId, style] of Object.entries(partStyle)) {
      const normalized = normalizeHexColor(style.color)
      if (normalized) colors[bodyId] = normalized
    }
    return colors
  }, [partStyle])

  // Derive visibility from the doc; also include features forced visible while editing.
  const visibleFeatures = useMemo(
    () => new Set([
      ...features.filter(f => f.visible !== false).map(f => f.id),
      ...editForcedVisible,
    ]),
    [features, editForcedVisible]
  )

  // Bodies are visible when their creator feature is visible, unless the user
  // has explicitly overridden the body visibility in the parts list.
  const effectiveVisibleBodies = useMemo(() => {
    const visible = new Set<string>()
    for (const [bodyId, body] of Object.entries(bodies || {})) {
      if (bodiesVisibility[bodyId] === false) continue
      if (bodiesVisibility[bodyId] === true) {
        visible.add(bodyId)
        continue
      }
      if (body.created_by && visibleFeatures.has(body.created_by)) {
        visible.add(bodyId)
      }
    }
    return visible.size > 0 ? visible : undefined
  }, [bodies, visibleFeatures, bodiesVisibility])

  // Initialize rollback position once on first doc load.
  useEffect(() => {
    if (doc && !rollbackInitialized.current) {
      rollbackInitialized.current = true
      setRollbackPosition(extractFeatures(doc).length)
    }
  }, [doc])

  // Validate rollback position when features change.
  useEffect(() => {
    if (rollbackPosition !== null && rollbackPosition > features.length) {
      setRollbackPosition(features.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features.length])

  // Re-solve when rollback position changes (but not on initial mount).
  const rollbackInitializedForSolve = useRef(false)
  const currentFeaturesLength = useRef(features.length)
  currentFeaturesLength.current = features.length
  const rollbackChangeSource = useRef<'handler' | 'user' | null>(null)
useEffect(() => {
    if (!rollbackInitializedForSolve.current) {
      rollbackInitializedForSolve.current = true
      return
    }
    if (rollbackChangeSource.current === 'handler') {
      return
    }
    setPickBoundary(null)  // clear stale pick boundary when rollback changes
    if (docRef.current) reSolve(docRef.current, rollbackPosition ?? currentFeaturesLength.current)
  }, [rollbackPosition, docRef, reSolve, setPickBoundary])

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

  // Other sketches: for project tool - all sketches except the active one
  const otherSketches = useMemo(() => {
    const result: Record<string, Sketch> = {}
    for (const feature of features) {
      if (feature.kind !== 'sketch') continue
      if (!visibleFeatures.has(feature.id)) continue
      if (feature.id === activeSketchFeatureId) continue
      const solveResult = solveResults?.[feature.id]
      if (solveResult?.solved) {
        result[feature.id] = solveResult.solved
      }
    }
    return result
  }, [features, visibleFeatures, activeSketchFeatureId, solveResults])

  const ghostMode: 'additive' | 'subtractive' | undefined = useMemo(() => {
    const editingFeature = editingFeatureId ? features.find(f => f.id === editingFeatureId) : null
    if (!editingFeature || editingFeature.kind === 'sketch') return undefined
    if (editingFeature.kind !== 'boolean') return 'additive'
    const op = editingFeature.boolean?.operation
    if (op === 'subtract') return 'subtractive'
    return 'additive'
  }, [features, editingFeatureId])

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
    if (docRef.current) reSolve(docRef.current, rollbackPosition ?? features.length)
    setContextMenu(null)
  }, [docRef, reSolve, rollbackPosition, features])

  const [isRebuilding, setIsRebuilding] = useState(false)

  const handleClearCacheAndRebuild = useCallback(async () => {
    if (!uuid || !docRef.current) return
    setIsRebuilding(true)
    try {
      await invalidateDocCache(uuid)
      await fetch('/api/cache/flush', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ doc_id: uuid, level: 'all' }),
      })
      await reSolve(docRef.current, rollbackPosition ?? features.length)
    } catch (e) {
      console.error('Rebuild failed:', e)
    } finally {
      setIsRebuilding(false)
    }
  }, [uuid, reSolve, rollbackPosition, features, docRef])

  const handleRebuildRef = useRef(handleRebuild)
  handleRebuildRef.current = handleRebuild

  const prevEditingIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!docRef.current) return
    const prev = prevEditingIdRef.current
    prevEditingIdRef.current = editingFeatureId
    if (prev === editingFeatureId) return

    if (rollbackChangeSource.current === 'handler') {
      rollbackChangeSource.current = null
      return
    }

    const feature = features.find(f => f.id === editingFeatureId)
    let nextBoundary: number | null = null
    if (feature && feature.kind !== 'sketch' && feature.kind !== 'plane') {
      // Backend solve features exclude built-in display features, so the
      // pick boundary must be indexed within the non-built-in subset only.
      const nonBuiltInFeatures = features.filter(f => !BUILT_IN_IDS.has(f.id))
      const index = nonBuiltInFeatures.findIndex(f => f.id === editingFeatureId)
      if (index >= 0) nextBoundary = index
    }
    setPickBoundary(nextBoundary)
    // Only trigger reSolve when a non-null pick boundary is set (feature editing).
    // For sketch/plane editing, the rollback-position effect already triggers the
    // solve, and the pick boundary is already null from enterEditFeature.
    if (nextBoundary !== null) {
      handleRebuildRef.current()
    }
  }, [editingFeatureId, features, setPickBoundary, docRef])

  const handleExitSketch = useCallback(() => {
    setEditingFeatureId(null)
    setContextMenu(null)
  }, [])

  const handleDeleteFeature = useCallback((featureId: string) => {
    if (BUILT_IN_IDS.has(featureId)) return
    if (featureId === editingFeatureId) {
      setEditingFeatureId(null)
      setPendingPickField(null)
    }
    handleMutation({ type: 'delete_feature', featureId })
    useSketchEditorStore.getState().clearNormalSelection()
    setContextMenu(null)
  }, [editingFeatureId, handleMutation, setPendingPickField])

  const handleDeleteSelectedFeatures = useCallback(() => {
    const sel = useSketchEditorStore.getState().normalSelection
    const featureIds = [...sel]
      .filter(id => id.startsWith('@') && !id.startsWith('@builtin_'))
      .map(id => id.slice(1))
      .filter(id => !BUILT_IN_IDS.has(id))
    for (const featureId of featureIds) {
      if (featureId === editingFeatureId) {
        setEditingFeatureId(null)
        setPendingPickField(null)
      }
      handleMutation({ type: 'delete_feature', featureId })
    }
    if (featureIds.length > 0) useSketchEditorStore.getState().clearNormalSelection()
  }, [editingFeatureId, handleMutation, setPendingPickField])

  const handleAddFeature = useCallback((kind: string, extra?: Record<string, unknown>) => {
    if (!doc) return
    const fid = randomId(18)
    const label = `${kind} ${Object.keys(bodies).length + 1}`
    setPickBoundary(features.filter(f => !BUILT_IN_IDS.has(f.id)).length)
    setRollbackPos(features.length + 1)
    handleMutation({ type: `add_${kind}`, featureId: fid, label, ...extra } as Mutation)
    rollbackChangeSource.current = 'handler'
    setRollbackPosition(features.length + 1)
    rollbackChangeSource.current = 'handler'
    setEditingFeatureId(fid)
  }, [doc, features, handleMutation, bodies, setPickBoundary, setRollbackPos])

  const handleAddPlane = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const label = `plane ${planeCount + 1}`
    const faceQuery = [...selection].find(id => id.startsWith('?') && id.includes(':face'))
    const definition = faceQuery ? { mode: 'on_face', face: faceQuery } as const : undefined
    setRollbackPos(features.length + 1)
    handleMutation({ type: 'add_plane', featureId, label, definition })
    rollbackChangeSource.current = 'handler'
    setRollbackPosition(features.length + 1)
    rollbackChangeSource.current = 'handler'
    setEditingFeatureId(featureId)
  }, [doc, features.length, handleMutation, selection, setRollbackPos])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setPendingPickField(null)
    setRollbackPos(features.length + 1)
    handleMutation({ type: 'add_sketch', featureId, label })
    rollbackChangeSource.current = 'handler'
    setRollbackPosition(features.length + 1)
    setPlaneSelectionFeatureId(featureId)
    rollbackChangeSource.current = 'handler'
    setEditingFeatureId(featureId)
  }, [doc, features.length, handleMutation, setPendingPickField, setPlaneSelectionFeatureId, setRollbackPos])

  const handleImportStep = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.step,.stp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const form = new FormData()
      form.append('file', file)
      const res = await fetch('/api/upload', { method: 'POST', body: form })
      if (!res.ok) return
      const data = await res.json() as { file_id?: string }
      if (!data.file_id) return
      const featureId = randomId(18)
      const label = file.name.replace(/\.(step|stp)$/i, '')
      setRollbackPos(features.length + 1)
      handleMutation({ type: 'add_import_step', featureId, fileId: data.file_id, label })
    }
    input.click()
  }, [handleMutation, features.length, setRollbackPos])

  const handleExportStep = useCallback(async () => {
    setExportTargetBodyId(null)
    setExportDefaultName(docName || 'export')
    setExportDialogOpen(true)
  }, [docName])

  const handleExportDownload = useCallback(async (format: ExportFormat, tessellation: number) => {
    if (!doc?.features) return
    const endpoint = format === 'step' ? '/api/export/step' : '/api/export/stl'
    const body: Record<string, unknown> = { features: doc.features }
    if (exportTargetBodyId) body.body_id = exportTargetBodyId
    if (format === 'stl') {
      body.deflection = tessellation * 2
      body.angular_deflection = tessellation * 0.6
    }
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const err = await res.text()
        console.error('Export failed:', res.status, err)
        alert(`Export failed: ${err}`)
        return
      }
      const blob = await res.blob()
      const filename = format === 'step' ? `${exportDefaultName}.step` : `${exportDefaultName}.stl`
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(url)
    } catch (e) {
      console.error('Export error:', e)
      alert(`Export error: ${e}`)
    }
    setExportTargetBodyId(null)
    setExportDialogOpen(false)
  }, [doc, exportTargetBodyId, exportDefaultName])

  const handleExportCancel = useCallback(() => {
    setExportTargetBodyId(null)
    setExportDialogOpen(false)
  }, [])

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

  useEffect(() => {
    useSolverStore.getState().setIsSolving(solving)
  }, [solving])

  const commands = useMemo(
    () => buildCommandEntries(handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility,
      () => handleAddFeature('extrude', { sketchQuery: '', distance: 10 }),
      () => handleAddFeature('hole'),
      () => handleAddFeature('transform'),
    ),
    [handleUndo, handleRedo, handleDeleteSelectedFeatures, handleToggleSketchPlaneVisibility, handleAddFeature],
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
    const success = await saveDoc(uuid, doc, viewportRef.current?.captureScreenshotForSaving)
    if (success) setError(null)
  }

  const handleClone = async () => {
    if (!uuid) return
    try {
      const response = await fetch(`/api/documents/${uuid}/clone`, {
        method: 'POST',
      })
      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || 'Failed to clone document')
      }
      const data = await response.json()
      navigate(`/documents/${data.uuid}`)
    } catch (e) {
      setError(String(e))
    }
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

  const handleRollbackDragStart = (e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
  }

  const handleUserRollbackChange = useCallback((pos: number | null) => {
    rollbackChangeSource.current = 'user'
    setRollbackPosition(pos)
  }, [])

  const toggleVisibility = useCallback((featureId: string) => {
    handleMutation({ type: 'set_feature_visibility', featureId, visible: !visibleFeatures.has(featureId) })
    setContextMenu(null)
  }, [handleMutation, visibleFeatures])

  const handleFeatureRename = useCallback((featureId: string, label: string) => {
    const trimmed = label.trim()
    if (!trimmed) return
    handleMutation({ type: 'rename_feature', featureId, label: trimmed })
  }, [handleMutation])

  const toggleBodyVisibility = useCallback((bodyId: string) => {
    setBodiesVisibility(prev => {
      const current = prev[bodyId]
      if (current === undefined) {
        return { ...prev, [bodyId]: false }
      }
      if (current === false) {
        return { ...prev, [bodyId]: true }
      }
      const next = { ...prev }
      delete next[bodyId]
      return next
    })
  }, [])

  const handleBodyRename = useCallback((bodyId: string, label: string) => {
    const trimmed = label.trim()
    if (!trimmed) return
    handleMutation({ type: 'rename_part', bodyId, name: trimmed })
  }, [handleMutation])

  const handleBodyColor = useCallback((bodyId: string, color: string) => {
    const normalized = normalizeHexColor(color)
    if (!normalized) return
    handleMutation({ type: 'set_part_color', bodyId, color: normalized })
  }, [handleMutation])

  const handleBodyTransparency = useCallback((bodyId: string, transparency: number) => {
    const clamped = Math.max(0, Math.min(1, transparency))
    handleMutation({ type: 'set_part_transparency', bodyId, transparency: clamped })
  }, [handleMutation])

  const handleBodyMetalness = useCallback((bodyId: string, metalness: number) => {
    const clamped = Math.max(0, Math.min(1, metalness))
    handleMutation({ type: 'set_part_metalness', bodyId, metalness: clamped })
  }, [handleMutation])

  const handleColorCancel = useCallback(() => {
    if (!colorPreviewActive.current) return
    const originalDoc = cancelPreview()
    if (originalDoc && docRef.current) {
      docRef.current = originalDoc
      setDoc(originalDoc)
      reSolve(originalDoc)
    }
    colorPreviewActive.current = false
    setPartColorPopover(null)
  }, [cancelPreview, docRef, setDoc, reSolve])

  useEffect(() => {
    if (!partColorPopover) return
    const close = (e: MouseEvent) => {
      if (partColorPopoverRef.current && !partColorPopoverRef.current.contains(e.target as Node)) {
        setPartColorPopover(null)
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && partColorPopover) {
        handleColorCancel()
      }
    }
    window.addEventListener('mousedown', close, { capture: true })
    window.addEventListener('keydown', handleEscape)
    return () => {
      window.removeEventListener('mousedown', close, { capture: true })
      window.removeEventListener('keydown', handleEscape)
    }
  }, [partColorPopover, handleColorCancel])

  useEffect(() => {
    if (partColorPopover) {
      const style = partStyle[partColorPopover.bodyId]
      setPartTransparencyDraft(style?.transparency ?? 0)
      setPartMetalnessDraft(style?.metalness ?? 0.3)
      // Preview mode started below
      if (docRef.current) {
        startPreviewMode(docRef.current)
        colorPreviewActive.current = true
      }
    } else {
      // Preview mode cleanup below
      if (colorPreviewActive.current) {
        const originalDoc = cancelPreview()
        if (originalDoc && docRef.current) {
          docRef.current = originalDoc
          setDoc(originalDoc)
          reSolve(originalDoc)
        }
        colorPreviewActive.current = false
      }
    }
  }, [partColorPopover, partStyle, docRef, setDoc, reSolve, startPreviewMode, cancelPreview])

  const enterEditFeature = useCallback((featureId: string) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx < 0) return
    setSavedRollbackPosition(rollbackPosition ?? features.length)
    setRollbackPosition(idx + 1)
    setEditForcedVisible(new Set([featureId]))
    setEditingFeatureId(featureId)
    setPickBoundary(null)
    // Clear pickBodies so bodyItems remain interactive during sketch edit.
    // Without this, stale pick_bodies from a previous operation (e.g. creating
    // an extrude) would make bodyItems non-interactive.
    setPickBodies({})
  }, [features, rollbackPosition, setPickBoundary, setPickBodies])

  const exitEditFeature = useCallback(() => {
    if (savedRollbackPosition !== null) {
      // Only restore saved rollback if user hasn't manually dragged the rollbar
      // during editing. If the current rollback differs from the saved one,
      // the user explicitly changed it.
      if (rollbackPosition === savedRollbackPosition || rollbackPosition === null) {
        setRollbackPosition(savedRollbackPosition)
      }
      setSavedRollbackPosition(null)
    }
    setEditForcedVisible(new Set())
    setEditingFeatureId(null)
    setPendingPickField(null)
    setPickBoundary(null)
  }, [savedRollbackPosition, rollbackPosition, setPendingPickField, setPickBoundary])

  const enterEditSketch = useCallback((featureId: string) => {
    enterEditFeature(featureId)
    setMode('sketch')
  }, [enterEditFeature, setMode])

  const exitEditSketch = useCallback(() => {
    exitEditFeature()
  }, [exitEditFeature])

  const handleAlignCameraToSketchPlane = useCallback(() => {
    if (!activeSketchFeatureId || !features) return

    const activeSketch = features.find(f => f.id === activeSketchFeatureId)
    if (!activeSketch || activeSketch.kind !== 'sketch') return

    const planeId = activeSketch.plane || 'builtin_plane_front'
    const cleanPlaneId = planeId.replace(/^@/, '')

    viewportRef.current?.alignCameraToPlane(cleanPlaneId)
  }, [activeSketchFeatureId, features])

  // When the sketch-on-face plane selection completes (planeSelectionFeatureId clears),
  // open the pending sketch for editing if one was created via handleAddSketchOnFace.
  const pendingSketchOnFaceId = useRef<string | null>(null)
  useEffect(() => {
    if (planeSelectionFeatureId) {
      pendingSketchOnFaceId.current = planeSelectionFeatureId
    } else if (pendingSketchOnFaceId.current) {
      const fid = pendingSketchOnFaceId.current
      pendingSketchOnFaceId.current = null
      const feature = features.find(f => f.id === fid)
      if (feature?.kind === 'sketch') {
        enterEditFeature(fid)
        setMode('sketch')
      }
    }
  }, [planeSelectionFeatureId, features, enterEditFeature, setMode])

  const handleRightClick = useCallback((pos: [number, number], targetId?: string) => {
    const store = useSketchEditorStore.getState()
    const hoveredSurfaceId = store.hoveredSurfaceId ?? store.hovered3DSurfaceId
    const hoveredFaceNormal = store.hoveredFaceNormal
    const hoveredFaceCenter = store.hoveredFaceCenter

    if (hoveredSurfaceId && hoveredFaceNormal && hoveredFaceCenter) {
      setContextMenu({
        position: pos,
        items: [
          {
            label: 'Align to Face',
            onClick: () => {
              viewportRef.current?.alignCameraToFace(hoveredFaceNormal, hoveredFaceCenter)
            },
          },
        ],
      })
      return
    }

    if (targetId?.startsWith('body:')) {
      const bodyId = targetId.slice('body:'.length)
      setContextMenu({
        position: pos,
        targetId,
        items: [
          {
            label: 'Rename',
            icon: iconRenameIcon,
            onClick: () => {
              const newLabel = window.prompt('Enter new name:', partLabels[bodyId] || bodyId)
              if (newLabel && newLabel.trim()) {
                handleBodyRename(bodyId, newLabel)
              }
            },
          },
          {
            label: 'Color',
            icon: contextColorIcon,
            onClick: () => {
              setPartColorDraft(partColors[bodyId] || '#6AB59B')
              setPartColorPopover({ bodyId, position: pos })
            },
          },
          {
            label: 'Export',
            icon: featureExportIcon,
            onClick: () => {
              setExportTargetBodyId(bodyId)
              setExportDefaultName(partLabels[bodyId] || bodyId)
              setExportDialogOpen(true)
            },
          },
        ],
      })
      return
    }

    const featureId = targetId
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
      })
      if (featureId === activeSketchFeatureId) {
        items.push({
          label: 'Align camera',
          icon: contextCameraIcon,
          onClick: handleAlignCameraToSketchPlane,
        })
      }
    }

    if (featureId && featureId !== activeSketchFeatureId) {
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
        const target = features.find(f => f.id === featureId)
        items.push({
          label: 'Rename',
          icon: iconRenameIcon,
          onClick: () => {
            const newLabel = window.prompt('Enter new name:', target?.label || target?.id)
            if (newLabel && newLabel.trim()) {
              handleFeatureRename(featureId, newLabel.trim())
            }
          },
        })
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
      targetId,
      items,
    })
  }, [handleRebuild, activeSketchFeatureId, handleExitSketch, enterEditSketch, features, visibleFeatures, toggleVisibility, handleDeleteFeature, handleFeatureRename, partLabels, handleBodyRename, partColors, handleAlignCameraToSketchPlane])

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key === 'F2' || e.code === 'F2') {
        if (!user?.is_admin) {
          e.preventDefault()
          return
        }
        setDebugOpen(prev => !prev)
      }
    }
    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [user?.is_admin])

  return (
    <div className="document-viewer">
      <AppHeader>
        <button className="toolbar-btn" title="Undo" onClick={handleUndo} disabled={undoStack.length === 0}>
          <span className="material-icons-outlined">undo</span>
        </button>
        <button className="toolbar-btn" title="Redo" onClick={handleRedo} disabled={redoStack.length === 0}>
          <span className="material-icons-outlined">redo</span>
        </button>
        <button className="toolbar-btn" title="Save" onClick={handleSave} disabled={readOnly}>
          <span className="material-icons-outlined">save</span>
        </button>
        <button className="toolbar-btn" title="Clone document" onClick={handleClone}>
          <span className="material-icons-outlined">file_copy</span>
        </button>
        {permission === 'owner' && (
          <button
            className="toolbar-btn"
            title="Share document"
            onClick={() => setShareDocOpen(true)}
            disabled={readOnly}
          >
            <span className="material-icons-outlined">share</span>
          </button>
        )}
        {readOnly && (
          <span className="doc-name" style={{ color: '#ef5350', fontSize: '12px', marginLeft: '8px' }}>
            <span className="material-icons-outlined" style={{ fontSize: '14px', verticalAlign: 'middle' }}>lock</span>
            {' '}View Only
          </span>
        )}
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
          pendingPickField={pendingPickField}
          planeSelectionFeatureId={planeSelectionFeatureId}
          onToggleSelect={toggleNormalSelection}
          onEnterEditSketch={enterEditSketch}
          onExitEditSketch={exitEditSketch}
          onAlignCameraToSketchPlane={handleAlignCameraToSketchPlane}
          onEnterEditFeature={enterEditFeature}
          onExitEditFeature={exitEditFeature}
          onToggleVisibility={toggleVisibility}
          onRightClick={handleRightClick}
          onRename={handleFeatureRename}
          onRollbackDragStart={handleRollbackDragStart}
          onMutation={handleMutation}
          onSetRollbackPosition={handleUserRollbackChange}
          onSetPendingPickField={setPendingPickField}
          onSetPlaneSelectionFeatureId={setPlaneSelectionFeatureId}
          onToggleBodyVisibility={toggleBodyVisibility}
          partLabels={partLabels}
          visibleBodies={effectiveVisibleBodies}
          solveResults={solveResults}
          bodies={bodies}
          onRebuild={handleClearCacheAndRebuild}
          isRebuilding={isRebuilding}
          featureTimings={featureTimings}
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
                <button className="editor-btn" title="Add Extrude (E)" onClick={() => handleAddFeature('extrude', { sketchQuery: '', distance: 10 })} disabled={readOnly}><img src={featureExtrudeIcon} alt="Add Extrude" /></button>

                <button className="editor-btn" title="Add Revolve" onClick={() => handleAddFeature('revolve', { sketchQuery: '', angle: 360 })} disabled={readOnly}><img src={featureRevolveIcon} alt="Add Revolve" /></button>

                <button className="editor-btn" title="Add Fillet" onClick={() => handleAddFeature('fillet')} disabled={readOnly}><img src={featureFilletIcon} alt="Add Fillet" /></button>

                <button className="editor-btn" title="Add Chamfer" onClick={() => handleAddFeature('chamfer')} disabled={readOnly}><img src={featureChamferIcon} alt="Add Chamfer" /></button>

                <button className="editor-btn" title="Add Boolean" onClick={() => handleAddFeature('boolean')} disabled={readOnly}><img src={featureBooleanIcon} alt="Add Boolean" /></button>

                <button className="editor-btn" title="Add Array" onClick={() => handleAddFeature('array')} disabled={readOnly}><img src={featureArrayIcon} alt="Add Array" /></button>

                <button className="editor-btn" title="Delete Body" onClick={() => handleAddFeature('delete_body')} disabled={readOnly}><img src={featureDeleteBodyIcon} alt="Delete Body" /></button>

                <button className="editor-btn" title="Add Hole" onClick={() => handleAddFeature('hole')} disabled={readOnly}><img src={featureHoleIcon} alt="Add Hole" /></button>

                <button className="editor-btn" title="Add Transform" onClick={() => handleAddFeature('transform')} disabled={readOnly}><img src={featureTransformIcon} alt="Add Transform" /></button>
                <button className={`editor-btn ${planeSelectionFeatureId ? 'active' : ''}`} title="Sketch" onClick={handleAddSketch} disabled={readOnly}><img src={featureSketchIcon} alt="Sketch" /></button>
                <button className="editor-btn" title="Add plane" onClick={handleAddPlane} disabled={readOnly}><img src={featureAddPlaneIcon} alt="Add plane" /></button>
                <button className="editor-btn" title="Import STEP" onClick={handleImportStep} disabled={readOnly}><img src={featureImportIcon} alt="Import STEP" /></button>
                <button className="editor-btn" title="Export" onClick={handleExportStep}><img src={featureExportIcon} alt="Export" /></button>
              </>
            )}
          </div>

          {solveError && (
            <div className="solve-error-banner">
              Solver error: {solveError}
              <button className="solve-error-dismiss" onClick={() => setSolveError(null)}>×</button>
            </div>
          )}
          {error && (
            <div className="error-banner">
              <p className="error-banner-text">Error loading document: {error}</p>
              <button className="error-banner-dismiss" onClick={() => setError(null)}>×</button>
            </div>
          )}
          {!loading && !error && mode === 'code' && (
            <div className="code-split">
              <textarea className="code-input" value={codeText} onChange={e => setCodeText(e.target.value)} placeholder="Document content..." spellCheck="false" />
              <div className="code-result">
                {solving ? <span className="code-result-status">Solving...</span> : solveResult ? <pre>{solveResult}</pre> : <span className="code-result-status">Press Run to solve</span>}
              </div>
            </div>
          )}
          {mode !== 'code' && (
            <div style={{ position: 'relative', width: '100%', height: '100%' }}>
              <Viewport ref={viewportRef} features={features as Feature[]} featureDefs={doc?.features} rollbackPosition={rollbackPosition ?? undefined} visibleFeatures={visibleFeatures} visibleBodies={effectiveVisibleBodies} solveResults={solveResults} resetTrigger={viewportReset} activeFeatureId={activeSketchFeatureId} onRightClick={(pos) => handleRightClick(pos)} showDebugHit={showDebugHit} otherSketches={otherSketches} bodies={bodies} pickBodies={pickBodies} partColors={partColors} partStyle={partStyle} ghostMode={ghostMode} />
              <LoadingOverlay isDocumentLoading={loading} />
            </div>
          )}
        </div>

        <PartDebugPanel
          debugOpen={debugOpen && !!user?.is_admin}
          debugTab={debugTab}
          setDebugTab={setDebugTab}
          hoveredEntityId={hoveredEntityId}
          hoveredVertexId={hoveredVertexId}
          hoveredPlaneId={hoveredPlaneId}
          hoveredSurfaceId={hoveredSurfaceId}
          hovered3DSurfaceId={hovered3DSurfaceId}
          dynamicSelection={dynamicSelection}
          selection={selection}
          bugReportForm={bugReportForm}
          setBugReportForm={setBugReportForm}
          bugReporting={bugReporting}
          bugReportError={bugReportError}
          bugReportAttachments={bugReportAttachments}
          setBugReportAttachments={setBugReportAttachments}
          onSubmitBugReport={handleSubmitBugReport}
          editingFeatureId={editingFeatureId}
          solveResults={solveResults}
          undoStack={undoStack}
          redoStack={redoStack}
        />
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
        <FooterMeasurementDisplay sketch={measurementSketch} measurementIcon={measurementIcon} solveResults={solveResults} bodies={bodies} />
        <div className="debug-buttons">
          {user?.is_admin && (
            <button
              className={`footer-debug-btn ${debugOpen ? 'active' : ''}`}
              title="Toggle debug panel (F2)"
              onClick={() => setDebugOpen(v => !v)}
            >
              <span className="material-icons-outlined">bug_report</span>
            </button>
          )}
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
      {partColorPopover && (
        <div
          ref={partColorPopoverRef}
          className="part-color-popover"
          style={{ left: partColorPopover.position[0], top: partColorPopover.position[1] + 6 }}
          onMouseDown={e => e.stopPropagation()}
          onPointerDown={e => e.stopPropagation()}
          onClick={e => e.stopPropagation()}
        >
          <div className="part-color-popover-row">
            <span className="part-color-popover-label">Color</span>
            <input
              type="text"
              className="part-color-input"
              value={partColorDraft}
              onChange={(e) => {
                const val = e.target.value.toUpperCase()
                setPartColorDraft(val)
                const normalized = normalizeHexColor(val)
                if (normalized && partColorPopover) {
                  handleBodyColor(partColorPopover.bodyId, normalized)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPartColorPopover(null)
                if (e.key === 'Enter') {
                  const normalized = normalizeHexColor(partColorDraft)
                  if (normalized) {
                    commitPreview({ type: 'set_part_color', bodyId: partColorPopover!.bodyId, color: normalized })
                    colorPreviewActive.current = false
                    setPartColorPopover(null)
                  }
                }
              }}
              placeholder="#RRGGBB"
            />
          </div>
          <div className="part-color-popover-row">
            <span className="part-color-popover-label">Transparency</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={partTransparencyDraft}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                setPartTransparencyDraft(val)
                if (partColorPopover) {
                  handleBodyTransparency(partColorPopover.bodyId, val)
                }
              }}
              className="part-slider"
            />
            <span className="part-slider-value">{(partTransparencyDraft * 100).toFixed(0)}%</span>
          </div>
          <div className="part-color-popover-row">
            <span className="part-color-popover-label">Metalness</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={partMetalnessDraft}
              onChange={(e) => {
                const val = parseFloat(e.target.value)
                setPartMetalnessDraft(val)
                if (partColorPopover) {
                  handleBodyMetalness(partColorPopover.bodyId, val)
                }
              }}
              className="part-slider"
            />
            <span className="part-slider-value">{(partMetalnessDraft * 100).toFixed(0)}%</span>
          </div>
          <div className="part-color-swatches">
            {PART_COLOR_PALETTE.map(c => (
              <button
                key={c}
                className={`part-color-swatch ${normalizeHexColor(partColorDraft) === c ? 'selected' : ''}`}
                style={{ background: c }}
                title={c}
                onClick={() => {
                  setPartColorDraft(c)
                  if (partColorPopover) {
                    handleBodyColor(partColorPopover.bodyId, c)
                  }
                }}
              />
            ))}
          </div>
          <div className="part-color-popover-actions">
            <button className="part-color-popover-btn" onClick={() => {
              if (partColorPopover) handleColorCancel()
            }}>
              Cancel
            </button>
            <button
              className="part-color-popover-btn part-color-popover-btn-primary"
              disabled={!normalizeHexColor(partColorDraft)}
              onClick={() => {
                if (!partColorPopover) return
                const normalized = normalizeHexColor(partColorDraft)
                if (!normalized) return
                // Commit preview with a single undo entry
                commitPreview({ type: 'set_part_color', bodyId: partColorPopover.bodyId, color: normalized })
                colorPreviewActive.current = false
                setPartColorPopover(null)
              }}
            >
              Apply
            </button>
          </div>
        </div>
      )}
      <ExportDialog
        isOpen={exportDialogOpen}
        defaultName={exportDefaultName}
        onDownload={handleExportDownload}
        onCancel={handleExportCancel}
      />
      <ShareDialog
        isOpen={shareDocOpen}
        documentUuid={uuid!}
        documentName={docName || 'Untitled'}
        ownerUsername={ownerUsername || ''}
        isOwner={permission === 'owner'}
        onClose={() => setShareDocOpen(false)}
      />
    </div>
  )
}
