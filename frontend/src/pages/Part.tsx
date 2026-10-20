import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import type { ViewportHandle } from '@/components/Viewport'
import type { PartDoc, PartFeature, Mutation, Sketch } from '@/types/cad'
import { randomId } from '@/utils/yamlMutations'
import { isWholeBodySelectionId, parseTopoFallbackQuery, stripSelectionWrapper } from '@/utils/query/selectionId'
import { stripRefSigil } from '@/utils/refSigil'
import { parseQuery } from '@/utils/query'
import { isFaceRestriction } from '@/kernel/occ/primitives'
import { wouldOverconstrain } from '@/kernel/features/constraintProbe'
import { visibleFeatureIds } from '@/utils/featureVisibility'
import { useSketchEditorStore, useSketchUiStore, setSketchCallback, sketchOwnedDeleteTargets, type PendingConstraint } from '@/stores/sketchEditorStore'
import { useEditorState, editorState } from '@/hooks/useEditorState'
import { syncRollbackFromDoc } from '@/stores/editorState'
import { usePartDoc } from '@/hooks/usePartDoc'
import { capturePreview } from '@/stores/previewStore/capture'
import RightClickMenu from '@/components/dialogs/RightClickMenu'
import type { ContextMenuItem } from '@/components/dialogs/RightClickMenu'
import { PartDocumentPanel } from '@/components/layout/PartDocumentPanel'
import { FeatureEditPanel } from '@/components/layout/FeatureEditPanel'
import MeasurementDisplay from '@/components/layout/MeasurementDisplay'
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
import { getSketchState, PART_COMMAND_SPECS, type PartCommandContext, type ShowMessagePayload } from '@/pages/commandEntries'
import { CommandRegistryProvider } from '@/contexts/CommandRegistryContext'
import { installDriveSurface } from '@/drive/driveSurface'
import { DRIVE_ENABLED } from '@/drive/gate'
import { getCommandJournal, journalSink } from '@/drive/journal'
import { attachAutosave, registerRecoveryEditor, useAutosaveStore } from '@/recovery/autosave'
import { CommandRegistry } from '@/utils/core/commandSpec'
import type { SessionJournalSink } from '@/session/DocSession'
import MessageDialog from '@/components/dialogs/MessageDialog'
import { useEditFeature } from '@/pages/useEditFeature'

import measurementIcon from '@/assets/icons/measurement.svg'

import { buildContextMenu } from './buildContextMenu'
import type { BuildContextMenuInput, BuildContextMenuCallbacks, RenameTarget } from './buildContextMenu'
import { resolveSelectionNormalTarget } from './selectionNormalTarget'
import { findFaceFrame } from '@/components/Viewport/idDispatch/bodyDispatchCallbacks'
import RenameDialog from '@/components/dialogs/RenameDialog'
import RawDocumentDialog from '@/components/dialogs/RawDocumentDialog'
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

// A new feature belongs in the rollback bar's slot when the user parked it
// mid-stack, and at the end otherwise. The bar can never sit above the
// built-ins, so neither may an insertion. A doc with no built-ins (fixtures,
// hand-authored logs) reserves nothing.
function newFeatureInsertIndex(features: PartFeature[], rollbackPosition: number | null): number {
  const firstUserIndex = features.findIndex(f => !BUILT_IN_IDS.has(f.id))
  const floor = firstUserIndex < 0 ? features.length : firstUserIndex
  return Math.max(floor, Math.min(rollbackPosition ?? features.length, features.length))
}

// The non-builtin count before an absolute feature index: the pick_boundary a
// feature inserted there solves under.
function nonBuiltInCountBefore(features: PartFeature[], index: number): number {
  return features.slice(0, index).filter(f => !BUILT_IN_IDS.has(f.id)).length
}

// Pin the bar just after the inserted features so the add's solve includes them
// and the downstream stack stays rolled back. At the end of the stack this is
// the end again: applySetRollback drops the key once the position reaches the
// new feature count.
function setRollbackAfterInsertions(firstInsertAt: number, count = 1) {
  editorState.getState().setRollbackPosition(firstInsertAt + count)
}

function extractFeatures(doc: PartDoc | null): PartFeature[] {
  return doc?.features ?? []
}

