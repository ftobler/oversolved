import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { ViewportHandle } from '@/components/Viewport'
import type { PartDoc, PartFeature, Mutation, Sketch } from '@/types/cad'
import { randomId } from '@/utils/yamlMutations'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { usePartDoc } from '@/hooks/usePartDoc'
import { useAuth } from '@/contexts/AuthContext'
import RightClickMenu from '@/components/dialogs/RightClickMenu'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { Sidebar } from '@/components/layout/Sidebar'
import FooterMeasurementDisplay from '@/components/layout/FooterMeasurementDisplay'
import { useSyncPartEditorStore } from '@/hooks/useSyncPartEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'

import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSolverStore } from '@/stores/solverStore'
import { useDevSettingsStore } from '@/stores/devSettingsStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { parseHttpError } from '@/utils/core/httpClient'
import { debugToolsUnrestricted } from '@/config/capabilities'
import '@/pages/Part.css'

import PartToolbar from '@/pages/PartToolbar'
import PartEditorPanel from '@/pages/PartEditorPanel'
import PartDebugPanel from '@/pages/PartDebugPanel'
import PartColorPopover from '@/pages/PartColorPopover'
import PartExportImport, { type PartExportImportHandle } from '@/pages/PartExportImport'
import { usePartCommands } from '@/pages/PartKeyboardShortcuts'
import type { ShowMessagePayload } from '@/pages/commandEntries'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { useEditFeature } from '@/pages/useEditFeature'

import measurementIcon from '@/assets/icons/measurement.svg'

import { buildContextMenu } from './buildContextMenu'
import type { BuildContextMenuInput, BuildContextMenuCallbacks, RenameTarget } from './buildContextMenu'
import RenameDialog from '@/components/dialogs/RenameDialog'
import { suggestedCloneName } from '@/stores/documentStore'

import { normalizeHexColor } from '@/utils/core/partColors'
import { computeEffectiveVisibleBodies } from '@/components/Viewport/bodyUtils'
import { builtinPlaneTransform, planeTransformNormal } from '@/components/Geometry3D/bodySnapProjection'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { BUILTIN_FEATURE_DEFAULTS } from '@/hooks/usePartDoc'
import { hasDanglingContentInDoc } from '@/utils/yamlMutations/solveResult'

const BUILT_IN_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

function setRollbackForNewFeature(features: PartFeature[]) {
  usePartEditorStore.getState().setRollbackPosition(features.length + 1)
}

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

// Re-derive the rollback store from a whole-document swap (load, and the code
// tab's Run/exit which replaces the doc from text). The swapped-in doc's parked
// `rollback` is authoritative; a position past the end of the feature list
// (features removed, or the old store value left over from the previous doc)
// falls back to the end.
function syncRollbackFromDoc(doc: PartDoc) {
  const count = extractFeatures(doc).length
  usePartEditorStore.getState().setRollbackPosition(Math.min(doc.rollback ?? count, count))
}

// yaml.parse only throws on malformed syntax. Well-formed text that is not a
// mapping comes back happily -- '' as null, '42' as a number, '- a' as an array
// -- and taking one of those as the document empties the feature list for good,
// because the code tab drops the undo history as it applies.
function parsePartDoc(text: string): { doc: PartDoc } | { error: string } {
  let parsed: unknown
  try {
    parsed = parseYaml(text)
  } catch (e) {
    return { error: `Parse error: ${e}` }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: 'Parse error: the document must be a YAML mapping' }
  }
  return { doc: parsed as PartDoc }
}

const FIRST_PICK_FIELD: Record<string, { field: string; multi?: boolean }> = {
  plane: { field: 'plane' },
  extrude: { field: 'sketch', multi: true },
  revolve: { field: 'sketch', multi: true },
  sweep: { field: 'sketch', multi: true },
  fillet: { field: 'edges', multi: true },
  chamfer: { field: 'edges', multi: true },
  hole: { field: 'sketch' },
  boolean: { field: 'target' },
  transform: { field: 'bodies', multi: true },
  mirror: { field: 'body' },
  delete_body: { field: 'bodies', multi: true },
  circular_array: { field: 'axis' },
}

