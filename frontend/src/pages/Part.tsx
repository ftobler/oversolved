import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { ViewportHandle } from '@/components/Viewport'
import type { PartDoc, PartFeature, Mutation, Sketch } from '@/types/cad'
import { randomId } from '@/utils/yamlMutations'
import { isWholeBodySelectionId, parseTopoFallbackQuery, stripSelectionWrapper } from '@/utils/query/selectionId'
import { stripRefSigil } from '@/utils/refSigil'
import { parseQuery } from '@/utils/query'
import { isFaceRestriction } from '@/kernel/occ/primitives'
import { visibleFeatureIds } from '@/utils/featureVisibility'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import { usePartDoc } from '@/hooks/usePartDoc'
import { capturePreview } from '@/stores/previewStore/capture'
import RightClickMenu from '@/components/dialogs/RightClickMenu'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { Sidebar } from '@/components/layout/Sidebar'
import MeasurementDisplay from '@/components/layout/MeasurementDisplay'
import { useSyncPartEditorStore } from '@/hooks/useSyncPartEditorStore'
import { PartEditorProvider } from '@/contexts/PartEditorContext'

import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSolverStore } from '@/stores/solverStore'
import { useDevSettingsStore } from '@/stores/devSettingsStore'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { confirmDiscardUnsavedChanges } from '@/stores/unsavedChangesStore'
import { errorMessage } from '@/utils/core/errorMessage'
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
import { resolveSelectionNormalTarget } from './selectionNormalTarget'
import { findFaceFrame } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import RenameDialog from '@/components/dialogs/RenameDialog'
import { suggestedCloneName, stepImportLimitError } from '@/stores/documentStore'
import { getFileRegistry } from '@/stores/fileRegistry'

import { normalizeHexColor } from '@/utils/core/partColors'
import { computeEffectiveVisibleBodies } from '@/components/Viewport/bodyUtils'
import { builtinPlaneTransform, planeTransformNormal } from '@/components/Geometry3D/bodySnapProjection'
import { builtinSelectionId } from '@/components/Geometry3D/utils'
import { BUILTIN_FEATURE_DEFAULTS } from '@/hooks/usePartDoc'
import { hasDanglingContentInDoc } from '@/utils/yamlMutations/solveResult'

const BUILT_IN_IDS = new Set(BUILTIN_FEATURE_DEFAULTS.map(f => f.id))

type PartColorPopoverState = { bodyId: string; position: [number, number]; session: number } | null

function setRollbackForNewFeature(features: PartFeature[]) {
  usePartEditorStore.getState().setRollbackPosition(features.length + 1)
}

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