const FIRST_PICK_FIELD: Record<string, { field: string; multi?: boolean }> = {
  plane: { field: 'plane' },
  extrude: { field: 'sketch', multi: true },
  revolve: { field: 'sketch', multi: true },
  sweep: { field: 'sketch', multi: true },
  fillet: { field: 'edges', multi: true },
  chamfer: { field: 'edges', multi: true },
  shell: { field: 'faces', multi: true },
  move_face: { field: 'faces', multi: true },
  delete_face: { field: 'faces', multi: true },
  hole: { field: 'sketch' },
  boolean: { field: 'target' },
  transform: { field: 'bodies', multi: true },
  mirror: { field: 'body' },
  delete_body: { field: 'bodies', multi: true },
  circular_array: { field: 'axis' },
  helix: { field: 'reference' },
}

/**
 * The stored face query a selection id names, or null when it names something
 * else (a body, an edge, a vertex, an entity). `?`-ancestry ids carry the OCC
 * surface type as the type restriction; `face:` wrappers (owner attribution)
 * unwrap to the inner wire query, which resolves. A topo-fallback
 * `@<bodyId>/face/<idx>` ref is returned verbatim, but only the on-face plane
 * resolves it (resolveFaceProfile reads it by index); the delete_face leaf
 * resolves construction only (the UUID tier then stable ancestry), so such a
 * pick lands in its unresolved_faces instead of healing. A whole-body pick
 * (`@body_...`) names no face and returns null.
 */
