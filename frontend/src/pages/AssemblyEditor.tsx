import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { parseHttpError } from '@/utils/core/httpClient'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, setAssemblyCallbacks, DEFAULT_ASSEMBLY_EDITOR_DATA, type MateFieldTarget } from '@/stores/assemblyStore'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import LoadingOverlay from '@/components/dialogs/LoadingOverlay'
import AssemblyViewport, { type AssemblyViewportHandle } from '@/components/Viewport/AssemblyViewport'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import { MateEditor } from '@/components/layout/MateEditor'
import { PartInstanceEditor } from '@/components/layout/PartInstanceEditor'
import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'
import RenameDialog from '@/components/dialogs/RenameDialog'
import AssemblyExport, { type AssemblyExportHandle } from '@/pages/AssemblyExport'
import { backendBundle } from '@/adapters/backend'
import { useCloudAvailable } from '@/hooks/useCloudAvailable'
import {
  appendMate,
  appendPartInstance,
  assemblyDocEquals,
  bakeSolvedTransforms,
  duplicateInstance,
  findInstance,
  findMate,
  mintFeatureId,
  moveInstance,
  moveMate,
  removeInstance,
  removeMate,
  replaceInstance,
  replaceMate,
  setBuiltinVisible,
  setInstanceVisible,
  setInstancePosition,
  setInstanceRotation,
  setInstanceFixedFromSolved,
  setMateLabel,
  updateMate,
  type EulerDeg,
  type MateParamPatch,
} from '@/utils/assemblyMutations'
import { getAssemblyBuiltins } from '@/utils/assemblyRender'
import { MATE_KINDS, MATE_KIND_LABELS, EMPTY_MATE_REF } from '@/utils/mateKinds'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import AssemblyMeasurementDisplay from '@/components/layout/AssemblyMeasurementDisplay'
import type { AssemblyDoc, MateKind, MateFeatureDef, PartInstance } from '@/types/cad'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import exportIcon from '@/assets/icons/icon-download.svg'
import measurementIcon from '@/assets/icons/measurement.svg'
import mateFixedIcon from '@/assets/icons/mate-fixed.svg'
import mateSlidingIcon from '@/assets/icons/mate-sliding.svg'
import mateRotatingIcon from '@/assets/icons/mate-rotating.svg'
import mateSlidingRotatingIcon from '@/assets/icons/mate-sliding-rotating.svg'
import mateSphericalIcon from '@/assets/icons/mate-spherical.svg'
import mateParallelIcon from '@/assets/icons/mate-parallel.svg'
import mateParallelPlaneDistanceIcon from '@/assets/icons/mate-parallel-plane-distance.svg'
import mateTangentialIcon from '@/assets/icons/mate-tangential.svg'
import mateCopyRotationIcon from '@/assets/icons/mate-copy-rotation.svg'
import '@/pages/Part.css'
import '@/pages/Assembly.css'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

// One toolbar button per mate kind, so the glyphs live next to the labels.
const MATE_KIND_ICONS: Record<MateKind, string> = {
  fixed: mateFixedIcon,
  sliding: mateSlidingIcon,
  rotating: mateRotatingIcon,
  sliding_rotating: mateSlidingRotatingIcon,
  spherical: mateSphericalIcon,
  parallel: mateParallelIcon,
  parallel_plane_distance: mateParallelPlaneDistanceIcon,
  tangential: mateTangentialIcon,
  copy_rotation: mateCopyRotationIcon,
}