// Re-derive the rollback store from a whole-document swap (the load seam). The
// swapped-in doc's parked `rollback` is authoritative; a position past the end
// of the feature list (features removed, or the old store value left over from
// the previous doc) falls back to the end.
function syncRollbackFromDoc(doc: PartDoc) {
  const count = extractFeatures(doc).length
  usePartEditorStore.getState().setRollbackPosition(Math.min(doc.rollback ?? count, count))
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
  // The workspace route spells the entry `:entryId`; the older `/documents/:uuid`
  // route the Part suites still mount keeps `uuid`. Both name the same thing, so
  // one local id keeps every existing call site reading the resolved entry.
  const params = useParams<{ entryId?: string; uuid?: string; workspaceId?: string }>()
  const uuid = params.entryId ?? params.uuid
  const workspaceId = params.workspaceId
  const navigate = useNavigate()
  const [mode, setMode] = useState<'sketch' | 'feature'>('sketch')
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
    // Thumbnail the solved scene. Saving was the only writer of a preview, so a
    // document opened and never saved had none and its row painted a
    // placeholder; the first solve is the earliest moment there is geometry to
    // photograph. Best-effort and fire-and-forget: the key is the save path's,
    // and a failed capture never reaches the editor.
    //
    // KNOWN LIMIT: the tick does NOT guarantee the fit above has landed.
    // autoZoomToFit only arms fitPendingRef; tryFit bails while the binary
    // geometry is still arriving and retries on its own [bodies, sceneTick]
    // effect, so this often photographs the default camera and the row gets a
    // correct but badly framed thumbnail. The fix is to capture off a
    // fit-settled signal from the Viewport rather than a fixed delay.
    if (!uuid) return
    setTimeout(() => {
      void capturePreview(viewportRef.current?.captureScreenshotForSaving, workspaceId, uuid)
    }, 0)
  }, [uuid, workspaceId])
  const [contextMenu, setContextMenu] = useState<{ position: [number, number]; targetId?: string; items: ContextMenuItem[] } | null>(null)
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null)
  // Non-null while the clone prompt is open; holds the name it was seeded with.
  const [cloneName, setCloneName] = useState<string | null>(null)
  const [partColorPopover, setPartColorPopoverState] = useState<PartColorPopoverState>(null)
  // Mirrors the popover state for the handlers that may be called from a stale
  // closure. The context menu keeps its items in state, so an item built one
  // render ago still holds that render's callbacks; a guard reading the
  // captured `partColorPopover` would see a popover that has since opened as
  // still closed and skip resolving its preview.
  const partColorPopoverRef = useRef<PartColorPopoverState>(null)
  const setPartColorPopover = useCallback((next: PartColorPopoverState) => {
    partColorPopoverRef.current = next
    setPartColorPopoverState(next)
  }, [])
  const colorPopoverSession = useRef(0)

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
    saveDoc,
    renameDoc,
    cloneDoc,
    docName,
    bodies,
    pickBodies,
    pickStateReady,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    registerUndoTeardown,
  } = usePartDoc(uuid, { onFirstSolve: handleFirstSolve, workspace: workspaceId })

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effect must run only when the feature count changes, not on every features identity
  }, [features.length])

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
    //
    // Delegated to the store's canonical wipe instead of hand-listing actions
    // here, so this list cannot drift from resetTransientState the way
    // applyUndoRedo's hand-listed reset once did. It covers selection (with the
    // pick field's 'pick' mode entry), dialogs, context menu, drag/pointer
    // state, projection bookkeeping AND the hover residue none of the
    // individual actions touched -- without which a stale hoveredFaceNormal
    // could still feed buildContextMenu's "Normal to" item after its face is
    // gone. The drag half is load-bearing on its own: because the wipe also
    // nulls activeFeatureId, the later setActiveFeatureId(null) effect no
    // longer transitions and this is the only place drag state gets cleared
    // on this path. A mid-drag undo exits the edit that owns the gesture,
    // unmounting DragPlane/FeatureHandles and dropping their window pointerup
    // listener -- so without the wipe the residue either commits onto the
    // restored doc's stale ids or gets stuck non-null forever. Mirrors the
    // assembly editor's identical mid-drag-undo guard.
    //
    // clearBrepProjectionState stays explicit ahead of the reset: unlike the
    // plain wipe it fires the R3F-side gesture-abort callback, and an undone
    // doc has no place for a pending dimension gesture's projections anyway --
    // dropped without a compensating delete, the doc being already replaced by
    // the undo's own restore.
    sketchStore.clearBrepProjectionState()
    sketchStore.resetTransientState()
    setContextMenu(null)
    // The color preview is discarded rather than applied: undo brings its own
    // doc, and a popover left open would only be able to commit or revert
    // against a world that no longer exists.
    setPartColorPopover(null)
    // The sketch toolbar has nothing left to act on once the sketch edit is gone.
    if (wasSketchEdit) setMode('feature')
  }, [features, resetEditState, setPartColorPopover])

  useEffect(() => {
    registerUndoTeardown(tearDownEditorState)
    return () => registerUndoTeardown(null)
  }, [registerUndoTeardown, tearDownEditorState])

  // The whole rule (consumed sketches hidden, the open editor's own geometry
  // forced back on screen) lives in visibleFeatureIds so it is tested without
  // the page or the viewport.
  const visibleFeaturesWithEdit = useMemo(
    () => visibleFeatureIds(features, { editingFeatureId, forcedVisible: editForcedVisible }),
    [features, editForcedVisible, editingFeatureId]
  )

  const effectiveVisibleBodies = useMemo(
    () => computeEffectiveVisibleBodies(bodies, partStyle),
    [bodies, partStyle],
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
  // would flash the whole model as new (pink) geometry.
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
    const bodyIds = new Set(Object.keys(bodies))
    const bodyDeletes: Mutation[] = []
    const featureDeletes: Mutation[] = []
    // First pass names the feature ids this Delete actually removes, so the body
    // pass can tell whether a body's generator is going away with it.
    const deletingFeatures = new Set<string>()
    for (const id of [...sel]) {
      if (!id.startsWith('@') || id.startsWith('@builtin_')) continue
      const ref = id.slice(1)
      if (features.some(f => f.id === ref)) deletingFeatures.add(ref)
    }
    for (const id of [...sel]) {
      if (!id.startsWith('@') || id.startsWith('@builtin_')) continue
      const ref = id.slice(1)
      // A whole-body pick (parts list or pick chip) inserts a real delete_body
      // feature through the same machinery the doomed-wireframe preview rides
      // on, instead of a `delete_feature` aimed at a body id that names no
      // feature. Face/edge/vertex picks are body primitives, not the body.
      if (bodyIds.has(ref) || isWholeBodySelectionId(id)) {
        // The feature that GENERATES the body is deleted in the same selection:
        // the body vanishes with it, and a delete_body would then target a body
        // the final doc no longer contains, failing every later solve.
        const creator = bodies[ref]?.created_by
        if (creator && deletingFeatures.has(creator)) continue
        bodyDeletes.push({ type: 'add_delete_body', featureId: randomId(18), bodies: [id], label: 'Delete Body' })
        continue
      }
      if (features.some(f => f.id === ref)) {
        featureDeletes.push({ type: 'delete_feature', featureId: ref })
      }
    }
    // One Delete action on N targets is one undo step, not N. commitMutationGroup
    // applies every handler to one doc clone and solves once at the end, so the
    // array order below only groups the mutations, it does not sequence them.
    const mutations = [...bodyDeletes, ...featureDeletes]
    if (mutations.length > 0) {
      commitMutationGroup(mutations)
      useSketchEditorStore.getState().clearNormalSelection()
    }
  }, [commitMutationGroup, bodies, features])

  // Adding a feature while another feature's editor is open must close that
  // editor first (the one-open-editor discipline enterEditFeature enforces).
  // Otherwise the new add is swallowed into the open session and Cancel or an
  // undo rolls both features back together. Deliberately no re-solve here: the
  // add's own funnel issues the single solve, and resetEditState only drops the
  // transient UI. commitEditSession runs before resetEditState because its
  // aggregate label names the store's editingFeatureId, which the reset clears.
  const closeOpenEditorForAdd = useCallback(() => {
    if (usePartEditorStore.getState().editingFeatureId === null) return
    commitEditSession()
    resetEditState()
  }, [commitEditSession, resetEditState])

  const handleAddFeature = useCallback((kind: string, extra?: Record<string, unknown>) => {
    if (!doc) return
    closeOpenEditorForAdd()
    const fid = randomId(18)
    const label = `${kind} ${Object.keys(bodies).length + 1}`
    const store = usePartEditorStore.getState()
    // Start the edit session against the PRE-add doc and let it suppress the
    // add: OK then folds the add and any in-session field edits into one
    // aggregate step, and Cancel rewinds the add away. Starting the session
    // after the dispatch would pin the post-add doc, so Cancel would leave the
    // new feature standing.
    startEditSession(true)
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
    // new feature yet (features.findIndex(f => f.id === fid) returns -1), so
    // the id is set eagerly; the session started above already owns commit and
    // cancel, so unlike the old no-session path Cancel now removes the add.
    store.setEditingFeatureId(fid)
    const firstPick = FIRST_PICK_FIELD[kind]
    if (firstPick) setActivePickField({ featureId: fid, ...firstPick })
  }, [doc, features, handleMutation, bodies, setActivePickField, startEditSession, closeOpenEditorForAdd])

  const handleAddPlane = useCallback(() => {
    if (!doc) return
    closeOpenEditorForAdd()
    const featureId = randomId(18)
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const label = `plane ${planeCount + 1}`
    const faceQuery = [...selection].find(id => {
      // `?`-ancestry face queries carry the OCC surface type as the type
      // restriction (flatface/cylinderface/face, classified by the shared
      // kernel classifier); `face:` wrappers (owner attribution; stored as
      // their inner query) and topo-fallback `@<bodyId>/face/<idx>` refs also
      // resolve to a face in the kernel. A whole-body pick (`@body_...`) names
      // no face and must not match.
      if (id.startsWith('?')) {
        try {
          const q = parseQuery(id)
          return q.kind === 'ancestry' && isFaceRestriction(q.typeRestriction)
        } catch {
          return false
        }
      }
      return id.startsWith('face:') || parseTopoFallbackQuery(id)?.kind === 'face'
    })
    const definition = faceQuery
      ? { mode: 'on_face', face: stripSelectionWrapper(faceQuery) } as const
      : undefined
    setRollbackForNewFeature(features)
    startEditSession(true)
    handleMutation({ type: 'add_plane', featureId, label, definition })
    usePartEditorStore.getState().setEditingFeatureId(featureId)
    const firstPick = FIRST_PICK_FIELD['plane']
    if (firstPick) setActivePickField({ featureId, ...firstPick })
  }, [doc, features, handleMutation, selection, setActivePickField, startEditSession, closeOpenEditorForAdd])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    closeOpenEditorForAdd()
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setRollbackForNewFeature(features)
    handleMutation({ type: 'add_sketch', featureId, label })
    setActivePickField({ featureId, field: 'plane' })
  }, [doc, features, handleMutation, setActivePickField, closeOpenEditorForAdd])

  const handleNewSketchOnPlane = useCallback((plane: string) => {
    if (!doc) return
    closeOpenEditorForAdd()
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    setRollbackForNewFeature(features)
    handleMutation({ type: 'add_sketch', featureId, label, plane })
    // enterEditSketch resolves the feature out of `features`, which React has
    // not re-rendered with the new sketch yet. Defer to the effect below.
    pendingEditSketchId.current = featureId
  }, [doc, features, handleMutation, closeOpenEditorForAdd])

  const handleImportStep = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.step,.stp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
      // Same up-front cap as the library-level STEP import: reject before the
      // read allocates the ArrayBuffer the kernel then parses.
      const tooBig = stepImportLimitError(file.size)
      if (tooBig) {
        setError(tooBig)
        return
      }
      let bytes: Uint8Array
      try {
        bytes = new Uint8Array(await file.arrayBuffer())
      } catch {
        setError('Failed to read STEP file')
        return
      }
      if (bytes.byteLength === 0) {
        setError('STEP file is empty')
        return
      }
      const featureId = randomId(18)
      const label = file.name.replace(/\.(step|stp)$/i, '')
      // The registry create is a write that can fail (quota, a closed DB). It
      // used to reject unhandled on the native input's onchange, so a failed
      // import was silent and the feature never appeared.
      try {
        const entry = await getFileRegistry().create({
          name: file.name,
          kind: 'step',
          mime: 'application/step',
          bytes,
        })
        setRollbackForNewFeature(features)
        handleMutation({ type: 'add_import_step', featureId, fileId: entry.id, label })
      } catch (e) {
        setError(errorMessage(e, 'Failed to import STEP'))
      }
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
  // remounted Part (WorkspacePage keys it by entry) would otherwise inherit the
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
    if (!uuid || !doc) return false
    const success = await saveDoc(uuid, doc, viewportRef.current?.captureScreenshotForSaving)  // screenshot is optional; save proceeds without Viewport
    if (success) setError(null)
    // The toolbar flashes its saved check off this, so a failed save must
    // resolve false rather than vanish into a void promise.
    return success
  }

  // Declared after handleSave so the header's "Save & Exit" gets the real
  // function rather than a temporal-dead-zone reference.
  useUnsavedChangesGuard(handleSave)

  const handleClone = () => {
    if (!uuid) return
    setCloneName(suggestedCloneName(docName))
  }

  const handleCloneConfirm = async (name: string) => {
    if (!uuid) return
    setCloneName(null)
    try {
      const data = await cloneDoc(uuid, name)
      // The clone is taken from the stored document, so walking onto it would
      // leave this editor's unsaved edits behind: another exit from the entry
      // route, and it asks like every other one.
      const target = `/workspaces/${workspaceId ?? uuid}/entries/${data.uuid}`
      if (confirmDiscardUnsavedChanges(() => navigate(target))) navigate(target)
    } catch (e) {
      setError(errorMessage(e, 'Failed to clone document'))
    }
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
    if (!partColorPopoverRef.current) return
    const originalDoc = cancelPreview()
    if (originalDoc && docRef.current) {
      docRef.current = originalDoc
      setDoc(originalDoc)
      reSolve(originalDoc)
    }
    setPartColorPopover(null)
  }, [cancelPreview, docRef, setDoc, reSolve, setPartColorPopover])

  const handleColorApply = useCallback((mutation: Mutation) => {
    commitPreview(mutation)
    setPartColorPopover(null)
  }, [commitPreview, setPartColorPopover])

  // Opening the popover puts the document into preview mode, and only a commit
  // or a cancel takes it out again. So the closing side must go through
  // handleColorCancel rather than just dropping the popover state: a bare
  // setPartColorPopover(null) leaves the preview live behind a closed popover,
  // where the abandoned color stays in the doc, later color edits are swallowed
  // with no undo entry, and the next unrelated edit escape-commits the
  // abandoned preview as an entry of its own. handleColorCancel's
  // no-popover-open guard is the wanted behaviour here: nothing open means this
  // path started no preview. A truthy `opts` with a null docRef lands here too,
  // where no preview can start, and any preview an earlier popover left open is
  // resolved rather than stranded.
  const handleSetPartColorPopover = useCallback((opts: { bodyId: string; position: [number, number] } | null) => {
    if (opts && docRef.current) {
      startPreviewMode(docRef.current)
      colorPopoverSession.current++
      setPartColorPopover({ ...opts, session: colorPopoverSession.current })
    } else {
      handleColorCancel()
    }
  }, [docRef, startPreviewMode, handleColorCancel, setPartColorPopover])

  const handleAlignCameraToSketchPlane = useCallback(() => {
    if (!activeSketchFeatureId || !features) return

    const activeSketch = features.find(f => f.id === activeSketchFeatureId)
    if (!activeSketch || activeSketch.kind !== 'sketch') return

    const planeId = activeSketch.plane
    if (!planeId) return
    const cleanPlaneId = stripRefSigil(planeId, '@')

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
      // The tree names its own target, so only a viewport right-click pays for
      // resolving the selection.
      selectedNormalTarget: targetId
        ? null
        : resolveSelectionNormalTarget(store.normalSelection, store.selectedPicks, features, BUILT_IN_IDS, findFaceFrame),
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
      onSetPartColorPopover: handleSetPartColorPopover,
      onExportBody: (bodyId, name) => exportImportRef.current?.openExport(bodyId, name),
      onNewSketchOnPlane: handleNewSketchOnPlane,
      onShowContextMenu: (items, tid) => setContextMenu({ position: pos, targetId: tid, items }),
    }
    const { items } = buildContextMenu(input, callbacks)
    setContextMenu({ position: pos, targetId, items })
  }, [handleRebuild, handleRemoveDanglingContent, toggleVisibility, toggleSuppression, enterEditSketch, handleExitSketch, handleDeleteFeature,
    handleAlignCameraToSketchPlane, handleNormalToPlane, handleNewSketchOnPlane,
    features, visibleFeaturesWithEdit, activeSketchFeatureId, partLabels, hasDanglingContent,
    viewportRef, handleSetPartColorPopover])

  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      if (e.key !== 'F2' && e.code !== 'F2') return
      // The debug panel is open to whoever is running the app -- it is their own
      // machine and their own documents, so there is nobody to withhold it from.
      e.preventDefault()
      setDebugOpen(prev => !prev)
    }
    window.addEventListener('keydown', handleKeyPress)
    return () => window.removeEventListener('keydown', handleKeyPress)
  }, [])

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
        docName={docName}
        onRename={(name) => renameDoc(uuid!, name)}
        handleSave={handleSave}
        handleClone={handleClone}
        rightContent={
          <>
            <button
              className={`toolbar-btn ${debugOpen ? 'active' : ''}`}
              aria-label="Toggle debug panel"
              title="Toggle debug panel (F2)"
              onClick={() => setDebugOpen(v => !v)}
            >
              <span className="material-icons-outlined">terminal</span>
            </button>
            <button
              className="toolbar-btn"
              aria-label="Toggle debug collision rendering"
              title={showDebugHit ? 'Hide debug collision rendering' : 'Show debug collision rendering'}
              onClick={() => setShowDebugHit(!showDebugHit)}
            >
              <span className="material-icons-outlined">{showDebugHit ? 'visibility' : 'visibility_off'}</span>
            </button>
          </>
        }
      />

      <PartEditorPanel
        mode={mode}
        setMode={setMode}
        solveError={solveError}
        setSolveError={setSolveError}
        error={error}
        setError={setError}
        loading={loading}
        planeSelectionFeatureId={planeSelectionFeatureId}
        handleAddFeature={handleAddFeature}
        handleAddSketch={handleAddSketch}
        handleAddPlane={handleAddPlane}
        handleImportStep={handleImportStep}
        handleExportStep={handleExportStep}
        viewportRef={viewportRef}
        handleRightClick={handleRightClick}
        viewportHud={
          <MeasurementDisplay sketch={measurementSketch} measurementIcon={measurementIcon} solveResults={solveResults} bodies={bodies} />
        }
        rightPanel={
          <PartDebugPanel debugOpen={debugOpen} />
        }
      >
        <PartEditorProvider value={partEditorCallbacks}>
          <Sidebar />
        </PartEditorProvider>
      </PartEditorPanel>

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
      <PartExportImport ref={exportImportRef} uuid={uuid!} />
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
