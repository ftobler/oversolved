import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ViewportHandle } from '@/components/Viewport'
import type { PartDoc, PartFeature, Mutation, Sketch } from '@/types/cad'
import { randomId } from '@/utils/yamlMutations'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { usePartDoc } from '@/hooks/usePartDoc'
import { useAuth } from '@/contexts/AuthContext'
import RightClickMenu from '@/components/RightClickMenu'
import type { ContextMenuItem } from '@/components/RightClickMenu'
import { Sidebar } from '@/components/Sidebar'
import FooterMeasurementDisplay from '@/components/FooterMeasurementDisplay'
import WsStatusIndicator from '@/components/WsStatusIndicator'
import { useSyncPartEditorStore } from '@/hooks/useSyncPartEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'

import { useSolverStore } from '@/stores/solverStore'
import { invalidateDocCache } from '@/utils/buildCache'
import { http, HttpError } from '@/utils/httpClient'
import '@/pages/Part.css'

import PartToolbar from '@/pages/PartToolbar'
import PartEditorPanel from '@/pages/PartEditorPanel'
import PartDebugPanel from '@/pages/PartDebugPanel'
import PartColorPopover from '@/pages/PartColorPopover'
import PartExportImport, { type PartExportImportHandle } from '@/pages/PartExportImport'
import { usePartCommands } from '@/pages/PartKeyboardShortcuts'
import { useEditFeature } from '@/pages/useEditFeature'

import measurementIcon from '@/assets/icons/measurement.svg'

import { buildContextMenu } from './buildContextMenu'
import type { BuildContextMenuInput, BuildContextMenuCallbacks } from './buildContextMenu'

import { normalizeHexColor } from '@/utils/partColors'
import { computeEffectiveVisibleBodies } from '@/components/Viewport/bodyUtils'
import { BUILTIN_FEATURE_DEFAULTS } from '@/hooks/usePartDoc'

const BUILT_IN_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

type RollbackState = { position: number | null; source: 'user' | 'handler' | null }

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