export default function AssemblyEditor({ uuid }: { uuid: string }) {
  const {
    doc,
    setDoc,
    docRef,
    loading,
    error,
    setError,
    docName,
    instances,
    mates,
    permission,
    saveDoc,
    renameDoc,
    cloneDoc,
  } = useAssemblyDoc(uuid)
  const navigate = useNavigate()
  const readOnly = permission === 'view'
  const [pickerOpen, setPickerOpen] = useState(false)
  const [editingInstanceHandle, setEditingInstanceHandle] = useState<string | null>(null)
  // Which mate has its inline parameter editor open. Distinct from the store's
  // selectedMateId: a plain row click selects (highlights), the pencil edits.
  const [editingMateId, setEditingMateId] = useState<string | null>(null)
  // The mate the tridot menu asked to rename, with the name the row was showing
  // so the dialog opens pre-filled even when the mate has no explicit label.
  const [renameMateTarget, setRenameMateTarget] = useState<{ id: string; currentName: string } | null>(null)
  const { requestSolve } = useAssemblySolve(uuid, doc)
  const {
    pushUndo,
    recordSessionEdit,
    commitSession,
    cancelSession,
    handleUndo,
    handleRedo,
  } = useAssemblyUndoRedo(docRef, setDoc, requestSolve)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)
  const selectedMateId = useAssemblyStore(s => s.selectedMateId)
  const activeMateField = useAssemblyStore(s => s.activeMateField)
  const mateResults = useAssemblyStore(s => s.mateResults)
  const solveError = useAssemblyStore(s => s.solveError)
  const showPickDebug = useAssemblyStore(s => s.showPickDebug)

  // Snapshots taken when editing begins, so Cancel can revert every live edit
  // (mates and instances edit the doc in place; there is no other undo point).
  const mateSnapshot = useRef<{ id: string; def: MateFeatureDef } | null>(null)
  const instanceSnapshot = useRef<{ handle: string; inst: PartInstance } | null>(null)

  // Part document names, so the tree shows 'Bracket' rather than the raw uuid.
  // Both domains are consulted (a part may be instanced straight from the cloud
  // browser category); the local home library wins on a uuid present in both.
  // The cloud list is gated on a live session so a guest or offline editor
  // never fires a doomed request; it re-runs when the session (re)appears.
  const cloudListAvailable = useCloudAvailable()
  const [docNames, setDocNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    Promise.allSettled([
      cloudListAvailable ? backendBundle.cloudDocuments!.list() : Promise.resolve([]),
      backendBundle.documents.list(),
    ])
      .then(results => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const r of results) {
          if (r.status !== 'fulfilled') continue  // names are a nicety; fall back to the uuid
          for (const d of r.value) map[d.uuid] = d.name
        }
        setDocNames(map)
      })
    return () => { cancelled = true }
  }, [cloudListAvailable])

  // The hook's memo is what goes into the store, not a second extraction of the
  // same features. This is a de-duplication and nothing more: the memo is keyed
  // on `doc`, so it mints a fresh array on exactly the events the local helper
  // did, and the two filtered and mapped identically. What it buys is that they
  // can no longer drift apart while the effect names one in its deps and uses
  // the other. Keeping the render tree stable across a doc edit that moved no
  // part is a separate mechanism, and it lives in the store (`sameInstances`).
  useEffect(() => {
    if (doc) {
      useAssemblyStore.getState().setSnapshot({
        ...useAssemblyStore.getState(),
        doc,
        instances,
        mates,
      })
    }
  }, [doc, instances, mates])

  // Apply a pure AssemblyDoc mutation, push it into the hook's doc state, and
  // flag the document dirty. The store re-syncs via the effect above. The pre-
  // mutation doc is captured OUTSIDE the setDoc updater: reading the store doc
  // here breaks under React batching, where two mutations in one event both see
  // the same stale pre-doc. `label` names the step in the toolbar tooltip.
  const mutate = useCallback((label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
    const current = docRef.current
    if (!current) return
    const next = fn(current)
    // A value no-op (a visibility set to what it already is, a rename to the
    // same label) still mints a fresh doc, so the reference fast path alone
    // misses it; the structural compare catches that class like the part
    // editor's idempotence guard does. No step, no dirty, no redo clear.
    if (next === current || assemblyDocEquals(current, next)) return
    // A mate or instance editor is a coalescing session: every keystroke and
    // pick folds into one entry, pushed when the editor closes (commitSession).
    // Anything else pushes immediately, so each operation is its own undo step.
    if (editingMateId !== null || editingInstanceHandle !== null) {
      recordSessionEdit(current, label)
    } else {
      pushUndo(current, label)
    }
    docRef.current = next
    setDoc(next)
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc, docRef, editingMateId, editingInstanceHandle, pushUndo, recordSessionEdit])

  // A structural one-shot op (rename, reorder, delete, duplicate, visibility)
  // pushes its own step even while an editor session is open: it is not a
  // keystroke into the edited feature, so it must not fold into that step. The
  // session's coalesced step closes first, so the one-shot's pre-doc captures
  // the doc AFTER the session's edits and a later session commit starts from
  // the post-op doc - pre-docs stay distinct and in order, and undoing the
  // one-shot never drags the session's edits along with it.
  const mutateOneShot = useCallback((label: string, fn: (d: AssemblyDoc) => AssemblyDoc) => {
    commitSession()
    const current = docRef.current
    if (!current) return
    const next = fn(current)
    // Same content-level no-op guard as mutate: a one-shot that writes back the
    // value already held leaves no step behind.
    if (next === current || assemblyDocEquals(current, next)) return
    pushUndo(current, label)
    docRef.current = next
    setDoc(next)
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc, docRef, pushUndo, commitSession])

  useUnsavedChangesGuard()

  // The store owns the drag/gizmo state machine but not the document; give it
  // the doc mutators and the one-solve-per-pointer-up trigger. Drag commits and
  // [Delete] deletes are one-shot, ref picks fold into the open edit session.
  useEffect(() => {
    setAssemblyCallbacks({
      mutateDoc: mutateOneShot,
      mutateDocSession: mutate,
      requestSolve,
    })
    return () => {
      // The page is unmounting with an open mate/instance editor. Its pinned
      // coalescing session would otherwise die with the component: the edits
      // are already in the doc but have no undo entry to reach them, so a save
      // after navigation persists them forever beyond undo. Commit first so
      // navigation leaves one coalesced entry and a consistent stack. The UI
      // state itself needs no closing, the component is going away.
      commitSession()
      setAssemblyCallbacks(null)
    }
  }, [mutateOneShot, mutate, requestSolve, commitSession])

  // The store is module-level and survives a remount, so a new document would
  // otherwise inherit the previous one's manipulation/picks/selection, which
  // describe geometry it does not have. Deliberately unmount-only, mirroring
  // the part editor's resetTransientState cleanup; the load path in
  // useAssemblyDoc resets the same fields before setDoc.
  //
  // resetTransientAssemblyState alone leaves the solved-scene fields (doc,
  // instances, mates, bodies, transforms, edgeCurves, anchors, pickGeometry,
  // mateResults) untouched, since those are React-mirrored via setSnapshot,
  // not store-owned. Without also resetting them here, the module-level store
  // keeps assembly A's scene until assembly B's own first solve overwrites it,
  // so the very first render of B briefly paints A's stale bodies/transforms.
  // setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA) clears exactly those fields,
  // mirroring useSyncPartEditorStore's unmount reset for the part editor.
  useEffect(() => {
    return () => {
      const store = useAssemblyStore.getState()
      store.setSnapshot(DEFAULT_ASSEMBLY_EDITOR_DATA)
      store.resetTransientAssemblyState()
    }
  }, [])

  // Nothing renders until the assembly has been solved once: the bodies dict is
  // filled only by a solve, never by loading the doc.
  const solvedOnce = useRef(false)
  useEffect(() => {
    if (!doc || solvedOnce.current) return
    solvedOnce.current = true
    requestSolve()
  }, [doc, requestSolve])

  const openPicker = useCallback(() => setPickerOpen(true), [])

  const exportRef = useRef<AssemblyExportHandle>(null)
  const openExport = useCallback(() => exportRef.current?.openExport(), [])

  const viewportRef = useRef<AssemblyViewportHandle>(null)
  const handleSave = useCallback(() => {
    // Capture a thumbnail of the solved scene on save, like the part editor. The
    // capturer is optional: the save still proceeds when the viewport is absent.
    if (uuid && doc) saveDoc(uuid, doc, viewportRef.current?.captureScreenshotForSaving)
  }, [uuid, doc, saveDoc])

  const handleClone = useCallback(async () => {
    if (!uuid) return
    try {
      const data = await cloneDoc(uuid)
      navigate(`/documents/${data.uuid}`)
    } catch (e) {
      setError(parseHttpError(e, 'Failed to clone document'))
    }
  }, [uuid, cloneDoc, navigate, setError])

  const handleRename = useCallback(
    (name: string) => renameDoc(uuid, name),
    [renameDoc, uuid],
  )

  // At most one editor is open at a time. Opening a new one (a mate insert, a
  // pencil click) first closes any open editor, committing its coalesced session
  // so each subject's edits land in their own step and no two editors ever share
  // the one pending buffer.
  const closeOpenEditor = useCallback(() => {
    if (editingMateId) {
      setEditingMateId(null)
      mateSnapshot.current = null
    }
    if (editingInstanceHandle) {
      setEditingInstanceHandle(null)
      instanceSnapshot.current = null
    }
    commitSession()
  }, [editingMateId, editingInstanceHandle, commitSession])

  // Insert a mate with both references empty, open its editor and arm ref_a, so
  // the very next click in the viewport aims the first reference. No solve yet:
  // an unreferenced mate has nothing to constrain. The snapshot is the empty
  // mate, so Cancel restores it to that pre-edit state.
  const handleInsertMate = useCallback((kind: MateKind) => {
    // The append is a structural op: mutateOneShot pushes its own step even when
    // another editor is open (and about to be replaced), so cancelling the new
    // editor can never lose the insert. The open editor is closed first so the
    // fresh mate never folds into the previous editor's coalescing session.
    const id = mintFeatureId()
    closeOpenEditor()
    mateSnapshot.current = {
      id,
      def: { kind, ref_a: { ...EMPTY_MATE_REF }, ref_b: { ...EMPTY_MATE_REF } },
    }
    mutateOneShot('Add mate', d => appendMate(d, kind, id))
    const store = useAssemblyStore.getState()
    store.setSelectedMateId(id)
    setEditingMateId(id)  // a fresh mate opens straight into its editor to pick refs
    store.setActiveMateField({ featureId: id, field: 'ref_a' })
  }, [mutateOneShot, closeOpenEditor])

  // The [Delete] key maps to `delete_selected` (CORE_KEYBINDINGS); the store
  // decides whether that is the selected mate or the selected part. The delete
  // is a one-shot (mutateDoc), so it closes any open coalescing session itself;
  // an editor on the deleted subject closes with it and drops its snapshot.
  const handleDeleteSelected = useCallback(() => {
    if (editingMateId) {
      setEditingMateId(null)
      mateSnapshot.current = null
    }
    if (editingInstanceHandle) {
      setEditingInstanceHandle(null)
      instanceSnapshot.current = null
    }
    useAssemblyStore.getState().deleteSelected()
  }, [editingMateId, editingInstanceHandle])

  // Ctrl+Z / Ctrl+Shift+Z land here via CORE_KEYBINDINGS (dispatchKey). Undo
  // always exits an open editor: the coalesced session is discarded by the hook
  // (its doc is about to be replaced), and closing the editor prevents a later
  // commit from pushing a stale snapshot keyed to the pre-undo doc.
  const handleUndoCommand = useCallback(() => {
    setEditingMateId(null)
    setEditingInstanceHandle(null)
    mateSnapshot.current = null
    instanceSnapshot.current = null
    handleUndo()
  }, [handleUndo])

  const handleRedoCommand = useCallback(() => {
    setEditingMateId(null)
    setEditingInstanceHandle(null)
    mateSnapshot.current = null
    instanceSnapshot.current = null
    handleRedo()
  }, [handleRedo])

  const commands = useMemo(() => [
    { name: 'undo', fn: handleUndoCommand },
    { name: 'redo', fn: handleRedoCommand },
    { name: 'insert_part_instance', fn: openPicker },
    { name: 'export_assembly', fn: openExport },
    { name: 'delete_selected', fn: handleDeleteSelected },
    ...MATE_KINDS.map(kind => ({ name: `insert_mate_${kind}`, fn: () => handleInsertMate(kind) })),
  ], [openPicker, openExport, handleDeleteSelected, handleInsertMate, handleUndoCommand, handleRedoCommand])
  useCommandRegistration(commands)

  const handlePick = useCallback((docId: string, docRev: number) => {
    // Bake the placed parts' solved poses into their seeds before adding one, so
    // the re-solve that pulls in the new part keeps the existing assembly where
    // it is on screen rather than restarting the whole solve from stale seeds.
    const transforms = useAssemblyStore.getState().transforms
    mutateOneShot('Add part', d => appendPartInstance(bakeSolvedTransforms(d, transforms), docId, docRev))
    requestSolve()  // the new instance has no bodies until the assembly re-solves
  }, [mutateOneShot, requestSolve])

  const handleDuplicate = useCallback((handle: string) => {
    // Same baking rule as inserting a part: the copy is a new unmated body, so
    // without freezing the solved poses first the re-solve would restart the
    // placed parts from stale seeds and visibly shuffle the assembly.
    const transforms = useAssemblyStore.getState().transforms
    mutateOneShot('Duplicate part', d => duplicateInstance(bakeSolvedTransforms(d, transforms), handle))
    requestSolve()  // the copy has no bodies until the assembly re-solves
  }, [mutateOneShot, requestSolve])

  const handleOpenPartNewTab = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (inst) window.open(`/documents/${inst.doc_id}`, '_blank')
  }, [instances])

  const handleDelete = useCallback((handle: string) => {
    // Freeze the on-screen poses first (same reason as handleDeleteMate):
    // removing a part frees the mates that referenced it, so a re-solve straight
    // from the stale placement seeds could snap the remaining parts back to their
    // drop spots. Baked first, only the freed DOF relaxes.
    // Deleting the instance whose editor is open closes it and drops its revert
    // snapshot; the delete's one-shot commits any open session itself.
    if (editingInstanceHandle === handle) {
      setEditingInstanceHandle(null)
      instanceSnapshot.current = null
    }
    const transforms = useAssemblyStore.getState().transforms
    mutateOneShot('Delete part', d => removeInstance(bakeSolvedTransforms(d, transforms), handle))
    if (useAssemblyStore.getState().selectedPartHandle === handle) {
      useAssemblyStore.getState().setSelectedPartHandle(null)
    }
    requestSolve()  // the removed instance's bodies must leave the scene
  }, [mutateOneShot, requestSolve, editingInstanceHandle])

  const handleToggleVisible = useCallback((handle: string, visible: boolean) => {
    mutateOneShot('Toggle visibility', d => setInstanceVisible(d, handle, visible))
  }, [mutateOneShot])

  // Showing/hiding a reference plane is a pure render change: no re-solve, since
  // the assembly frame is pinned at the world origin and constrains nothing.
  const handleToggleBuiltinVisible = useCallback((id: string, visible: boolean) => {
    mutateOneShot('Toggle plane visibility', d => setBuiltinVisible(d, id, visible))
  }, [mutateOneShot])

  // Fix/unfix a part without moving anything on screen, including the
  // camera. Fixing a part that is already in place adds no geometric
  // constraint (the part is at its solved pose), so the current view is already
  // correct and there is nothing to re-solve. Re-solving would only risk drift:
  // with no fixed anchor the mate solver has gauge freedom and can slide the
  // whole assembly along zero-gradient directions, which reads as the camera
  // jumping. So we do NOT re-solve here; we only flip the flag.
  //
  // We still bake every part's current solved pose into its seed. That keeps the
  // doc's seeds in step with what is on screen, so the next real solve (a drag,
  // a mate edit) starts from the current configuration instead of stale seeds
  // and the new fixed state takes effect cleanly then.
  // The editor checkbox is part of the instance-edit session, so it folds into
  // the coalesced step that the accept commits.
  const fixOrUnfix = useCallback((handle: string, fixed: boolean) => {
    const transforms = useAssemblyStore.getState().transforms
    mutate('Fix/unfix part', d => setInstanceFixedFromSolved(d, handle, fixed, transforms))
  }, [mutate])

  // The options-menu toggle is a one-shot op, its own undo step even when an
  // editor session happens to be open.
  const handleToggleFixed = useCallback((handle: string, fixed: boolean) => {
    const transforms = useAssemblyStore.getState().transforms
    mutateOneShot('Fix/unfix part', d => setInstanceFixedFromSolved(d, handle, fixed, transforms))
  }, [mutateOneShot])

  const handleSelect = useCallback((handle: string) => {
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [])

  // Instance edit: snapshot for revert, open the inline editor, and attach the
  // gizmo to the part being edited. Switching editors commits any open session
  // so each edited subject's changes land in their own step.
  const handleEditInstance = useCallback((handle: string) => {
    closeOpenEditor()
    const inst = doc ? findInstance(doc, handle) : undefined
    instanceSnapshot.current = inst ? { handle, inst: { ...inst } } : null
    setEditingInstanceHandle(handle)
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [doc, closeOpenEditor])

  const handleCommitInstance = useCallback(() => {
    instanceSnapshot.current = null
    // Accept closes the coalescing session: every live position/rotation/fixed
    // edit lands as one undo step.
    commitSession()
    setEditingInstanceHandle(null)
  }, [commitSession])

  const handleCancelInstance = useCallback(() => {
    const snap = instanceSnapshot.current
    if (snap) mutate('Reset instance', d => replaceInstance(d, snap.handle, snap.inst))
    instanceSnapshot.current = null
    // Cancel discards the coalesced session: the snapshot reverted the edits,
    // so there is nothing to record.
    cancelSession()
    setEditingInstanceHandle(null)
    requestSolve()  // undo any live position/fixed edit
  }, [mutate, requestSolve, cancelSession])

  const handleSetFixed = fixOrUnfix

  const handleSetPosition = useCallback((handle: string, pos: { tx: number; ty: number; tz: number }) => {
    // Bake first, then apply the reseat: the manual position overrides only the
    // edited part, while every other part's seed is refreshed to its solved pose
    // so the re-solve does not drag the rest of the assembly off screen from
    // stale seeds. Baking before setInstancePosition also lets the edited part
    // keep its solved orientation rather than the stale seed's.
    const transforms = useAssemblyStore.getState().transforms
    mutate('Set position', d => setInstancePosition(bakeSolvedTransforms(d, transforms), handle, pos))
    requestSolve()
  }, [mutate, requestSolve])

  // Same bake-then-reseat discipline as the position edit. This is the only
  // orientation control a FIXED part has (the triad gizmo refuses one), so
  // it must not be vetoed by the `fixed` flag -- setInstanceRotation is the
  // mutation that ignores it.
  const handleSetRotation = useCallback((handle: string, euler: EulerDeg) => {
    const transforms = useAssemblyStore.getState().transforms
    mutate('Set rotation', d => setInstanceRotation(bakeSolvedTransforms(d, transforms), handle, euler))
    requestSolve()
  }, [mutate, requestSolve])

  // A plain row click selects the mate: it highlights (and, going forward, will
  // light up its two parts and mated geometry in the viewport). It does not open
  // the editor. Selecting away from a mate mid-edit closes that editor, keeping
  // whatever live edits were made (Cancel is the explicit revert), so the
  // coalesced session commits as one step.
  const handleSelectMate = useCallback((featureId: string) => {
    if (editingMateId && editingMateId !== featureId) {
      mateSnapshot.current = null
      commitSession()
      setEditingMateId(null)
    }
    useAssemblyStore.getState().setSelectedMateId(featureId)
  }, [editingMateId, commitSession])

  // The pencil opens the inline editor. Snapshot the current def so Cancel
  // reverts. Insert already primed the snapshot for the mate it created.
  // Switching editors commits any open session so each mate's edits land in
  // their own step instead of merging under the earlier session's pre-doc.
  const handleEditMate = useCallback((featureId: string) => {
    closeOpenEditor()
    if (mateSnapshot.current?.id !== featureId) {
      const def = doc ? findMate(doc, featureId) : undefined
      mateSnapshot.current = def ? { id: featureId, def: { ...def } } : null
    }
    useAssemblyStore.getState().setSelectedMateId(featureId)
    setEditingMateId(featureId)
  }, [doc, closeOpenEditor])

  // Accept: leaving the mate disarms its field, which settles the owed solve,
  // and the coalesced session commits as one undo step.
  const handleCommitMate = useCallback(() => {
    mateSnapshot.current = null
    commitSession()
    setEditingMateId(null)
    useAssemblyStore.getState().setSelectedMateId(null)
  }, [commitSession])

  const handleCancelMate = useCallback(() => {
    const snap = mateSnapshot.current
    const store = useAssemblyStore.getState()
    store.setActiveMateField(null)  // stop aiming before we rewrite the slots
    if (snap) mutate('Reset mate', d => replaceMate(d, snap.id, snap.def))
    mateSnapshot.current = null
    // Cancel discards the coalesced session: the snapshot reverted the edits,
    // so there is nothing to record.
    cancelSession()
    setEditingMateId(null)
    store.setSelectedMateId(null)
    requestSolve()  // restore the solved pose the reverted refs imply
  }, [mutate, requestSolve, cancelSession])

  const handleDeleteMate = useCallback((featureId: string) => {
    // Freeze the on-screen configuration into the seeds before dropping the
    // constraint. The doc's seeds are stale (only a dragged part's seed is
    // written back), so re-solving straight from them would restart the mate
    // solver at the placement poses and snap every part -- especially the one the
    // deleted mate positioned -- back to its drop spot, reading as parts
    // vanishing. Baked first, the re-solve relaxes only the freed DOF.
    // Deleting the mate whose editor is open closes it and drops its revert
    // snapshot; the delete's one-shot commits any open session itself, so a
    // different mate's editor stays open and keeps its own coalesced step.
    if (editingMateId === featureId) {
      setEditingMateId(null)
      mateSnapshot.current = null
    }
    const transforms = useAssemblyStore.getState().transforms
    mutateOneShot('Delete mate', d => removeMate(bakeSolvedTransforms(d, transforms), featureId))
    if (useAssemblyStore.getState().selectedMateId === featureId) {
      useAssemblyStore.getState().setSelectedMateId(null)
    }
    requestSolve()  // the freed DOF must let the parts settle back
  }, [mutateOneShot, requestSolve, editingMateId])

  const handleUpdateMate = useCallback((featureId: string, patch: MateParamPatch) => {
    // A mate parameter edit (offset, angle, flip, ratio, radius) does not
    // move any part on its own; the solve is the only thing that may move
    // them.  Baking the current solved transforms into the part seeds here
    // would incorporate the previous solve's roll into the new seed, and
    // the solver's seed-relative angle (mate_residuals.rs) would then add
    // the new angle on top of that, accumulating every time the user types
    // a new value.  The part seeds stay at whatever the last position
    // change (drag, fix toggle, mate deletion) wrote; a mate param edit
    // only changes what the solver targets from that same seed.
    mutate('Edit mate', d => updateMate(d, featureId, patch))
    // Deferred while a chip is armed: a solve here would drop the candidate set
    // the armed field is still cycling.
    useAssemblyStore.getState().requestSolveOrDefer()
  }, [mutate])

  // Reordering is a pure authored-order edit persisted in the feature array. Like
  // a rename or a visibility toggle it moves nothing on screen, so it does not
  // re-solve: the new order is picked up by the next solve a real edit triggers.
  const handleReorderInstance = useCallback((movingHandle: string, beforeHandle: string | null) => {
    mutateOneShot('Reorder part', d => moveInstance(d, movingHandle, beforeHandle))
  }, [mutateOneShot])

  const handleReorderMate = useCallback((movingId: string, beforeId: string | null) => {
    mutateOneShot('Reorder mate', d => moveMate(d, movingId, beforeId))
  }, [mutateOneShot])

  // Renaming is a pure label edit: no solve, it constrains nothing.
  const handleRenameMate = useCallback((featureId: string, label: string | undefined) => {
    mutateOneShot('Rename mate', d => setMateLabel(d, featureId, label))
  }, [mutateOneShot])

  // The dialog already trims and refuses an empty name, so whatever arrives here
  // is a label worth writing.
  const handleRenameMateConfirm = useCallback((label: string) => {
    if (!renameMateTarget) return
    handleRenameMate(renameMateTarget.id, label)
    setRenameMateTarget(null)
  }, [renameMateTarget, handleRenameMate])

  const handleArmMateField = useCallback((target: MateFieldTarget | null) => {
    useAssemblyStore.getState().setActiveMateField(target)
  }, [])

  // A mate reference names a part handle; the tree shows the part's document name.
  const labelFor = useCallback(
    (handle: string) => {
      const inst = instances.find(i => i.handle === handle)
      if (!inst) return undefined
      return docNames[inst.doc_id] || inst.doc_id
    },
    [instances, docNames],
  )

  const builtins = useMemo(() => getAssemblyBuiltins(doc), [doc])

  const selectedMate = doc && selectedMateId ? findMate(doc, selectedMateId) : undefined

  // The mate went away by some path other than the editor's delete button (an
  // undo, a reload). Its editor has already unmounted, so nothing is left to
  // disarm the chip: the viewport would stay in aiming mode with picks writing
  // into a feature that no longer exists.
  useEffect(() => {
    if (doc && selectedMateId && !selectedMate) {
      useAssemblyStore.getState().setSelectedMateId(null)
      // editingMateId is left as-is: no row matches a vanished mate's id, so its
      // editor is already gone. It is overwritten the next time one is edited.
    }
  }, [doc, selectedMateId, selectedMate])

  // The selected part handle can name an instance the doc no longer has: an
  // undo, a reload, or a live edit that removed it without routing through the
  // tree's delete (which clears the selection itself). Consumers no-op on a
  // missing instance, but the dangling handle is exactly the class the mate-id
  // effect above was built for, so it clears for the same reason.
  useEffect(() => {
    if (doc && selectedPartHandle && !findInstance(doc, selectedPartHandle)) {
      useAssemblyStore.getState().setSelectedPartHandle(null)
    }
  }, [doc, selectedPartHandle])

  const renderInstanceEditor = useCallback((inst: PartInstance) => (
    <PartInstanceEditor
      instance={inst}
      onSetFixed={f => handleSetFixed(inst.handle, f)}
      onSetPosition={pos => handleSetPosition(inst.handle, pos)}
      onSetRotation={euler => handleSetRotation(inst.handle, euler)}
    />
  ), [handleSetFixed, handleSetPosition, handleSetRotation])

  const renderMateEditor = useCallback((mate: { id: string; mate: MateFeatureDef }) => (
    <MateEditor
      featureId={mate.id}
      mate={mate.mate}
      result={mateResults[mate.id]}
      activeField={activeMateField}
      labelFor={labelFor}
      onArmField={handleArmMateField}
      onUpdate={patch => handleUpdateMate(mate.id, patch)}
    />
  ), [mateResults, activeMateField, labelFor, handleArmMateField, handleUpdateMate])

  if (loading) {
    return <div className="document-viewer"><p>Loading...</p></div>
  }

  return (
    <div className="document-viewer">
      <AssemblyToolbar
        readOnly={readOnly}
        docName={docName}
        onRename={handleRename}
        handleSave={handleSave}
        handleClone={handleClone}
      />
      <div className="doc-container">
        <aside className="doc-sidebar">
          <AssemblyTree
            instances={instances}
            builtins={builtins}
            mates={mates}
            mateResults={mateResults}
            labelFor={labelFor}
            selectedHandle={selectedPartHandle}
            selectedMateId={selectedMateId}
            editingMateId={editingMateId}
            editingInstanceHandle={editingInstanceHandle}
            onSelectPart={handleSelect}
            onReorderInstance={handleReorderInstance}
            onReorderMate={handleReorderMate}
            onOpenPartNewTab={handleOpenPartNewTab}
            onDuplicateInstance={handleDuplicate}
            onDeleteInstance={handleDelete}
            onToggleVisible={handleToggleVisible}
            onToggleFixed={handleToggleFixed}
            onToggleBuiltinVisible={handleToggleBuiltinVisible}
            onEditInstance={handleEditInstance}
            onCommitInstance={handleCommitInstance}
            onCancelInstance={handleCancelInstance}
            renderInstanceEditor={renderInstanceEditor}
            onSelectMate={handleSelectMate}
            onEditMate={handleEditMate}
            onCommitMate={handleCommitMate}
            onCancelMate={handleCancelMate}
            onDeleteMate={handleDeleteMate}
            onRequestRenameMate={(id, currentName) => setRenameMateTarget({ id, currentName })}
            renderMateEditor={(m) => renderMateEditor(m)}
          />
        </aside>
        <div className="doc-editor">
          <div className="editor-toolbar">
            <button
              className="editor-btn"
              title="Insert part"
              aria-label="Insert part"
              onClick={openPicker}
              disabled={readOnly}
            >
              <img src={featurePartIcon} alt="Insert part" />
            </button>
            <div className="toolbar-separator" />
            {MATE_KINDS.map(kind => (
              <button
                key={kind}
                className="editor-btn"
                title={`Insert ${MATE_KIND_LABELS[kind]} mate`}
                aria-label={`Insert ${MATE_KIND_LABELS[kind]} mate`}
                onClick={() => handleInsertMate(kind)}
                disabled={readOnly}
              >
                <img src={MATE_KIND_ICONS[kind]} alt={MATE_KIND_LABELS[kind]} />
              </button>
            ))}
            <div className="toolbar-separator" />
            <button
              className="editor-btn"
              title="Export assembly"
              aria-label="Export assembly"
              onClick={openExport}
            >
              <img src={exportIcon} alt="Export assembly" />
            </button>
          </div>
          <div className="assembly-viewport-host">
            <AssemblyViewport ref={viewportRef} />
            {/* The assembly solve mirrors useSolverStore.isSolving and claims its
                onCancelSolve slot, so the shared overlay renders the spinner and
                cancel for a full (non-live) solve; it is opacity-0 when idle. */}
            <LoadingOverlay />
            {(solveError || error) && (
              <ErrorBanner
                message={solveError ? `Solver error: ${solveError}` : `Error: ${error}`}
                onDismiss={() => {
                  useAssemblyStore.getState().setSolveError(null)
                  setError(null)
                }}
              />
            )}
            {instances.length === 0 && mates.length === 0 && (
              <p className="assembly-empty-hint">Empty assembly - insert parts to get started.</p>
            )}
          </div>
        </div>
      </div>
      <footer className="doc-footer">
        <p>Copyright 2026 - Oversolved</p>
        <AssemblyMeasurementDisplay measurementIcon={measurementIcon} />
        <div className="debug-buttons">
          <button
            className="footer-debug-btn"
            title={showPickDebug ? 'Hide debug collision rendering' : 'Show debug collision rendering'}
            onClick={() => useAssemblyStore.getState().setShowPickDebug(!showPickDebug)}
          >
            {showPickDebug ? (
              <span className="material-icons-outlined">visibility</span>
            ) : (
              <span className="material-icons-outlined">visibility_off</span>
            )}
          </button>
        </div>
      </footer>
      <AssemblyPartPicker
        isOpen={pickerOpen}
        selfUuid={uuid}
        onClose={() => setPickerOpen(false)}
        onPick={handlePick}
      />
      <RenameDialog
        isOpen={renameMateTarget !== null}
        title="Rename Mate"
        currentName={renameMateTarget?.currentName ?? ''}
        onRename={handleRenameMateConfirm}
        onCancel={() => setRenameMateTarget(null)}
      />
      <AssemblyExport ref={exportRef} doc={doc} docName={docName} />
    </div>
  )
}