function faceSelectionQuery(id: string): string | null {
  if (id.startsWith('?')) {
    try {
      const q = parseQuery(id)
      return q.kind === 'ancestry' && isFaceRestriction(q.typeRestriction) ? stripSelectionWrapper(id) : null
    } catch {
      return null
    }
  }
  if (id.startsWith('face:')) return stripSelectionWrapper(id)
  if (parseTopoFallbackQuery(id)?.kind === 'face') return stripSelectionWrapper(id)
  return null
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
  // rollbackPosition is owned by the L2 editor-state store (single source of
  // truth). Read here for memos / props; mutate via its setters.
  const rollbackPosition = useEditorState(s => s.rollbackPosition)
  const rollbackInitialized = useRef(false)
  const viewportRef = useRef<ViewportHandle>(null)
  const exportImportRef = useRef<PartExportImportHandle>(null)
  const handleFirstSolve = useCallback(() => {
    if (!uuid) {
      viewportRef.current?.autoZoomToFit()
      return
    }
    // Re-arm auto-fit for this freshly loaded document, then thumbnail the
    // solved scene on the fit's own settled signal. Saving was the only writer
    // of a preview, so a document opened and never saved had none and its row
    // painted a placeholder; the first solve is the earliest moment there is
    // geometry to photograph. Capturing on a fixed tick instead of the settled
    // fit photographed whatever camera happened to be live, often the default
    // one, and an empty frame then replaced a good thumbnail. Best-effort and
    // fire-and-forget: the key is the save path's, and a failed capture never
    // reaches the editor. A null Viewport is an intentional no-op.
    viewportRef.current?.autoZoomToFit(false, () => {
      void capturePreview(viewportRef.current?.captureScreenshotForSaving, workspaceId, uuid)
    })
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
  const showDebugHit = useSketchUiStore(s => s.showDebugHit)
  const setShowDebugHit = useSketchUiStore(s => s.setShowDebugHit)

  const activePickField = useSketchEditorStore(s => s.activePickField)
  const setActivePickField = useSketchEditorStore(s => s.setActivePickField)
  const selection = useSketchEditorStore(s => s.normalSelection)
  const toggleNormalSelection = useSketchEditorStore(s => s.toggleNormalSelection)

  // The journal sink the session records through. Always on, not gated with the
  // drive surface: the recovery autosave borrows this replayable tail, so the
  // seam must record in production too. The session seam (not the command
  // registry) is what makes drawing and gestures journaled; the session's docId
  // check is the hard lock against a journal spanning two documents.
  const driveJournal = useMemo<SessionJournalSink>(() => journalSink(getCommandJournal()), [])
  // A switch loads a new document into this editor (WorkspacePage keys Part per
  // entry), so the previous document's replayable suffix must go with it: the
  // next entry's baseline is the document just opened.
  useEffect(() => {
    getCommandJournal().reset(uuid ?? null)
  }, [uuid])

  const {
    doc,
    session,
    docRef,
    loading,
    error,
    setError,
    loadFailure,
    setLoadFailure,
    solveResults,
    solving,
    solveError,
    setSolveError,
    reSolve,
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
    pickStateReady,
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    registerUndoTeardown,
  } = usePartDoc(uuid, { onFirstSolve: handleFirstSolve, workspace: workspaceId, journal: driveJournal })

  // The autosave shadow copy of this document's unsaved edits. It reads the
  // session directly (never React state), so the crash flush and the error
  // boundary always see the live doc, and it borrows the command journal's
  // replayable tail rather than recording one of its own.
  const docNameLive = useRef(docName)
  useEffect(() => { docNameLive.current = docName }, [docName])
  useEffect(() => {
    if (!uuid) return
    const handle = attachAutosave({
      session,
      docId: uuid,
      workspace: workspaceId ?? null,
      getRepro: () => getCommandJournal().repro(),
      getName: () => docNameLive.current,
    })
    registerRecoveryEditor(handle)
    return () => {
      registerRecoveryEditor(null)
      handle.dispose()
    }
  }, [session, uuid, workspaceId])
  const autosaveStatus = useAutosaveStore(s => s.status)
  const autosaveError = useAutosaveStore(s => s.error)

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
      editorState.getState().setRollbackPosition(features.length)
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
    const editing = editorState.getState().editingFeatureId
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
    // The UI store's canonical wipe: the value dialog and the store-owned
    // context menu are transient editor chrome like the selection above.
    useSketchUiStore.getState().resetTransientState()
    setContextMenu(null)
    // The popover closes: an undo or redo already committed a changed preview
    // as its own entry (usePartDoc's commitOpenWorkBeforeHistory), and a
    // popover left open would only be able to commit or revert against a world
    // that no longer exists.
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

  // The page publishes the doc-derived view data it computes; the session and
  // solver publish their own facts (usePartDoc/useSolver). Each field has one
  // writer, and the removed mirror hook copied none of them from a snapshot.
  useEffect(() => {
    usePartEditorStore.getState().publishDerived({
      visibleFeatures: visibleFeaturesWithEdit,
      visibleBodies: effectiveVisibleBodies,
      partLabels,
      otherSketches,
      isRebuilding,
    })
  }, [visibleFeaturesWithEdit, effectiveVisibleBodies, partLabels, otherSketches, isRebuilding])

  // The editor-derived viewport fields go to L2: ghost mode is an edit-session
  // read, the colors/styles are the live doc's part_style projection and the
  // active sketch id is the viewport's sketch-edit read. This effect is the
  // single writer of activeSketchFeatureId: entering a sketch edit only moves
  // editingFeatureId/rollback/forced visibility, and the memo above turns that
  // into the id on the next commit (verified by the sketch-edit suites).
  useEffect(() => {
    editorState.getState().setViewportDerived({ ghostMode, partColors, partStyle })
    editorState.getState().setActiveSketchFeatureId(activeSketchFeatureId ?? null)
  }, [ghostMode, partColors, partStyle, activeSketchFeatureId])

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
    const store = useSketchEditorStore.getState()
    const sel = store.normalSelection
    const bodyIds = new Set(Object.keys(bodies))
    const bodyDeletes: Mutation[] = []
    const featureDeletes: Mutation[] = []
    // An edit pins the bar just after the edited feature; moving it here would
    // break that invariant, so a delete during an edit keeps the old append
    // behaviour and leaves the bar alone.
    const insertAtBar = editorState.getState().editingFeatureId === null
    const insertBase = newFeatureInsertIndex(features, editorState.getState().rollbackPosition)
    const insertion = (offset: number) => insertAtBar ? { insertAt: insertBase + offset } : {}
    // Every selected face pick folds into ONE add_delete_face for the whole
    // press (delete_face heals all of them in one feature), so a Delete with
    // faces selected is one undo entry, the same pattern add_delete_body
    // follows. Edges and vertices are not faces and stay ignored.
    const facePicks: string[] = []
    // First pass names the feature ids this Delete actually removes, so the body
    // pass can tell whether a body's generator is going away with it.
    const deletingFeatures = new Set<string>()
    for (const id of [...sel]) {
      const faceQuery = faceSelectionQuery(id)
      if (faceQuery !== null) {
        facePicks.push(faceQuery)
        continue
      }
      if (!id.startsWith('@') || id.startsWith('@builtin_')) continue
      const ref = id.slice(1)
      if (features.some(f => f.id === ref)) deletingFeatures.add(ref)
    }
    for (const id of [...sel]) {
      if (faceSelectionQuery(id) !== null) continue
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
        bodyDeletes.push({
          type: 'add_delete_body', featureId: randomId(18), bodies: [id], label: 'Delete Body',
          ...insertion(bodyDeletes.length),
        })
        continue
      }
      if (features.some(f => f.id === ref)) {
        featureDeletes.push({ type: 'delete_feature', featureId: ref })
      }
    }
    // One Delete action on N targets is one undo step, not N: commitMutationGroup
    // applies every handler to one doc clone and solves once at the end. When no
    // edit pins the bar, the add_delete_* features carry increasing insertAt
    // slots so they land as one contiguous block, in the order listed, at it.
    const threeD = [
      ...bodyDeletes,
      ...(facePicks.length > 0
        ? [{
          type: 'add_delete_face', featureId: randomId(18), faces: facePicks, label: 'Delete Face',
          ...insertion(bodyDeletes.length),
        } as Mutation]
        : []),
      ...featureDeletes,
    ]

    if (threeD.length > 0) {
      // A mixed selection (sketch entity + a 3D target) is ONE press, ONE entry.
      // Fold the sketch delete the store would make into the same group so a
      // single undo reverts both halves; the store's own dispatch is bypassed
      // here because it would push a separate entry first and then wipe the
      // selection the 3D pass needs, which is what used to strand the 3D half.
      // A 3D-only selection keeps its group exactly as before (no sketch half).
      const sketchDelete = sketchOwnedDeleteTargets(sel, store.activeFeatureId)
      const mutations: Mutation[] = sketchDelete.length > 0
        ? [{ type: 'delete', targets: sketchDelete }, ...threeD]
        : threeD
      // A Delete while rolled back inserts its delete features at the bar and
      // solves them in the same press. Deleting a feature above the bar shifts
      // the inserted block (and the bar) down with the list.
      const addCount = bodyDeletes.length + (facePicks.length > 0 ? 1 : 0)
      if (insertAtBar && addCount > 0) {
        const deletedBeforeBar = featureDeletes.filter(m => {
          const idx = m.type === 'delete_feature' ? features.findIndex(f => f.id === m.featureId) : -1
          return idx >= 0 && idx < insertBase
        }).length
        setRollbackAfterInsertions(insertBase - deletedBeforeBar, addCount)
      }
      commitMutationGroup(mutations)
      // The shared post-delete wipe, not a bare clearNormalSelection: a mixed
      // Delete must leave the same post-condition the sketch-only branch's
      // deleteSelected leaves, hovered-constraint residue included.
      useSketchEditorStore.getState().clearSelectionAfterDelete()
      return
    }

    // No 3D work: the sketch half keeps the store's own deleteSelected, which
    // dispatches the delete via onMutation and wipes the selection (a sketch-
    // only press unchanged). A non-deletable selection (a face primitive, a
    // builtin) filters to nothing, so the store no-ops and the selection stands.
    store.deleteSelected()
  }, [commitMutationGroup, bodies, features])

  // Adding a feature while another feature's editor is open must close that
  // editor first (the one-open-editor discipline enterEditFeature enforces).
  // Otherwise the new add is swallowed into the open session and Cancel or an
  // undo rolls both features back together. Deliberately no re-solve here: the
  // add's own funnel issues the single solve, and resetEditState only drops the
  // transient UI. commitEditSession runs before resetEditState because its
  // aggregate label names the store's editingFeatureId, which the reset clears.
  const closeOpenEditorForAdd = useCallback(() => {
    if (editorState.getState().editingFeatureId === null) return
    commitEditSession()
    resetEditState()
  }, [commitEditSession, resetEditState])

  const handleAddFeature = useCallback((kind: string, extra?: Record<string, unknown>) => {
    if (!doc) return
    closeOpenEditorForAdd()
    const fid = randomId(18)
    const label = `${kind} ${Object.keys(bodies).length + 1}`
    const insertAt = newFeatureInsertIndex(features, editorState.getState().rollbackPosition)
    const store = editorState.getState()
    // Start the edit session against the PRE-add doc and let it suppress the
    // add: OK then folds the add and any in-session field edits into one
    // aggregate step, and Cancel rewinds the add away. Starting the session
    // after the dispatch would pin the post-add doc, so Cancel would leave the
    // new feature standing.
    startEditSession(true)
    // Pin the bar just past the new feature so the mutation-triggered reSolve
    // includes it, and pre-stage pick_boundary as if the new feature were the
    // edit target. The new feature lands at the bar (or the end when none is
    // parked), so the solve is cached under that key. When the user later
    // clicks Edit on the new feature, enterEditFeature recomputes the same
    // pick_boundary and the cache hit is free.
    setRollbackAfterInsertions(insertAt)
    store.setPickBoundary(nonBuiltInCountBefore(features, insertAt))
    // Starting the Delete Face tool with faces already selected pre-fills them,
    // the same convenience handleAddPlane gives the on-face plane. Other kinds
    // that take their faces as a list seed nothing.
    const seedFaces = kind === 'delete_face'
      ? [...selection].map(faceSelectionQuery).filter((q): q is string => q !== null)
      : []
    const result = handleMutation({
      type: `add_${kind}`, featureId: fid, label, ...extra,
      ...(seedFaces.length > 0 ? { faces: seedFaces } : {}),
      insertAt,
    } as Mutation)
    // Move Face starts from what the user already has selected: pre-fill the
    // pick list with the selected flat faces, the way Add Plane takes a face
    // from the selection. A non-flat pick cannot be pre-filled (planarity is a
    // kernel classification), so it is simply left for the pick field.
    if (kind === 'move_face') {
      for (const id of selection) {
        if (!id.startsWith('?')) continue
        try {
          const q = parseQuery(id)
          if (q.kind === 'ancestry' && q.typeRestriction === 'flatface') {
            handleMutation({ type: 'add_move_face_ref', featureId: fid, faceQuery: stripSelectionWrapper(id) })
          }
        } catch {
          // not a pickable ancestry query; the pick field is the way in
        }
      }
    }
    // enterEditFeature would bail because React hasn't re-rendered with the
    // new feature yet (features.findIndex(f => f.id === fid) returns -1), so
    // the id is set eagerly; the session started above already owns commit and
    // cancel, so unlike the old no-session path Cancel now removes the add.
    store.setEditingFeatureId(fid)
    const firstPick = FIRST_PICK_FIELD[kind]
    if (firstPick) setActivePickField({ featureId: fid, ...firstPick })
    // The Result rides back to the command spec so a programmatic caller sees
    // the created feature id.
    return result
  }, [doc, features, handleMutation, bodies, setActivePickField, startEditSession, closeOpenEditorForAdd, selection])

  const handleAddPlane = useCallback(() => {
    if (!doc) return
    closeOpenEditorForAdd()
    const featureId = randomId(18)
    const planeCount = (doc.features ?? []).filter(f => f.kind === 'plane' && !BUILT_IN_IDS.has(f.id)).length
    const label = `plane ${planeCount + 1}`
    const faceQuery = [...selection].map(faceSelectionQuery).find((q) => q !== null)
    const definition = faceQuery
      ? { mode: 'on_face', face: faceQuery } as const
      : undefined
    const insertAt = newFeatureInsertIndex(features, editorState.getState().rollbackPosition)
    setRollbackAfterInsertions(insertAt)
    startEditSession(true)
    handleMutation({ type: 'add_plane', featureId, label, definition, insertAt })
    editorState.getState().setEditingFeatureId(featureId)
    const firstPick = FIRST_PICK_FIELD['plane']
    if (firstPick) setActivePickField({ featureId, ...firstPick })
  }, [doc, features, handleMutation, selection, setActivePickField, startEditSession, closeOpenEditorForAdd])

  const handleAddSketch = useCallback(() => {
    if (!doc) return
    closeOpenEditorForAdd()
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    const insertAt = newFeatureInsertIndex(features, editorState.getState().rollbackPosition)
    setRollbackAfterInsertions(insertAt)
    handleMutation({ type: 'add_sketch', featureId, label, insertAt })
    setActivePickField({ featureId, field: 'plane' })
  }, [doc, features, handleMutation, setActivePickField, closeOpenEditorForAdd])

  const handleNewSketchOnPlane = useCallback((plane: string) => {
    if (!doc) return
    closeOpenEditorForAdd()
    const featureId = randomId(18)
    const sketchCount = (doc.features ?? []).filter(f => f.kind === 'sketch').length
    const label = `sketch ${sketchCount + 1}`
    const insertAt = newFeatureInsertIndex(features, editorState.getState().rollbackPosition)
    setRollbackAfterInsertions(insertAt)
    handleMutation({ type: 'add_sketch', featureId, label, plane, insertAt })
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
        // Import is an add path: close any open editor first, exactly like
        // extrude/hole/transform/sketch. Otherwise the add lands inside the open
        // session's suppressed aggregate and the rollback mirror (gated on
        // editingFeatureId === null) never writes doc.rollback, stranding the
        // imported feature past the bar. It sits after the registry create so a
        // failed read (the size cap, the arrayBuffer rejection, the empty-file
        // check) or a failed registry write leaves the open session alone: both
        // return before this line. A malformed STEP is NOT protected here and
        // cannot be -- nothing parses the bytes at import time; the parse runs
        // at solve time (kernel/features/importStep.ts), so a bad file lands as
        // a feature whose solve errors like any other.
        closeOpenEditorForAdd()
        const liveFeatures = docRef.current?.features ?? features
        const insertAt = newFeatureInsertIndex(liveFeatures, editorState.getState().rollbackPosition)
        setRollbackAfterInsertions(insertAt)
        handleMutation({ type: 'add_import_step', featureId, fileId: entry.id, label, insertAt })
      } catch (e) {
        setError(errorMessage(e, 'Failed to import STEP'))
      }
    }
    input.click()
  }, [handleMutation, features, setError, closeOpenEditorForAdd, docRef])

  const handleExportStep = useCallback(() => {
    exportImportRef.current?.openExport(null, docName || 'export')
  }, [docName])

  const handleToggleSketchPlaneVisibility = useCallback(() => {
    handleMutation({ type: 'toggle_sketch_plane_visibility' })
  }, [handleMutation])

  const handleTogglePlaneVisibility = useCallback(() => {
    handleMutation({ type: 'toggle_plane_visibility' })
  }, [handleMutation])

  // The authoring gate for a new constraint: the probe runs the real solver on
  // a draft copy of the active sketch feature, so a redundant add is refused
  // before `applyConstraint` creates a mutation. docRef is a ref, so the
  // callback never goes stale.
  const checkRedundantAdd = useCallback((pending: PendingConstraint) => {
    return wouldOverconstrain(docRef.current, pending)
  }, [docRef])

  useEffect(() => {
    setSketchCallback('onMutation', handleMutation)
    setSketchCallback('onMutationBatch', commitMutationGroup)
    setSketchCallback('beginBrepProjection', beginBrepProjection)
    setSketchCallback('cancelBrepProjection', cancelBrepProjection)
    setSketchCallback('onRebuild', handleRebuild)
    setSketchCallback('onExitSketch', handleExitSketch)
    setSketchCallback('checkRedundantAdd', checkRedundantAdd)
    // How the dimension confirm path surfaces an authoring refusal of its own
    // (the gate above answers, but the refusal has no command caller to return
    // a reason to): the same MessageDialog the command rejections use.
    setSketchCallback('showMessage', showMessage)
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
      setSketchCallback('checkRedundantAdd', null)
      setSketchCallback('showMessage', null)
      setSketchCallback('getSketch', null)
    }
  }, [handleMutation, commitMutationGroup, beginBrepProjection, cancelBrepProjection, handleRebuild, handleExitSketch, checkRedundantAdd, showMessage, solveResults])

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
      useSketchUiStore.getState().resetTransientState()
      // The part-side FSM and derived fields describe the document that was
      // open; a remounted Part must not inherit them (the old mirror's unmount
      // reset, now owned by the store it belonged to).
      editorState.getState().resetEditorState()
      // Same for the published session/solver facts: until the new session
      // publishes its own doc and solve, a keyed remount would otherwise read
      // the previous document's facts from this store.
      usePartEditorStore.getState().resetPublishedState()
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

  // The live command context the registry hands every spec: the session and
  // the page's action callbacks, so the command table itself is static data.
  const commandContext = useMemo<PartCommandContext>(() => ({
    editor: 'part',
    session,
    state: getSketchState,
    undo: handleUndoNoFit,
    redo: handleRedoNoFit,
    deleteSelectedFeatures: handleDeleteSelectedFeatures,
    toggleSketchPlaneVisibility: handleToggleSketchPlaneVisibility,
    togglePlaneVisibility: handleTogglePlaneVisibility,
    addFeature: (kind, extra) => handleAddFeature(kind, extra) ?? null,
    showMessage,
  }), [
    session, handleUndoNoFit, handleRedoNoFit, handleDeleteSelectedFeatures,
    handleToggleSketchPlaneVisibility, handleTogglePlaneVisibility, handleAddFeature, showMessage,
  ])
  // One registry per live context. The journal no longer wraps the registry:
  // recording moved to the session mutation seam, which also sees drawing and
  // gestures (they never pass a command) and keeps the solver write-back out.
  const commandRegistry = useMemo(
    () => new CommandRegistry<PartCommandContext>(() => commandContext),
    [commandContext],
  )
  usePartCommands(commandRegistry)

  // Q6: the drive surface is a dev/test affordance. The gate constant is folded
  // by the bundler, so in a production build this effect body is dead code and
  // the bridge module is never referenced.
  useEffect(() => {
    if (!DRIVE_ENABLED) return
    return installDriveSurface({
      registry: commandRegistry,
      specs: PART_COMMAND_SPECS,
      inspectSession: () => session.inspect(),
      editorState: getSketchState,
      idle: () => session.idle(),
      executeMutation: mutation => session.execute(mutation),
      screenshot: () => viewportRef.current?.captureScreenshotForSaving() ?? Promise.resolve(null),
      journal: { repro: () => getCommandJournal().repro() },
    })
  }, [commandRegistry, session])

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
    const store = editorState.getState()
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
    cancelPreview()  // rewinds the doc itself; null means it had already committed
    setPartColorPopover(null)
  }, [cancelPreview, setPartColorPopover])

  const handleColorApply = useCallback((mutation: Mutation) => {
    commitPreview(mutation)
    setPartColorPopover(null)
  }, [commitPreview, setPartColorPopover])

  // Opening the popover puts the document into preview mode (unless an edit
  // session owns the doc: startPreviewMode refuses then, so there is no preview
  // to strand and the popover's edits land as session edits), and only a commit
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
          // the floating edit panel's OK/Cancel left to escape it.
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
      showConstraintTiles: useSketchUiStore.getState().showConstraintTiles,
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
        const s = useSketchUiStore.getState()
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
    <CommandRegistryProvider value={commandRegistry}>
    <div className="document-viewer">
      <PartToolbar
        docName={docName}
        onRename={(name) => renameDoc(uuid!, name)}
        handleSave={handleSave}
        handleClone={handleClone}
        onImport={handleImportStep}
        onExport={handleExportStep}
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

      {/* One provider for both overlays and the editor chrome between them:
          the part panels and the toolbar all answer the same callbacks. */}
      <PartEditorProvider value={partEditorCallbacks}>
        <PartEditorPanel
          mode={mode}
          setMode={setMode}
          solveError={solveError}
          setSolveError={setSolveError}
          error={error}
          setError={setError}
          autosaveError={autosaveStatus === 'error' ? autosaveError : null}
          onDismissAutosaveError={() => useAutosaveStore.setState({ status: 'idle', error: null })}
          loading={loading}
          planeSelectionFeatureId={planeSelectionFeatureId}
          handleAddFeature={handleAddFeature}
          handleAddSketch={handleAddSketch}
          handleAddPlane={handleAddPlane}
          viewportRef={viewportRef}
          handleRightClick={handleRightClick}
          viewportHud={
            <MeasurementDisplay sketch={measurementSketch} measurementIcon={measurementIcon} solveResults={solveResults} bodies={bodies} />
          }
          rightPanel={
            <PartDebugPanel debugOpen={debugOpen} />
          }
          leftOverlay={<PartDocumentPanel />}
          rightOverlay={<FeatureEditPanel />}
        />
      </PartEditorProvider>

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
      <RawDocumentDialog failure={loadFailure} onClose={() => setLoadFailure(null)} />
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
    </CommandRegistryProvider>
  )
}