export default function Part() {
  const { uuid } = useParams<{ uuid: string }>()
  const navigate = useNavigate()
  const [codeText, setCodeText] = useState('')
  // Whether the user has typed into the code textarea since the tab was opened.
  // The solver writes codeText back too, so the text alone cannot say whether it
  // carries user intent or is just a serialization of the current document.
  const codeTyped = useRef(false)
  const [mode, setModeRaw] = useState<'sketch' | 'feature' | 'code'>('sketch')
  // rollbackPosition is owned by partEditorStore (single source of truth).
  // Read here for memos / props; mutate via store setters.
  const rollbackPosition = usePartEditorStore(s => s.rollbackPosition)
  const rollbackInitialized = useRef(false)
  const viewportRef = useRef<ViewportHandle>(null)
  const exportImportRef = useRef<PartExportImportHandle>(null)
  const handleFirstSolve = useCallback(() => {
    // Re-arm auto-fit for this freshly loaded document. Fires via setTimeout(0)
    // after first solve; the editing / no-geometry-yet guards live in Viewport.
    viewportRef.current?.autoZoomToFit()  // camera-only; intentional no-op when Viewport absent
  }, [])
  const [contextMenu, setContextMenu] = useState<{ position: [number, number]; targetId?: string; items: ContextMenuItem[] } | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  // Non-null while the clone prompt is open; holds the name it was seeded with.
  const [cloneName, setCloneName] = useState<string | null>(null)
  const [partColorPopover, setPartColorPopover] = useState<{ bodyId: string; position: [number, number]; session: number } | null>(null)
  const colorPopoverSession = useRef(0)
  const { user } = useAuth()

  const [debugOpen, setDebugOpen] = useState(false)
  const [messageDialog, setMessageDialog] = useState<ShowMessagePayload | null>(null)
  const showMessage = useCallback((payload: ShowMessagePayload) => setMessageDialog(payload), [])
  const showDebugHit = useSketchEditorStore(s => s.showDebugHit)
  const setShowDebugHit = useSketchEditorStore(s => s.setShowDebugHit)

  const activePickField = useSketchEditorStore(s => s.activePickField)
  const setActivePickField = useSketchEditorStore(s => s.setActivePickField)
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
    solveError,
    setSolveError,
    solveResult,
    undoStack,
    redoStack,
    reSolve,
    validation,
    handleMutation,
    commitMutationGroup,
    beginBrepProjection,
    cancelBrepProjection,
    handleUndo,
    handleRedo,
    discardHistoryAndSessions,
    discardSessions,
    saveDoc,
    renameDoc,
    cloneDoc,
    docName,
    ownerUsername,
    bodies,
    pickBodies,
    pickStateReady,
    permission,
    isCloudDoc,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    registerUndoTeardown,
  } = usePartDoc(uuid, mode, setCodeText, { onFirstSolve: handleFirstSolve })

  const readOnly = permission === 'view'

  const features = useMemo(() => extractFeatures(doc), [doc])
  // The sketch-on-face FSM only cares about a sketch's plane field being picked.
  const planeSelectionFeatureId = activePickField?.field === 'plane'
    && features.find(f => f.id === activePickField.featureId)?.kind === 'sketch'
    ? activePickField.featureId
    : null
  const partStyle = useMemo(() => doc?.part_style ?? {}, [doc])
  const { partLabels, partColors } = useMemo(() => {
    const labels: Record<string, string> = {}
    const colors: Record<string, string> = {}
    for (const [bodyId, style] of Object.entries(partStyle)) {
      if (style.name?.trim()) labels[bodyId] = style.name.trim()
      const normalized = normalizeHexColor(style.color)
      if (normalized) colors[bodyId] = normalized
    }
    return { partLabels: labels, partColors: colors }
  }, [partStyle])


  useEffect(() => {
    if (doc && !rollbackInitialized.current) {
      rollbackInitialized.current = true
      // Reopen the document where the user parked the bar. A saved position past
      // the end (doc hand-edited, features removed) falls back to the end.
      syncRollbackFromDoc(doc)
    }
  }, [doc])

  useEffect(() => {
    // A parked rollback beyond the current feature list is stale (features were
    // deleted or the doc was swapped), so it falls back to the end. Guarded on
    // `doc`: on a keyed remount the first render has features=[] because the new
    // document has not loaded yet, and without the guard the closure's rollback
    // from the PREVIOUS document would clamp it to 0 here, silently skipping the
    // new document's first solve (reSolve then reads rollback 0 and solves
    // nothing).
    if (doc && rollbackPosition !== null && rollbackPosition > features.length) {
      usePartEditorStore.getState().setRollbackPosition(features.length)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features.length])

  // The parse and the doc swap deliberately sit OUTSIDE the setModeRaw updater:
  // React replays updaters under StrictMode, so a side effect in there runs
  // twice per switch.
  //
  // Returns false when the switch was REFUSED, which today happens only when the
  // code tab holds text that is not a document. Callers that arrange something
  // around the switch have to honour that; see enterEditSketch.
  const setMode = useCallback((newMode: 'sketch' | 'feature' | 'code'): boolean => {
    // Re-entering the tab you are already on must not re-serialize codeText,
    // which would throw away text the user typed but has not run yet.
    if (mode === newMode) return true
    // Only text the user actually typed is written back. codeText is otherwise
    // a stale serialization -- nothing refreshes it but a landing solve -- and
    // applying it would silently revert edits made in the feature tree, which
    // stays live while the code tab is open.
    let replacedDoc = false
    if (mode === 'code' && codeTyped.current) {
      const parsed = parsePartDoc(codeText)
      if ('error' in parsed) {
        // Leaving with unusable text used to drop it silently and switch anyway,
        // so the typed YAML was unrecoverable. Hold the user on the code tab
        // with their text intact and report it the way Run does.
        setSolveError(parsed.error)
        return false
      }
      const current = docRef.current
      // Typing something and typing it back is not an edit: an equal doc must
      // not cost the user their history or trigger a rebuild.
      if (current && JSON.stringify(parsed.doc) !== JSON.stringify(current)) {
        replacedDoc = true
        docRef.current = parsed.doc
        setDoc(parsed.doc)
        useUnsavedChangesStore.getState().setDirty(true)  // code tab edit replaces the doc
        discardHistoryAndSessions()
        // The swap re-pins the rollback store to the typed doc BEFORE the solve,
        // so this solve reads the doc's parked position, and the first tree
        // mutation cannot mirror the previous document's stale position over it.
        syncRollbackFromDoc(parsed.doc)
        reSolve(parsed.doc, { bypassCache: true })
      }
      codeTyped.current = false
    }
    if (newMode === 'code') {
      discardHistoryAndSessions()
      codeTyped.current = false
      if (docRef.current) setCodeText(stringifyYaml(docRef.current))
    } else if (mode === 'code' && !replacedDoc) {
      // Leaving the tab WITHOUT replacing the doc still has to abandon anything
      // the code mode could start: the tree stays live there, so a color preview
      // can be opened mid-tab, and its suppressUndoRef must not leak past the
      // switch to swallow the tree edits that follow. The stacks survive -- no
      // doc was replaced.
      discardSessions()
    }
    setModeRaw(newMode)
    return true
  }, [mode, codeText, docRef, setDoc, setCodeText, setSolveError, reSolve, discardHistoryAndSessions, discardSessions])

  // The tree stays live while the code tab is open, so a tree edit lands in
  // codeTyped's blind spot: handleMutation swaps the doc underneath the textarea
  // without ever touching codeText, leaving the flag claiming "user typed"
  // when the text no longer describes the document. Writing it back on exit
  // would then revert that tree edit and, with the history dropped, leave
  // nothing to recover. Same for a landing solve: it rewrites codeText from the
  // doc, so the typed text is gone regardless. Any doc change while in code
  // mode invalidates the marker.
  useEffect(() => {
    if (mode === 'code') codeTyped.current = false
  }, [doc, mode])

  const handleRebuild = useCallback(() => {
    if (docRef.current) reSolve(docRef.current)
    setContextMenu(null)
  }, [docRef, reSolve])

  // Whether the last solve flagged anything the cleanup command would remove.
  // Drives the context-menu item so an empty cleanup gesture is never offered.
  const hasDanglingContent = useMemo(() => {
    for (const data of Object.values(solveResults)) {
      if (data.projection_errors?.length) return true
      if (data.constraints && Object.values(data.constraints).some(c => c.superfluous)) return true
    }
    return false
  }, [solveResults])

  // The one write-back that is undoable by construction: it is a plain
  // handleMutation, so undo restores the removed entities and the re-solve does
  // not re-delete them (the generic solve path is pure). No-op when the last
  // solve flagged nothing, so it never pushes a dead undo entry.
  const handleRemoveDanglingContent = useCallback(() => {
    if (!docRef.current) return
    const perFeature: Record<string, { entities: string[]; constraints: string[] }> = {}
    for (const [featureId, data] of Object.entries(solveResults)) {
      const entities = data.projection_errors ?? []
      const constraints = Object.entries(data.constraints ?? {})
        .filter(([, c]) => c.superfluous)
        .map(([cid]) => cid)
      if (entities.length > 0 || constraints.length > 0) {
        perFeature[featureId] = { entities, constraints }
      }
    }
    if (Object.keys(perFeature).length === 0) return
    // The plan derives from the last solve; the doc may have changed since.
    // Skip the mutation (and its undo entry) when nothing it targets exists.
    if (!hasDanglingContentInDoc(docRef.current, perFeature)) return
    handleMutation({ type: 'remove_dangling_content', features: perFeature })
    setContextMenu(null)
  }, [docRef, solveResults, handleMutation])

  const [isRebuilding, setIsRebuilding] = useState(false)

  const handleClearCacheAndRebuild = useCallback(async () => {
    if (!uuid || !docRef.current) return
    setIsRebuilding(true)
    try {
      // Re-solve always flushes the incremental cache (bypassCache) so every
      // feature rebuilds from scratch, with no stale handles from prior solves.
      // Validation (a second, full, cache-less rebuild to diff incremental-vs-full
      // for the badge) doubles the solve, so it is opt-in via the dev-settings flag.
      const validate = useDevSettingsStore.getState().validateOnRebuild
      await reSolve(docRef.current, { bypassCache: true, validate })
    } catch (e) {
      console.error('Rebuild failed:', e)
    } finally {
      setIsRebuilding(false)
    }
  }, [uuid, reSolve, docRef])

  const pendingSketchOnFaceId = useRef<string | null>(null)
  const pendingEditSketchId = useRef<string | null>(null)
  const clearPlaneSelection = useCallback(() => {
    setActivePickField(null)
    pendingSketchOnFaceId.current = null
  }, [setActivePickField])

  const {
    editingFeatureId,
    editForcedVisible,
    resetEditState,
    enterEditFeature,
    commitEditFeature,
    cancelEditFeature,
    exitEditFeature,
    enterEditSketch,
    exitEditSketch,
  } = useEditFeature({
    features,
    builtInIds: BUILT_IN_IDS,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    docRef,
    reSolve,
    setMode,
    clearPlaneSelection,
  })

  // Undo/redo hand the app a document no open session knows anything about, so
  // every piece of transient editor state is dropped before the doc swaps. This
  // is composed here rather than in usePartDoc because half of it (forced
  // visibility, the panel mode, the color popover) only exists on this page.
  const tearDownEditorState = useCallback(() => {
    const editing = usePartEditorStore.getState().editingFeatureId
    const wasSketchEdit = features.some(f => f.id === editing && f.kind === 'sketch')
    resetEditState()
    const sketchStore = useSketchEditorStore.getState()
    // Unconditional on purpose, even for an undo that could not have invalidated
    // anything. Deciding per entry would mean re-resolving every selected query
    // against the restored doc on every undo, and a selection that survives one
    // undo but silently dies on the next is worse than one that always clears.
    sketchStore.clearNormalSelection()
    sketchStore.setActivePickField(null)  // also pops the matching 'pick' mode entry
    sketchStore.closeDialog()
    sketchStore.closeContextMenu()
    // An undone doc has no place for a pending dimension gesture's projections;
    // drop the bookkeeping without a compensating delete (the doc is already
    // being replaced by the undo's own restore).
    sketchStore.clearBrepProjectionState()
    setContextMenu(null)
    // The color preview is discarded rather than applied: undo brings its own
    // doc, and a popover left open would only be able to commit or revert
    // against a world that no longer exists.
    setPartColorPopover(null)
    // The sketch toolbar has nothing left to act on once the sketch edit is gone.
    if (wasSketchEdit) setModeRaw('feature')
  }, [features, resetEditState])

  useEffect(() => {
    registerUndoTeardown(tearDownEditorState)
    return () => registerUndoTeardown(null)
  }, [registerUndoTeardown, tearDownEditorState])

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

  // Ghost preview waits for the solve that carries the pick bodies: until it
  // lands there is no "before" state to draw the ghosts from, and the overlay
  // would flash the whole model as new (violet) geometry.
  const ghostMode = useMemo(() => {
    if (!editingFeatureId || !pickStateReady) return false
    const feature = features.find(f => f.id === editingFeatureId)
    return !!feature && feature.kind !== 'sketch' && feature.kind !== 'plane'
  }, [features, editingFeatureId, pickStateReady])

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
    exitEditSketch()
    setContextMenu(null)
  }, [exitEditSketch])

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
    // One Delete action on N features is one undo step, not N.
    if (featureIds.length > 0) {
      commitMutationGroup(featureIds.map(featureId => ({ type: 'delete_feature', featureId })))
      useSketchEditorStore.getState().clearNormalSelection()
    }
  }, [commitMutationGroup])

  const handleAddFeature = useCallback((kind: string, extra?: Record<string, unknown>) => {
    if (!doc) return
    const fid = randomId(18)
    const label = `${kind} ${Object.keys(bodies).length + 1}`
    const store = usePartEditorStore.getState()
    // Extend rollback so the mutation-triggered reSolve includes the new
    // feature, and pre-stage pick_boundary as if the new feature were the
    // edit target. The new feature will land at non-builtin index
    // = current non-builtin count, so the solve is cached under that key.
    // When the user later clicks Edit on the new feature, enterEditFeature
    // recomputes the same pick_boundary and the cache hit is free.
    setRollbackForNewFeature(features)
    store.setPickBoundary(features.filter(f => !BUILT_IN_IDS.has(f.id)).length)
    handleMutation({ type: `add_${kind}`, featureId: fid, label, ...extra } as Mutation)
    // enterEditFeature would bail because React hasn't re-rendered with the
    // new feature yet (features.findIndex(f => f.id === fid) returns -1).
    // Enter edit mode eagerly without starting a session; commit/cancel
    // handle the no-session case gracefully.
    store.setEditingFeatureId(fid)
    const firstPick = FIRST_PICK_FIELD[kind]
    if (firstPick) setActivePickField({ featureId: fid, ...firstPick })
  }, [doc, features, handleMutation, bodies, setActivePickField])

  const handleAddPlane = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const label = `plane ${planeCount + 1}`
    const faceQuery = [...selection].find(id => id.startsWith('?') && id.includes(':face'))
    const definition = faceQuery ? { mode: 'on_face', face: faceQuery } as const : undefined
    setRollbackForNewFeature(features)
    handleMutation({ type: 'add_plane', featureId, label, definition })
    usePartEditorStore.getState().setEditingFeatureId(featureId)
    const firstPick = FIRST_PICK_FIELD['plane']
    if (firstPick) setActivePickField({ featureId, ...firstPick })
  }, [doc, features, handleMutation, selection, setActivePickField])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setRollbackForNewFeature(features)
    handleMutation({ type: 'add_sketch', featureId, label })
    setActivePickField({ featureId, field: 'plane' })
  }, [doc, features, handleMutation, setActivePickField])

  const handleNewSketchOnPlane = useCallback((plane: string) => {
    if (!doc) return
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setRollbackForNewFeature(features)
    handleMutation({ type: 'add_sketch', featureId, label, plane })
    // enterEditSketch resolves the feature out of `features`, which React has
    // not re-rendered with the new sketch yet. Defer to the effect below.
    pendingEditSketchId.current = featureId
  }, [doc, features, handleMutation])

  const handleImportStep = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.step,.stp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      // Read the STEP bytes in-browser and inline them as base64 file_data; the
      // WASM kernel (occ/stepIo) parses them directly, so import needs no server
      // round-trip and works identically offline.
      let fileData: string
      try {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader()
          reader.onload = () => resolve(reader.result as string)
          reader.onerror = () => reject(reader.error ?? new Error('file read failed'))
          reader.readAsDataURL(file)
        })
        fileData = dataUrl.split(',')[1] ?? ''
      } catch {
        setError('Failed to read STEP file')
        return
      }
      if (!fileData) {
        setError('STEP file is empty')
        return
      }
      const featureId = randomId(18)
      const label = file.name.replace(/\.(step|stp)$/i, '')
      setRollbackForNewFeature(features)
      handleMutation({ type: 'add_import_step', featureId, fileData, label })
    }
    input.click()
  }, [handleMutation, features, setError])

  const handleExportStep = useCallback(() => {
    exportImportRef.current?.openExport(null, docName || 'export')
  }, [docName])

  const handleToggleSketchPlaneVisibility = useCallback(() => {
    handleMutation({ type: 'toggle_sketch_plane_visibility' })
  }, [handleMutation])

  const handleTogglePlaneVisibility = useCallback(() => {
    handleMutation({ type: 'toggle_plane_visibility' })
  }, [handleMutation])

  useEffect(() => {
    setSketchCallback('onMutation', handleMutation)
    setSketchCallback('onMutationBatch', commitMutationGroup)
    setSketchCallback('beginBrepProjection', beginBrepProjection)
    setSketchCallback('cancelBrepProjection', cancelBrepProjection)
    setSketchCallback('onRebuild', handleRebuild)
    setSketchCallback('onExitSketch', handleExitSketch)
    // Used by finalizeDimensionPlacement to pre-fill the value-edit dialog
    // with the current natural measurement.
    setSketchCallback('getSketch', (featureId: string) => {
      return solveResults?.[featureId]?.solved ?? null
    })
    return () => {
      setSketchCallback('onMutation', null)
      setSketchCallback('onMutationBatch', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      setSketchCallback('onRebuild', null)
      setSketchCallback('onExitSketch', null)
      setSketchCallback('getSketch', null)
    }
  }, [handleMutation, commitMutationGroup, beginBrepProjection, cancelBrepProjection, handleRebuild, handleExitSketch, solveResults])

  // The sketch editor store is module-level and survives a Part unmount, so a
  // remounted Part (DocumentPage keys it by document) would otherwise inherit the
  // previous document's picks, drags and modes. A stale pick field alone can
  // re-enter edit mode off the next document (the planeSelectionFeatureId
  // effect), and a stale dimension gesture trips validateWithRepair on B's first
  // pick, so the whole transient set is reset here. This is a separate
  // unmount-only effect, not part of the callback effect above: that one re-runs
  // on every solve (solveResults is a dep), and resetting the store there would
  // wipe the user's session mid-edit. resetTransientState uses a plain set, not
  // the validation-running actions, because it tears down a half-open state that
  // would itself failLoud under validation.
  useEffect(() => {
    return () => {
      useSketchEditorStore.getState().resetTransientState()
    }
  }, [])

  useEffect(() => {
    useSketchEditorStore.getState().setActiveFeatureId(activeSketchFeatureId ?? null)
  }, [activeSketchFeatureId])

  useEffect(() => {
    useSolverStore.getState().setIsSolving(solving)
  }, [solving])

  useUnsavedChangesGuard()

  // Undo/redo must never move the camera. Disarm any pending (deferred) fit
  // first so the doc/body change they trigger cannot reframe the viewport.
  const handleUndoNoFit = useCallback(() => {
    viewportRef.current?.cancelPendingFit()  // camera-only; intentional no-op when Viewport absent
    handleUndo()
  }, [handleUndo])
  const handleRedoNoFit = useCallback(() => {
    viewportRef.current?.cancelPendingFit()  // camera-only; intentional no-op when Viewport absent
    handleRedo()
  }, [handleRedo])

  usePartCommands(
    handleUndoNoFit,
    handleRedoNoFit,
    handleDeleteSelectedFeatures,
    handleToggleSketchPlaneVisibility,
    handleTogglePlaneVisibility,
    handleAddFeature,
    showMessage,
  )

  const handleSave = async () => {
    if (!uuid || !doc) return
    const success = await saveDoc(uuid, doc, viewportRef.current?.captureScreenshotForSaving)  // screenshot is optional; save proceeds without Viewport
    if (success) setError(null)
  }

  const handleClone = () => {
    if (!uuid) return
    setCloneName(suggestedCloneName(docName))
  }

  const handleCloneConfirm = async (name: string) => {
    if (!uuid) return
    setCloneName(null)
    try {
      const data = await cloneDoc(uuid, name)
      navigate(`/documents/${data.uuid}`)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to clone document'))
    }
  }

  // Typing in the code tab IS the edit. Flagging it here rather than on the way
  // out of the tab is what makes a save or a navigation taken WHILE the tab is
  // open safe: saveDoc serializes the document, never this text, so text that
  // was never applied would otherwise be dropped with no warning.
  const handleCodeTextChange = useCallback((text: string) => {
    codeTyped.current = true
    setCodeText(text)
    useUnsavedChangesStore.getState().setDirty(true)
  }, [])

  const handleRun = () => {
    // Run applies what the user typed. Untyped text is a serialization of the
    // document -- possibly stale after a live tree edit -- so there is nothing
    // to apply: running it would revert that edit and, with the history wiped,
    // leave nothing to recover. Same gate the exit path uses.
    if (!codeTyped.current) {
      setSolveError(null)
      return
    }
    const parsed = parsePartDoc(codeText)
    if ('error' in parsed) {
      setSolveError(parsed.error)
      return
    }
    setSolveError(null)  // a successful parse retires the previous error banner
    const current = docRef.current
    // Running the doc back onto itself is a no-op: marking it dirty and
    // dropping the history for nothing would wipe the tree edits the user
    // actually made while the tab was open.
    if (current && JSON.stringify(parsed.doc) !== JSON.stringify(current)) {
      docRef.current = parsed.doc
      setDoc(parsed.doc)
      useUnsavedChangesStore.getState().setDirty(true)  // code tab edit replaces the doc
      // A Run is a whole-document replacement with no undo entry behind it, so
      // any history left from the feature tree would rewind past it.
      discardHistoryAndSessions()
      // Same re-pin as the exit swap: the Run's own solve reads the typed doc's
      // parked position, and the next tree mutation keeps it (mirrors position
      // 2 from `rollback: 2`, never the old document's stale bar).
      syncRollbackFromDoc(parsed.doc)
      reSolve(parsed.doc, { bypassCache: true })
    }
    // The text now says exactly what the document says, so leaving the tab has
    // nothing left to write back.
    codeTyped.current = false
  }

  // User-initiated rollback drag: update the store, then persist the position
  // into the document. handleMutation writes doc.rollback from the store, marks
  // the doc dirty, and re-solves, so the bar survives a save/reload round trip.
  const handleUserRollbackChange = useCallback((pos: number | null) => {
    const store = usePartEditorStore.getState()
    store.setRollbackPosition(pos)
    if (store.editingFeatureId && doc) {
      // An edit is active; keep pickBoundary in sync so the invariant
      // in reSolve (assertEditingInvariant) doesn't fire.
      const fts = extractFeatures(doc)
      const nonBuiltIns = fts.filter(f => !BUILT_IN_IDS.has(f.id))
      const idx = nonBuiltIns.findIndex(f => f.id === store.editingFeatureId)
      store.setPickBoundary(idx >= 0 ? idx : null)
    } else {
      store.setPickBoundary(null)
    }
    handleMutation({ type: 'set_rollback', position: pos })
  }, [handleMutation, doc])

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

  // The context menu only names what is being renamed; the dialog collects the
  // label and routes it back to the kind's own mutation.
  const handleRenameConfirm = useCallback((name: string) => {
    if (!renameTarget) return
    if (renameTarget.kind === 'body') handleBodyRename(renameTarget.id, name)
    else handleFeatureRename(renameTarget.id, name)
    setRenameTarget(null)
  }, [renameTarget, handleBodyRename, handleFeatureRename])

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

  const handleBodyColor = useCallback((bodyId: string, color: string) => {
    const normalized = normalizeHexColor(color)
    if (!normalized) return
    handleMutation({ type: 'set_part_color', bodyId, color: normalized })
  }, [handleMutation])

  const handleBodyTransparency = useCallback((bodyId: string, transparency: number) => {
    handleMutation({ type: 'set_part_transparency', bodyId, transparency: clamp01(transparency) })
  }, [handleMutation])

  const handleBodyMetalness = useCallback((bodyId: string, metalness: number) => {
    handleMutation({ type: 'set_part_metalness', bodyId, metalness: clamp01(metalness) })
  }, [handleMutation])

  const handleBodyRoughness = useCallback((bodyId: string, roughness: number) => {
    handleMutation({ type: 'set_part_roughness', bodyId, roughness: clamp01(roughness) })
  }, [handleMutation])

  const handleBodyTransmission = useCallback((bodyId: string, transmission: number) => {
    handleMutation({ type: 'set_part_transmission', bodyId, transmission: clamp01(transmission) })
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

    const planeId = activeSketch.plane
    if (!planeId) return
    const cleanPlaneId = planeId.replace(/^@/, '')

    viewportRef.current?.alignCameraToPlane(cleanPlaneId)  // camera-only; intentional no-op when Viewport absent
  }, [activeSketchFeatureId, features])

  // Built-in planes never reach the kernel, so only user-defined ones carry a
  // solved plane_transform; the built-ins are derived locally from their query.
  const handleNormalToPlane = useCallback((planeFeatureId: string) => {
    const transform = BUILT_IN_IDS.has(planeFeatureId)
      ? builtinPlaneTransform(builtinSelectionId(planeFeatureId))
      : solveResults?.[planeFeatureId]?.plane_transform
    if (!transform) return
    const [ox, oy, oz] = transform.origin
    viewportRef.current?.alignCameraToFace(planeTransformNormal(transform), [ox, oy, oz])
  }, [solveResults])

  useEffect(() => {
    if (planeSelectionFeatureId) {
      pendingSketchOnFaceId.current = planeSelectionFeatureId
      // Enter edit mode as soon as the sketch appears in the feature list so
      // the PlaneSelector pick-chip is visible and active immediately.
      if (editingFeatureId !== planeSelectionFeatureId) {
        const feature = features.find(f => f.id === planeSelectionFeatureId)
        if (feature?.kind === 'sketch') {
          // A plane pick for a fresh sketch can fire while another feature's
          // session is still open (e.g. picking a plane for a new sketch while
          // an extrude edit is mid-gesture). enterEditSketch -> enterEditFeature
          // closes that other session itself before opening this one (the
          // one-open-editor guard in useEditFeature.ts), so no manual
          // close-then-open juggling is needed here. A sketch entered via
          // plane-on-face goes through enterEditSketch (per-action undo), not
          // enterEditFeature directly (which would suppress every draw into
          // one aggregate step).
          enterEditSketch(planeSelectionFeatureId)
        }
      }
    } else if (pendingSketchOnFaceId.current) {
      const fid = pendingSketchOnFaceId.current
      pendingSketchOnFaceId.current = null
      const feature = features.find(f => f.id === fid)
      if (feature?.kind === 'sketch') {
        if (feature.plane) {
          setMode('sketch')
        } else if (editingFeatureId === fid) {
          // The pick was abandoned (Escape/cancel_draw, or the chip toggled
          // off) before a plane landed. Nothing else resolves this session,
          // so close it here rather than stranding editingFeatureId with only
          // the feature tree's own OK/Cancel left to escape it.
          cancelEditFeature()
        }
      }
    }
  }, [planeSelectionFeatureId, editingFeatureId, features, enterEditSketch, cancelEditFeature, setMode])

  // A sketch created with its plane already bound needs no pick step, so it
  // drops straight into sketch edit once the new feature reaches `features`.
  useEffect(() => {
    const featureId = pendingEditSketchId.current
    if (!featureId) return
    if (!features.some(f => f.id === featureId)) return
    pendingEditSketchId.current = null
    enterEditSketch(featureId)
  }, [features, enterEditSketch])

  const handleRightClick = useCallback((pos: [number, number], targetId?: string) => {
    const store = useSketchEditorStore.getState()
    const input: BuildContextMenuInput = {
      pos,
      targetId,
      hoveredSelectionId: store.hoveredSelectionId,
      hoveredFaceNormal: store.hoveredFaceNormal,
      hoveredFaceCenter: store.hoveredFaceCenter,
      features,
      visibleFeatures: visibleFeaturesWithEdit,
      activeSketchFeatureId: activeSketchFeatureId ?? undefined,
      showConstraintTiles: useSketchEditorStore.getState().showConstraintTiles,
      partLabels,
      builtInIds: BUILT_IN_IDS,
      hasDanglingContent,
    }
    const callbacks: BuildContextMenuCallbacks = {
      onRebuild: handleRebuild,
      onRemoveDanglingContent: handleRemoveDanglingContent,
      onToggleVisibility: toggleVisibility,
      onToggleSuppression: toggleSuppression,
      onEnterEditSketch: enterEditSketch,
      onExitSketch: handleExitSketch,
      onDeleteFeature: handleDeleteFeature,
      onRequestRename: setRenameTarget,
      onAlignToFace: (normal, center) => viewportRef.current?.alignCameraToFace(normal, center),
      onNormalToPlane: handleNormalToPlane,
      onAlignCameraToSketchPlane: handleAlignCameraToSketchPlane,
      onToggleConstraintTiles: () => {
        const s = useSketchEditorStore.getState()
        s.setShowConstraintTiles(!s.showConstraintTiles)
      },
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
      onNewSketchOnPlane: handleNewSketchOnPlane,
      onShowContextMenu: (items, tid) => setContextMenu({ position: pos, targetId: tid, items }),
    }
    const { items } = buildContextMenu(input, callbacks)
    setContextMenu({ position: pos, targetId, items })
  }, [handleRebuild, handleRemoveDanglingContent, toggleVisibility, toggleSuppression, enterEditSketch, handleExitSketch, handleDeleteFeature,
    handleAlignCameraToSketchPlane, handleNormalToPlane, handleNewSketchOnPlane,
    features, visibleFeaturesWithEdit, activeSketchFeatureId, partLabels, hasDanglingContent,
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
    onMutation: handleMutation,
    onSetRollbackPosition: handleUserRollbackChange,
    onRebuild: handleClearCacheAndRebuild,
  }), [toggleNormalSelection, enterEditSketch, exitEditSketch, handleAlignCameraToSketchPlane,
    enterEditFeature, exitEditFeature, commitEditFeature, cancelEditFeature,
    toggleVisibility, handleRightClick, handleFeatureRename,
    handleMutation, handleUserRollbackChange,
    handleClearCacheAndRebuild])

  return (
    <div className="document-viewer">
      <PartToolbar
        readOnly={readOnly}
        permission={permission}
        docName={docName}
        isCloudDoc={isCloudDoc}
        onRename={(name) => renameDoc(uuid!, name)}
        handleSave={handleSave}
        handleClone={handleClone}
        onShare={() => exportImportRef.current?.openShare()}
      />

      <PartEditorPanel
        mode={mode}
        setMode={setMode}
        codeText={codeText}
        setCodeText={handleCodeTextChange}
        solving={solving}
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
        viewportRef={viewportRef}
        handleRightClick={handleRightClick}
        rightPanel={
          <PartDebugPanel
            debugOpen={debugOpen && (debugToolsUnrestricted || !!user?.is_admin)}
          />
        }
      >
        <PartEditorProvider value={partEditorCallbacks}>
          <Sidebar />
        </PartEditorProvider>
      </PartEditorPanel>

      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
        <FooterMeasurementDisplay sketch={measurementSketch} measurementIcon={measurementIcon} solveResults={solveResults} bodies={bodies} />
        <div className="debug-buttons">
          {(debugToolsUnrestricted || user?.is_admin) && (
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
      <RenameDialog
        isOpen={renameTarget !== null}
        title={renameTarget?.kind === 'body' ? 'Rename Body' : 'Rename Feature'}
        currentName={renameTarget?.currentName ?? ''}
        onRename={handleRenameConfirm}
        onCancel={() => setRenameTarget(null)}
      />
      <RenameDialog
        isOpen={cloneName !== null}
        title="Clone Document"
        label="New name"
        icon="content_copy"
        confirmLabel="Clone"
        currentName={cloneName ?? ''}
        onRename={handleCloneConfirm}
        onCancel={() => setCloneName(null)}
      />
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
      <MessageDialog
        isOpen={messageDialog !== null}
        title={messageDialog?.title ?? ''}
        message={messageDialog?.message ?? ''}
        variant={messageDialog?.variant ?? 'info'}
        onClose={() => setMessageDialog(null)}
      />
    </div>
  )
}