export default function Part() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const [codeText, setCodeText] = useState('')
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackState, setRollbackState] = useState<RollbackState>({ position: null, source: null })
  const rollbackPosition = rollbackState.position
  const setRollbackFromUser = useCallback((pos: number | null) =>
    setRollbackState({ position: pos, source: 'user' }), [])
  const setRollbackFromHandler = useCallback((pos: number | null) =>
    setRollbackState({ position: pos, source: 'handler' }), [])
  const rollbackInitialized = useRef(false)
  const [viewportReset, setViewportReset] = useState(0)
  const viewportRef = useRef<ViewportHandle>(null)
  const exportImportRef = useRef<PartExportImportHandle>(null)
  const handleFirstSolve = useCallback(() => {
    viewportRef.current?.autoZoomToFit()  // camera-only; intentional no-op when Viewport absent
  }, [])
  const [contextMenu, setContextMenu] = useState<{ position: [number, number]; targetId?: string; items: ContextMenuItem[] } | null>(null)
  const [partColorPopover, setPartColorPopover] = useState<{ bodyId: string; position: [number, number]; session: number } | null>(null)
  const colorPopoverSession = useRef(0)
  const { user } = useAuth()

  const [debugOpen, setDebugOpen] = useState(false)
  const showDebugHit = useSketchEditorStore(s => s.showDebugHit)
  const setShowDebugHit = useSketchEditorStore(s => s.setShowDebugHit)

  const planeSelectionFeatureId = useSketchEditorStore(s => s.planeSelectionFeatureId)
  const setPlaneSelectionFeatureId = useSketchEditorStore(s => s.setPlaneSelectionFeatureId)
  const selection = useSketchEditorStore(s => s.normalSelection)
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
    validation,
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
    startEditSession,
    commitEditSession,
    cancelEditSession,
  } = usePartDoc(uuid, mode, setCodeText, { onFirstSolve: handleFirstSolve })

  const readOnly = permission === 'view'

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


  useEffect(() => {
    if (doc && !rollbackInitialized.current) {
      rollbackInitialized.current = true
      setRollbackFromHandler(extractFeatures(doc).length)
    }
  }, [doc, setRollbackFromHandler])

  useEffect(() => {
    if (rollbackPosition !== null && rollbackPosition > features.length) {
      setRollbackFromHandler(features.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features.length])

  useEffect(() => {
    if (rollbackState.source !== 'user') return
    setPickBoundary(null)
    if (docRef.current) reSolve(docRef.current, rollbackState.position ?? features.length)
  }, [rollbackState, docRef, reSolve, setPickBoundary, features.length])

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
      // Opt into validation: the kernel will do a parallel fresh full rebuild
      // and surface a diff in `validation` so the popover can render the badge.
      await reSolve(docRef.current, rollbackPosition ?? features.length, { validate: true })
    } catch (e) {
      console.error('Rebuild failed:', e)
    } finally {
      setIsRebuilding(false)
    }
  }, [uuid, reSolve, rollbackPosition, features, docRef])

  // Stable ref so useEditFeature can call the current handleRebuild without closure staleness
  const handleRebuildRef = useRef(handleRebuild)
  handleRebuildRef.current = handleRebuild
  const getHandleRebuild = useCallback(() => handleRebuildRef.current, [])
  const clearPickBodies = useCallback(() => setPickBodies({}), [setPickBodies])

  const {
    editingFeatureId,
    editForcedVisible,
    enterEditFeature,
    commitEditFeature,
    cancelEditFeature,
    exitEditFeature,
    enterEditSketch,
    exitEditSketch,
    clearEditingFeature,
  } = useEditFeature({
    features,
    rollbackPosition,
    builtInIds: BUILT_IN_IDS,
    setRollbackPos,
    setRollbackFromHandler,
    setPickBoundary,
    clearPickBodies,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    docRef,
    reSolve,
    setMode,
    getHandleRebuild,
  })

  const visibleFeaturesWithEdit = useMemo(
    () => new Set([
      ...features.filter(f => f.visible !== false).map(f => f.id),
      ...editForcedVisible,
    ]),
    [features, editForcedVisible]
  )

  const effectiveVisibleBodies = useMemo(
    () => computeEffectiveVisibleBodies(bodies, visibleFeaturesWithEdit, partStyle),
    [bodies, visibleFeaturesWithEdit, partStyle],
  )

  const activeSketchFeatureId = useMemo(() => {
    if (!editingFeatureId) return undefined
    const feature = features.find(f => f.id === editingFeatureId)
    if (!feature || feature.kind !== 'sketch') return undefined
    const limit = rollbackPosition ?? features.length
    const sketches = features.slice(0, limit).filter(f => f.kind === 'sketch' && visibleFeaturesWithEdit.has(f.id))
    return sketches.some(f => f.id === editingFeatureId) ? editingFeatureId : undefined
  }, [features, rollbackPosition, visibleFeaturesWithEdit, editingFeatureId])

  const ghostMode = useMemo(() => {
    if (!editingFeatureId) return false
    const feature = features.find(f => f.id === editingFeatureId)
    return !!feature && feature.kind !== 'sketch' && feature.kind !== 'plane'
  }, [features, editingFeatureId])

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

  const otherSketches = useMemo(() => {
    const result: Record<string, Sketch> = {}
    for (const feature of features) {
      if (feature.kind !== 'sketch') continue
      if (!visibleFeaturesWithEdit.has(feature.id)) continue
      if (feature.id === activeSketchFeatureId) continue
      const solveResult = solveResults?.[feature.id]
      if (solveResult?.solved) {
        result[feature.id] = solveResult.solved
      }
    }
    return result
  }, [features, visibleFeaturesWithEdit, activeSketchFeatureId, solveResults])

  useSyncPartEditorStore({
    features,
    doc,
    rollbackPosition,
    editingFeatureId,
    activeSketchFeatureId: activeSketchFeatureId ?? null,
    visibleFeatures: visibleFeaturesWithEdit,
    visibleBodies: effectiveVisibleBodies,
    partLabels,
    solveResults: solveResults ?? {},
    bodies: bodies ?? {},
    pickBodies: pickBodies ?? {},
    isRebuilding,
    featureTimings: featureTimings ?? {},
    validation: validation ?? null,
    ghostMode,
    otherSketches,
    partColors,
    partStyle,
    undoStack,
    redoStack,
  })

  const handleExitSketch = useCallback(() => {
    clearEditingFeature()
    setContextMenu(null)
  }, [clearEditingFeature])

  const handleDeleteFeature = useCallback((featureId: string) => {
    if (BUILT_IN_IDS.has(featureId)) return
    handleMutation({ type: 'delete_feature', featureId })
    useSketchEditorStore.getState().clearNormalSelection()
    setContextMenu(null)
  }, [handleMutation])

  const handleDeleteSelectedFeatures = useCallback(() => {
    const sel = useSketchEditorStore.getState().normalSelection
    const featureIds = [...sel]
      .filter(id => id.startsWith('@') && !id.startsWith('@builtin_'))
      .map(id => id.slice(1))
      .filter(id => !BUILT_IN_IDS.has(id))
    for (const featureId of featureIds) {
      handleMutation({ type: 'delete_feature', featureId })
    }
    if (featureIds.length > 0) useSketchEditorStore.getState().clearNormalSelection()
  }, [handleMutation])

  const handleAddFeature = useCallback((kind: string, extra?: Record<string, unknown>) => {
    if (!doc) return
    const fid = randomId(18)
    const label = `${kind} ${Object.keys(bodies).length + 1}`
    setPickBoundary(features.filter(f => !BUILT_IN_IDS.has(f.id)).length)
    setRollbackPos(features.length + 1)
    handleMutation({ type: `add_${kind}`, featureId: fid, label, ...extra } as Mutation)
    setRollbackFromHandler(features.length + 1)
    enterEditFeature(fid)
  }, [doc, features, handleMutation, bodies, setPickBoundary, setRollbackPos, setRollbackFromHandler, enterEditFeature])

  const handleAddPlane = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const label = `plane ${planeCount + 1}`
    const faceQuery = [...selection].find(id => id.startsWith('?') && id.includes(':face'))
    const definition = faceQuery ? { mode: 'on_face', face: faceQuery } as const : undefined
    setRollbackPos(features.length + 1)
    handleMutation({ type: 'add_plane', featureId, label, definition })
    setRollbackFromHandler(features.length + 1)
    enterEditFeature(featureId)
  }, [doc, features.length, handleMutation, selection, setRollbackPos, setRollbackFromHandler, enterEditFeature])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    const { setPendingPickField } = useSketchEditorStore.getState()
    setPendingPickField(null)
    setRollbackPos(features.length + 1)
    handleMutation({ type: 'add_sketch', featureId, label })
    setRollbackFromHandler(features.length + 1)
    setPlaneSelectionFeatureId(featureId)
    enterEditFeature(featureId)
  }, [doc, features.length, handleMutation, setPlaneSelectionFeatureId, setRollbackPos, setRollbackFromHandler, enterEditFeature])

  const handleImportStep = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.step,.stp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      const form = new FormData()
      form.append('file', file)
      const data = await http.postForm<{ file_id?: string }>('/api/upload', form).catch(() => null)
      if (!data?.file_id) return
      const featureId = randomId(18)
      const label = file.name.replace(/\.(step|stp)$/i, '')
      setRollbackPos(features.length + 1)
      handleMutation({ type: 'add_import_step', featureId, fileId: data.file_id, label })
    }
    input.click()
  }, [handleMutation, features.length, setRollbackPos])

  const handleExportStep = useCallback(() => {
    exportImportRef.current?.openExport(null, docName || 'export')
  }, [docName])

  const handleToggleSketchPlaneVisibility = useCallback(() => {
    handleMutation({ type: 'toggle_sketch_plane_visibility' })
  }, [handleMutation])

  useEffect(() => {
    setSketchCallback('onMutation', handleMutation)
    return () => setSketchCallback('onMutation', null)
  }, [handleMutation])

  useEffect(() => {
    setSketchCallback('onRebuild', handleRebuild)
    return () => setSketchCallback('onRebuild', null)
  }, [handleRebuild])

  useEffect(() => {
    setSketchCallback('onExitSketch', handleExitSketch)
    return () => setSketchCallback('onExitSketch', null)
  }, [handleExitSketch])

  useEffect(() => {
    useSketchEditorStore.getState().setActiveFeatureId(activeSketchFeatureId ?? null)
  }, [activeSketchFeatureId])

  useEffect(() => {
    useSolverStore.getState().setIsSolving(solving)
  }, [solving])

  usePartCommands(
    handleUndo,
    handleRedo,
    handleDeleteSelectedFeatures,
    handleToggleSketchPlaneVisibility,
    handleAddFeature,
  )

  const handleSave = async () => {
    if (!uuid || !doc) return
    const success = await saveDoc(uuid, doc, viewportRef.current?.captureScreenshotForSaving)  // screenshot is optional; save proceeds without Viewport
    if (success) setError(null)
  }

  const handleClone = async () => {
    if (!uuid) return
    try {
      const data = await http.postJson<{ uuid: string }>(`/api/documents/${uuid}/clone`)
      navigate(`/documents/${data.uuid}`)
    } catch (e) {
      if (e instanceof HttpError) {
        const parsed = JSON.parse(e.body || '{}') as { error?: string }
        setError(parsed.error || 'Failed to clone document')
      } else {
        setError(String(e))
      }
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

  const handleRollbackDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleUserRollbackChange = useCallback((pos: number | null) => {
    setRollbackFromUser(pos)
  }, [setRollbackFromUser])

  const toggleVisibility = useCallback((featureId: string) => {
    handleMutation({ type: 'set_feature_visibility', featureId, visible: !visibleFeaturesWithEdit.has(featureId) })
    setContextMenu(null)
  }, [handleMutation, visibleFeaturesWithEdit])

  const toggleSuppression = useCallback((featureId: string, suppressed: boolean) => {
    handleMutation({ type: 'set_feature_suppression', featureId, suppressed })
    setContextMenu(null)
  }, [handleMutation])

  const handleFeatureRename = useCallback((featureId: string, label: string) => {
    const trimmed = label.trim()
    if (!trimmed) return
    handleMutation({ type: 'rename_feature', featureId, label: trimmed })
  }, [handleMutation])

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

  const handleBodyRoughness = useCallback((bodyId: string, roughness: number) => {
    const clamped = Math.max(0, Math.min(1, roughness))
    handleMutation({ type: 'set_part_roughness', bodyId, roughness: clamped })
  }, [handleMutation])

  const handleBodyTransmission = useCallback((bodyId: string, transmission: number) => {
    const clamped = Math.max(0, Math.min(1, transmission))
    handleMutation({ type: 'set_part_transmission', bodyId, transmission: clamped })
  }, [handleMutation])

  const handleColorCancel = useCallback(() => {
    if (!partColorPopover) return
    const originalDoc = cancelPreview()
    if (originalDoc && docRef.current) {
      docRef.current = originalDoc
      setDoc(originalDoc)
      reSolve(originalDoc)
    }
    setPartColorPopover(null)
  }, [partColorPopover, cancelPreview, docRef, setDoc, reSolve])

  const handleColorApply = useCallback((mutation: Mutation) => {
    commitPreview(mutation)
    setPartColorPopover(null)
  }, [commitPreview])

  const handleAlignCameraToSketchPlane = useCallback(() => {
    if (!activeSketchFeatureId || !features) return

    const activeSketch = features.find(f => f.id === activeSketchFeatureId)
    if (!activeSketch || activeSketch.kind !== 'sketch') return

    const planeId = activeSketch.plane || 'builtin_plane_front'
    const cleanPlaneId = planeId.replace(/^@/, '')

    viewportRef.current?.alignCameraToPlane(cleanPlaneId)  // camera-only; intentional no-op when Viewport absent
  }, [activeSketchFeatureId, features])

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
    const input: BuildContextMenuInput = {
      pos,
      targetId,
      hoveredSurfaceId: store.hoveredSurfaceId ?? store.hovered3DSurfaceId,
      hoveredFaceNormal: store.hoveredFaceNormal,
      hoveredFaceCenter: store.hoveredFaceCenter,
      features,
      visibleFeatures: visibleFeaturesWithEdit,
      activeSketchFeatureId: activeSketchFeatureId ?? undefined,
      partLabels,
      builtInIds: BUILT_IN_IDS,
    }
    const callbacks: BuildContextMenuCallbacks = {
      onRebuild: handleRebuild,
      onToggleVisibility: toggleVisibility,
      onToggleSuppression: toggleSuppression,
      onEnterEditSketch: enterEditSketch,
      onExitSketch: handleExitSketch,
      onDeleteFeature: handleDeleteFeature,
      onFeatureRename: handleFeatureRename,
      onBodyRename: handleBodyRename,
      onAlignToFace: (normal, center) => viewportRef.current?.alignCameraToFace(normal, center),
      onAlignCameraToSketchPlane: handleAlignCameraToSketchPlane,
      onSetPartColorPopover: (opts) => {
        if (opts && docRef.current) {
          startPreviewMode(docRef.current)
          colorPopoverSession.current++
          setPartColorPopover({ ...opts, session: colorPopoverSession.current })
        } else {
          setPartColorPopover(null)
        }
      },
      onExportBody: (bodyId, name) => exportImportRef.current?.openExport(bodyId, name),
      onShowContextMenu: (items, tid) => setContextMenu({ position: pos, targetId: tid, items }),
    }
    const { items } = buildContextMenu(input, callbacks)
    setContextMenu({ position: pos, targetId, items })
  }, [handleRebuild, toggleVisibility, toggleSuppression, enterEditSketch, handleExitSketch, handleDeleteFeature,
    handleFeatureRename, handleBodyRename, handleAlignCameraToSketchPlane,
    features, visibleFeaturesWithEdit, activeSketchFeatureId, partLabels,
    viewportRef, docRef, startPreviewMode])

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

  const partEditorCallbacks = useMemo(() => ({
    onToggleSelect: toggleNormalSelection,
    onEnterEditSketch: enterEditSketch,
    onExitEditSketch: exitEditSketch,
    onAlignCameraToSketchPlane: handleAlignCameraToSketchPlane,
    onEnterEditFeature: enterEditFeature,
    onExitEditFeature: exitEditFeature,
    onEditCommit: commitEditFeature,
    onEditCancel: cancelEditFeature,
    onToggleVisibility: toggleVisibility,
    onRightClick: handleRightClick,
    onRename: handleFeatureRename,
    onRollbackDragStart: handleRollbackDragStart,
    onMutation: handleMutation,
    onSetRollbackPosition: handleUserRollbackChange,
    onRebuild: handleClearCacheAndRebuild,
  }), [toggleNormalSelection, enterEditSketch, exitEditSketch, handleAlignCameraToSketchPlane,
    enterEditFeature, exitEditFeature, commitEditFeature, cancelEditFeature,
    toggleVisibility, handleRightClick, handleFeatureRename,
    handleRollbackDragStart, handleMutation, handleUserRollbackChange,
    handleClearCacheAndRebuild])

  return (
    <div className="document-viewer">
      <PartToolbar
        readOnly={readOnly}
        permission={permission}
        docName={docName}
        onRename={(name) => renameDoc(uuid!, name)}
        handleSave={handleSave}
        handleClone={handleClone}
        onShare={() => exportImportRef.current?.openShare()}
      />

      <PartEditorPanel
        mode={mode}
        setMode={setMode}
        codeText={codeText}
        setCodeText={setCodeText}
        solving={solving}
        solveTime={solveTime}
        solveResult={solveResult}
        handleRun={handleRun}
        solveError={solveError}
        setSolveError={setSolveError}
        error={error}
        setError={setError}
        readOnly={readOnly}
        loading={loading}
        planeSelectionFeatureId={planeSelectionFeatureId}
        handleAddFeature={handleAddFeature}
        handleAddSketch={handleAddSketch}
        handleAddPlane={handleAddPlane}
        handleImportStep={handleImportStep}
        handleExportStep={handleExportStep}
        setViewportReset={setViewportReset}
        viewportRef={viewportRef}
        viewportReset={viewportReset}
        handleRightClick={handleRightClick}
        rightPanel={
          <PartDebugPanel
            debugOpen={debugOpen && !!user?.is_admin}
            mode={mode}
          />
        }
      >
        <PartEditorProvider value={partEditorCallbacks}>
          <Sidebar />
        </PartEditorProvider>
      </PartEditorPanel>

      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
        <WsStatusIndicator />
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
      <PartColorPopover
        popover={partColorPopover}
        onColorSet={handleBodyColor}
        onTransparencySet={handleBodyTransparency}
        onMetalnessSet={handleBodyMetalness}
        onRoughnessSet={handleBodyRoughness}
        onTransmissionSet={handleBodyTransmission}
        onCancel={handleColorCancel}
        onApply={handleColorApply}
      />
      <PartExportImport
        ref={exportImportRef}
        uuid={uuid!}
        docName={docName}
        ownerUsername={ownerUsername}
        permission={permission}
      />
    </div>
  )
}
