import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ViewportHandle } from '@/components/Viewport'
import type { PartDoc, PartFeature, Mutation, Sketch } from '@/types/cad'
import { randomId } from '@/utils/yamlMutations'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { usePartDoc } from '@/hooks/usePartDoc'
import { useAuth } from '@/contexts/AuthContext'
import { useNotify } from '@/contexts/ToastContext'
import type { ExportFormat } from '@/components/ExportDialog'
import RightClickMenu from '@/components/RightClickMenu'
import type { ContextMenuItem } from '@/components/RightClickMenu'
import { Sidebar } from '@/components/Sidebar'
import FooterMeasurementDisplay from '@/components/FooterMeasurementDisplay'
import WsStatusIndicator from '@/components/WsStatusIndicator'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'

import { useSolverStore } from '@/stores/solverStore'
import { invalidateDocCache } from '@/utils/buildCache'
import { describeMutation } from '@/utils/mutationDescriptions'
import { http, HttpError } from '@/utils/httpClient'
import '@/pages/Part.css'

import PartToolbar from '@/pages/PartToolbar'
import PartEditorPanel from '@/pages/PartEditorPanel'
import PartDebugPanel from '@/pages/PartDebugPanel'
import PartColorPopover from '@/pages/PartColorPopover'
import PartExportImport from '@/pages/PartExportImport'
import { usePartCommands } from '@/pages/PartKeyboardShortcuts'

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
  const [isEditing, setIsEditing] = useState(false)
  const [editName, setEditName] = useState('')
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  const [rollbackState, setRollbackState] = useState<RollbackState>({ position: null, source: null })
  const rollbackPosition = rollbackState.position
  const setRollbackFromUser = useCallback((pos: number | null) =>
    setRollbackState({ position: pos, source: 'user' }), [])
  const setRollbackFromHandler = useCallback((pos: number | null) =>
    setRollbackState({ position: pos, source: 'handler' }), [])
  const [savedRollbackPosition, setSavedRollbackPosition] = useState<number | null>(null)
  const editEntryRollback = useRef<number | null>(null)
  const [editForcedVisible, setEditForcedVisible] = useState<Set<string>>(new Set())
  const rollbackInitialized = useRef(false)
  const [viewportReset, setViewportReset] = useState(0)
  const viewportRef = useRef<ViewportHandle>(null)
  const handleFirstSolve = useCallback(() => {
    viewportRef.current?.autoZoomToFit()  // camera-only; intentional no-op when Viewport absent
  }, [])
  const [editingFeatureId, setEditingFeatureId] = useState<string | null>(null)
  const [contextMenu, setContextMenu] = useState<{ position: [number, number]; targetId?: string; items: ContextMenuItem[] } | null>(null)
  const [partColorPopover, setPartColorPopover] = useState<{ bodyId: string; position: [number, number] } | null>(null)
  const [partColorDraft, setPartColorDraft] = useState<string>('#6AB59B')
  const [partTransparencyDraft, setPartTransparencyDraft] = useState(0)
  const [partMetalnessDraft, setPartMetalnessDraft] = useState(0.3)
  const partColorPopoverRef = useRef<HTMLDivElement>(null)
  const { user } = useAuth()
  const notify = useNotify()

  const [debugOpen, setDebugOpen] = useState(false)
  const [debugTab, setDebugTab] = useState<'selection' | 'bug-report' | 'undo-redo' | 'ws'>('selection')
  const showDebugHit = useSketchEditorStore(s => s.showDebugHit)
  const setShowDebugHit = useSketchEditorStore(s => s.setShowDebugHit)
  const [bugReportForm, setBugReportForm] = useState({ title: '', description: '' })
  const [bugReporting, setBugReporting] = useState(false)
  const [bugReportError, setBugReportError] = useState<string | null>(null)
  const [exportDialogOpen, setExportDialogOpen] = useState(false)
  const [undoHover, setUndoHover] = useState(false)
  const [redoHover, setRedoHover] = useState(false)
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
  const setPendingPickField = useSketchEditorStore(s => s.setPendingPickField)
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

  useEffect(() => {
    if (docName) setEditName(docName)
  }, [docName])

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

  const visibleFeatures = useMemo(
    () => new Set([
      ...features.filter(f => f.visible !== false).map(f => f.id),
      ...editForcedVisible,
    ]),
    [features, editForcedVisible]
  )

  const effectiveVisibleBodies = useMemo(
    () => computeEffectiveVisibleBodies(bodies, visibleFeatures, partStyle),
    [bodies, visibleFeatures, partStyle],
  )

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

  const activeSketchFeatureId = useMemo(() => {
    if (!editingFeatureId) return undefined
    const feature = features.find(f => f.id === editingFeatureId)
    if (!feature || feature.kind !== 'sketch') return undefined
    const limit = rollbackPosition ?? features.length
    const sketches = features.slice(0, limit).filter(f => f.kind === 'sketch' && visibleFeatures.has(f.id))
    return sketches.some(f => f.id === editingFeatureId) ? editingFeatureId : undefined
  }, [features, rollbackPosition, visibleFeatures, editingFeatureId])

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
      if (!visibleFeatures.has(feature.id)) continue
      if (feature.id === activeSketchFeatureId) continue
      const solveResult = solveResults?.[feature.id]
      if (solveResult?.solved) {
        result[feature.id] = solveResult.solved
      }
    }
    return result
  }, [features, visibleFeatures, activeSketchFeatureId, solveResults])

  const ghostMode = useMemo(() => {
    if (!editingFeatureId) return false
    const feature = features.find(f => f.id === editingFeatureId)
    return !!feature && feature.kind !== 'sketch' && feature.kind !== 'plane'
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
      // Opt into validation: the kernel will do a parallel fresh full rebuild
      // and surface a diff in `validation` so the popover can render the badge.
      await reSolve(docRef.current, rollbackPosition ?? features.length, { validate: true })
    } catch (e) {
      console.error('Rebuild failed:', e)
    } finally {
      setIsRebuilding(false)
    }
  }, [uuid, reSolve, rollbackPosition, features, docRef])

  useEffect(() => {
    usePartEditorStore.getState().sync({
      features,
      doc,
      rollbackPosition,
      editingFeatureId,
      activeSketchFeatureId: activeSketchFeatureId ?? null,
      visibleFeatures,
      visibleBodies: effectiveVisibleBodies ?? new Set(),
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
  }, [features, doc, rollbackPosition, editingFeatureId, activeSketchFeatureId, visibleFeatures,
    effectiveVisibleBodies, partLabels, solveResults, bodies, pickBodies, isRebuilding,
    featureTimings, validation, ghostMode, otherSketches, partColors, partStyle, undoStack, redoStack])

  useEffect(() => {
    return () => {
      usePartEditorStore.setState({
        features: [], doc: null, rollbackPosition: null, editingFeatureId: null,
        activeSketchFeatureId: null, visibleFeatures: new Set(), visibleBodies: new Set(),
        partLabels: {}, solveResults: {}, bodies: {}, pickBodies: {}, isRebuilding: false,
        featureTimings: {}, ghostMode: false, otherSketches: {}, partColors: {}, partStyle: {},
        undoStack: [], redoStack: [],
      })
    }
  }, [])

  const handleRebuildRef = useRef(handleRebuild)
  handleRebuildRef.current = handleRebuild

  const prevEditingIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (!docRef.current) return
    const prev = prevEditingIdRef.current
    prevEditingIdRef.current = editingFeatureId
    if (prev === editingFeatureId) return

    const feature = features.find(f => f.id === editingFeatureId)
    let nextBoundary: number | null = null
    if (feature && feature.kind !== 'sketch' && feature.kind !== 'plane') {
      const nonBuiltInFeatures = features.filter(f => !BUILT_IN_IDS.has(f.id))
      const index = nonBuiltInFeatures.findIndex(f => f.id === editingFeatureId)
      if (index >= 0) nextBoundary = index
    }
    setPickBoundary(nextBoundary)
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
    setRollbackFromHandler(features.length + 1)
    setEditingFeatureId(fid)
  }, [doc, features, handleMutation, bodies, setPickBoundary, setRollbackPos, setRollbackFromHandler])

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
    setEditingFeatureId(featureId)
  }, [doc, features.length, handleMutation, selection, setRollbackPos, setRollbackFromHandler])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setPendingPickField(null)
    setRollbackPos(features.length + 1)
    handleMutation({ type: 'add_sketch', featureId, label })
    setRollbackFromHandler(features.length + 1)
    setPlaneSelectionFeatureId(featureId)
    setEditingFeatureId(featureId)
  }, [doc, features.length, handleMutation, setPendingPickField, setPlaneSelectionFeatureId, setRollbackPos, setRollbackFromHandler])

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
      const blob = await http.postBlob(endpoint, body)
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
      if (e instanceof HttpError) {
        console.error('Export failed:', e.status, e.body)
        notify(`Export failed: ${e.body}`, 'error')
      } else {
        console.error('Export error:', e)
        notify(`Export error: ${e}`, 'error')
      }
    }
    setExportTargetBodyId(null)
    setExportDialogOpen(false)
  }, [doc, exportTargetBodyId, exportDefaultName, notify])

  const handleExportCancel = useCallback(() => {
    setExportTargetBodyId(null)
    setExportDialogOpen(false)
  }, [])

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
      await http.postJson('/api/bug-report', report)
      setBugReportForm({ title: '', description: '' })
      notify('Bug report submitted successfully!', 'success')
      setDebugTab('selection')
    } catch (e) {
      setBugReportError(`Failed to submit: ${e}`)
    } finally {
      setBugReporting(false)
    }
  }

  const handleRollbackDragStart = useCallback((e: React.DragEvent) => {
    e.dataTransfer.effectAllowed = 'move'
  }, [])

  const handleUserRollbackChange = useCallback((pos: number | null) => {
    setRollbackFromUser(pos)
  }, [setRollbackFromUser])

  const toggleVisibility = useCallback((featureId: string) => {
    handleMutation({ type: 'set_feature_visibility', featureId, visible: !visibleFeatures.has(featureId) })
    setContextMenu(null)
  }, [handleMutation, visibleFeatures])

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

  useEffect(() => {
    if (!partColorPopover) return
    const close = (e: MouseEvent) => {
      if (partColorPopoverRef.current && !partColorPopoverRef.current.contains(e.target as Node)) {
        handleColorCancel()
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
    if (!partColorPopover) return
    const style = partStyle[partColorPopover.bodyId]
    setPartTransparencyDraft(style?.transparency ?? 0)
    setPartMetalnessDraft(style?.metalness ?? 0.3)
    if (docRef.current) {
      startPreviewMode(docRef.current)
    }
    requestAnimationFrame(() => {
      const firstInput = partColorPopoverRef.current?.querySelector('input, button') as HTMLElement | null
      firstInput?.focus()
    })
  }, [partColorPopover, partStyle, docRef, startPreviewMode])

  const enterEditFeature = useCallback((featureId: string, suppressUndo = true) => {
    const idx = features.findIndex(f => f.id === featureId)
    if (idx < 0) return
    startEditSession(suppressUndo)
    setSavedRollbackPosition(rollbackPosition ?? features.length)
    editEntryRollback.current = idx + 1
    setRollbackFromHandler(idx + 1)
    setEditForcedVisible(new Set([featureId]))
    setEditingFeatureId(featureId)
    setPickBoundary(null)
    setPickBodies({})
  }, [features, rollbackPosition, setPickBoundary, setPickBodies, setRollbackFromHandler,
      startEditSession])

  const _exitEditCleanup = useCallback(() => {
    const targetRollback = savedRollbackPosition !== null ? savedRollbackPosition : rollbackPosition
    if (savedRollbackPosition !== null) {
      if (rollbackPosition === editEntryRollback.current || rollbackPosition === null) {
        setRollbackFromHandler(savedRollbackPosition)
      }
      editEntryRollback.current = null
      setSavedRollbackPosition(null)
    }
    setEditForcedVisible(new Set())
    setEditingFeatureId(null)
    setPendingPickField(null)
    setPickBoundary(null)
    if (docRef.current) reSolve(docRef.current, targetRollback)
  }, [savedRollbackPosition, rollbackPosition, setPendingPickField, setPickBoundary,
      setRollbackFromHandler, docRef, reSolve])

  const commitEditFeature = useCallback(() => {
    commitEditSession()
    _exitEditCleanup()
  }, [commitEditSession, _exitEditCleanup])

  const cancelEditFeature = useCallback(() => {
    cancelEditSession()
    _exitEditCleanup()
  }, [cancelEditSession, _exitEditCleanup])

  const exitEditFeature = useCallback(() => {
    commitEditFeature()
  }, [commitEditFeature])

  const enterEditSketch = useCallback((featureId: string) => {
    enterEditFeature(featureId, false)  // sketch: don't suppress undo
    setMode('sketch')
  }, [enterEditFeature, setMode])

  const exitEditSketch = useCallback(() => {
    commitEditFeature()  // sketch exits always commit
  }, [commitEditFeature])

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
      visibleFeatures,
      activeSketchFeatureId: activeSketchFeatureId ?? undefined,
      partLabels,
      partColors,
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
      onSetPartColorDraft: setPartColorDraft,
      onSetPartColorPopover: setPartColorPopover,
      onSetExportTargetBodyId: setExportTargetBodyId,
      onSetExportDefaultName: setExportDefaultName,
      onSetExportDialogOpen: setExportDialogOpen,
      onShowContextMenu: (items, tid) => setContextMenu({ position: pos, targetId: tid, items }),
    }
    const { items } = buildContextMenu(input, callbacks)
    setContextMenu({ position: pos, targetId, items })
  }, [handleRebuild, toggleVisibility, toggleSuppression, enterEditSketch, handleExitSketch, handleDeleteFeature,
    handleFeatureRename, handleBodyRename, handleAlignCameraToSketchPlane,
    features, visibleFeatures, activeSketchFeatureId, partLabels, partColors,
    viewportRef, setPartColorDraft, setPartColorPopover, setExportTargetBodyId,
    setExportDefaultName, setExportDialogOpen, setContextMenu])

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
        undoStack={undoStack}
        redoStack={redoStack}
        undoHover={undoHover}
        setUndoHover={setUndoHover}
        redoHover={redoHover}
        setRedoHover={setRedoHover}
        readOnly={readOnly}
        permission={permission}
        docName={docName}
        isEditing={isEditing}
        editName={editName}
        setIsEditing={setIsEditing}
        setEditName={setEditName}
        handleRename={handleRename}
        handleSave={handleSave}
        handleClone={handleClone}
        setShareDocOpen={setShareDocOpen}
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
            debugTab={debugTab}
            setDebugTab={setDebugTab}
            bugReportForm={bugReportForm}
            setBugReportForm={setBugReportForm}
            bugReporting={bugReporting}
            bugReportError={bugReportError}
            bugReportAttachments={bugReportAttachments}
            setBugReportAttachments={setBugReportAttachments}
            onSubmitBugReport={handleSubmitBugReport}
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
        popoverRef={partColorPopoverRef}
        colorDraft={partColorDraft}
        onColorDraftChange={setPartColorDraft}
        transparencyDraft={partTransparencyDraft}
        onTransparencyDraftChange={setPartTransparencyDraft}
        metalnessDraft={partMetalnessDraft}
        onMetalnessDraftChange={setPartMetalnessDraft}
        onColorSet={handleBodyColor}
        onTransparencySet={handleBodyTransparency}
        onMetalnessSet={handleBodyMetalness}
        onCancel={handleColorCancel}
        onApply={(mutation) => {
          commitPreview(mutation)
          setPartColorPopover(null)
        }}
      />
      <PartExportImport
        exportDialogOpen={exportDialogOpen}
        exportDefaultName={exportDefaultName}
        handleExportDownload={handleExportDownload}
        handleExportCancel={handleExportCancel}
        shareDocOpen={shareDocOpen}
        setShareDocOpen={setShareDocOpen}
        uuid={uuid!}
        docName={docName}
        ownerUsername={ownerUsername}
        permission={permission}
      />
    </div>
  )
}
