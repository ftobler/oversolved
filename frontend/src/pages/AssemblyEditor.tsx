import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useAssemblyStore, setAssemblyCallbacks, type MateFieldTarget } from '@/stores/assemblyStore'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
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
  bakeSolvedTransforms,
  duplicateInstance,
  findInstance,
  findMate,
  mintFeatureId,
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
import type { AssemblyDoc, MateKind, MateFeatureDef, PartInstance, AssemblyFeature } from '@/types/cad'
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

function extractInstances(features: AssemblyFeature[] | undefined): PartInstance[] {
  return (features ?? [])
    .filter((f): f is AssemblyFeature & { instance: PartInstance } => f.kind === 'part_instance' && !!f.instance)
    .map(f => f.instance!)
}

export default function AssemblyEditor({ uuid }: { uuid: string }) {
  const {
    doc,
    setDoc,
    loading,
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

  useEffect(() => {
    if (doc) {
      useAssemblyStore.getState().setSnapshot({
        ...useAssemblyStore.getState(),
        doc,
        instances: extractInstances(doc.features),
        mates,
      })
    }
  }, [doc, instances, mates])

  // Apply a pure AssemblyDoc mutation, push it into the hook's doc state, and
  // flag the document dirty. The store re-syncs via the effect above.
  const mutate = useCallback((fn: (d: AssemblyDoc) => AssemblyDoc) => {
    setDoc(prev => (prev ? fn(prev) : prev))
    useUnsavedChangesStore.getState().setDirty(true)
  }, [setDoc])

  useUnsavedChangesGuard()

  // The store owns the drag/gizmo state machine but not the document; give it
  // the doc mutator and the one-solve-per-pointer-up trigger.
  useEffect(() => {
    setAssemblyCallbacks({ mutateDoc: mutate, requestSolve })
    return () => setAssemblyCallbacks(null)
  }, [mutate, requestSolve])

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
    const data = await cloneDoc(uuid)
    navigate(`/documents/${data.uuid}`)
  }, [uuid, cloneDoc, navigate])

  const handleRename = useCallback(
    (name: string) => renameDoc(uuid, name),
    [renameDoc, uuid],
  )

  // Insert a mate with both references empty, open its editor and arm ref_a, so
  // the very next click in the viewport aims the first reference. No solve yet:
  // an unreferenced mate has nothing to constrain. The snapshot is the empty
  // mate, so Cancel restores it to that pre-edit state.
  const handleInsertMate = useCallback((kind: MateKind) => {
    const id = mintFeatureId()
    mateSnapshot.current = {
      id,
      def: { kind, ref_a: { ...EMPTY_MATE_REF }, ref_b: { ...EMPTY_MATE_REF } },
    }
    mutate(d => appendMate(d, kind, id))
    const store = useAssemblyStore.getState()
    store.setSelectedMateId(id)
    setEditingMateId(id)  // a fresh mate opens straight into its editor to pick refs
    store.setActiveMateField({ featureId: id, field: 'ref_a' })
  }, [mutate])

  const commands = useMemo(() => [
    { name: 'insert_part_instance', fn: openPicker },
    { name: 'export_assembly', fn: openExport },
    ...MATE_KINDS.map(kind => ({ name: `insert_mate_${kind}`, fn: () => handleInsertMate(kind) })),
  ], [openPicker, openExport, handleInsertMate])
  useCommandRegistration(commands)

  const handlePick = useCallback((docId: string, docRev: number) => {
    // Bake the placed parts' solved poses into their seeds before adding one, so
    // the re-solve that pulls in the new part keeps the existing assembly where
    // it is on screen rather than restarting the whole solve from stale seeds.
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => appendPartInstance(bakeSolvedTransforms(d, transforms), docId, docRev))
    requestSolve()  // the new instance has no bodies until the assembly re-solves
  }, [mutate, requestSolve])

  const handleDuplicate = useCallback((handle: string) => {
    // Same baking rule as inserting a part: the copy is a new unmated body, so
    // without freezing the solved poses first the re-solve would restart the
    // placed parts from stale seeds and visibly shuffle the assembly.
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => duplicateInstance(bakeSolvedTransforms(d, transforms), handle))
    requestSolve()  // the copy has no bodies until the assembly re-solves
  }, [mutate, requestSolve])

  const handleOpenPartNewTab = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (inst) window.open(`/documents/${inst.doc_id}`, '_blank')
  }, [instances])

  const handleDelete = useCallback((handle: string) => {
    // Freeze the on-screen poses first (same reason as handleDeleteMate):
    // removing a part frees the mates that referenced it, so a re-solve straight
    // from the stale placement seeds could snap the remaining parts back to their
    // drop spots. Baked first, only the freed DOF relaxes.
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => removeInstance(bakeSolvedTransforms(d, transforms), handle))
    if (useAssemblyStore.getState().selectedPartHandle === handle) {
      useAssemblyStore.getState().setSelectedPartHandle(null)
    }
    if (editingInstanceHandle === handle) setEditingInstanceHandle(null)
    requestSolve()  // the removed instance's bodies must leave the scene
  }, [mutate, requestSolve, editingInstanceHandle])

  const handleToggleVisible = useCallback((handle: string, visible: boolean) => {
    mutate(d => setInstanceVisible(d, handle, visible))
  }, [mutate])

  // Showing/hiding a reference plane is a pure render change: no re-solve, since
  // the assembly frame is pinned at the world origin and constrains nothing.
  const handleToggleBuiltinVisible = useCallback((id: string, visible: boolean) => {
    mutate(d => setBuiltinVisible(d, id, visible))
  }, [mutate])

  // Ground/unground a part without moving anything on screen, including the
  // camera. Grounding a part that is already in place adds no geometric
  // constraint (the part is at its solved pose), so the current view is already
  // correct and there is nothing to re-solve. Re-solving would only risk drift:
  // with no fixed anchor the mate solver has gauge freedom and can slide the
  // whole assembly along zero-gradient directions, which reads as the camera
  // jumping. So we do NOT re-solve here; we only flip the flag.
  //
  // We still bake every part's current solved pose into its seed. That keeps the
  // doc's seeds in step with what is on screen, so the next real solve (a drag,
  // a mate edit) starts from the current configuration instead of stale seeds
  // and the new ground state takes effect cleanly then.
  const fixOrUnfix = useCallback((handle: string, fixed: boolean) => {
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => setInstanceFixedFromSolved(d, handle, fixed, transforms))
  }, [mutate])

  const handleToggleFixed = fixOrUnfix

  const handleSelect = useCallback((handle: string) => {
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [])

  // Instance edit: snapshot for revert, open the inline editor, and attach the
  // gizmo to the part being edited.
  const handleEditInstance = useCallback((handle: string) => {
    const inst = doc ? findInstance(doc, handle) : undefined
    instanceSnapshot.current = inst ? { handle, inst: { ...inst } } : null
    setEditingInstanceHandle(handle)
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [doc])

  const handleCommitInstance = useCallback(() => {
    instanceSnapshot.current = null
    setEditingInstanceHandle(null)
  }, [])

  const handleCancelInstance = useCallback(() => {
    const snap = instanceSnapshot.current
    if (snap) mutate(d => replaceInstance(d, snap.handle, snap.inst))
    instanceSnapshot.current = null
    setEditingInstanceHandle(null)
    requestSolve()  // undo any live position/ground edit
  }, [mutate, requestSolve])

  const handleSetFixed = fixOrUnfix

  const handleSetPosition = useCallback((handle: string, pos: { tx: number; ty: number; tz: number }) => {
    // Bake first, then apply the reseat: the manual position overrides only the
    // edited part, while every other part's seed is refreshed to its solved pose
    // so the re-solve does not drag the rest of the assembly off screen from
    // stale seeds. Baking before setInstancePosition also lets the edited part
    // keep its solved orientation rather than the stale seed's.
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => setInstancePosition(bakeSolvedTransforms(d, transforms), handle, pos))
    requestSolve()
  }, [mutate, requestSolve])

  // Same bake-then-reseat discipline as the position edit. This is the only
  // orientation control a GROUNDED part has (the triad gizmo refuses one), so
  // it must not be vetoed by the ground flag -- setInstanceRotation is the
  // mutation that ignores it.
  const handleSetRotation = useCallback((handle: string, euler: EulerDeg) => {
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => setInstanceRotation(bakeSolvedTransforms(d, transforms), handle, euler))
    requestSolve()
  }, [mutate, requestSolve])

  // A plain row click selects the mate: it highlights (and, going forward, will
  // light up its two parts and mated geometry in the viewport). It does not open
  // the editor. Selecting away from a mate mid-edit closes that editor, keeping
  // whatever live edits were made (Cancel is the explicit revert).
  const handleSelectMate = useCallback((featureId: string) => {
    if (editingMateId && editingMateId !== featureId) {
      mateSnapshot.current = null
      setEditingMateId(null)
    }
    useAssemblyStore.getState().setSelectedMateId(featureId)
  }, [editingMateId])

  // The pencil opens the inline editor. Snapshot the current def so Cancel
  // reverts. Insert already primed the snapshot for the mate it created.
  const handleEditMate = useCallback((featureId: string) => {
    if (mateSnapshot.current?.id !== featureId) {
      const def = doc ? findMate(doc, featureId) : undefined
      mateSnapshot.current = def ? { id: featureId, def: { ...def } } : null
    }
    useAssemblyStore.getState().setSelectedMateId(featureId)
    setEditingMateId(featureId)
  }, [doc])

  // Accept: leaving the mate disarms its field, which settles the owed solve.
  const handleCommitMate = useCallback(() => {
    mateSnapshot.current = null
    setEditingMateId(null)
    useAssemblyStore.getState().setSelectedMateId(null)
  }, [])

  const handleCancelMate = useCallback(() => {
    const snap = mateSnapshot.current
    const store = useAssemblyStore.getState()
    store.setActiveMateField(null)  // stop aiming before we rewrite the slots
    if (snap) mutate(d => replaceMate(d, snap.id, snap.def))
    mateSnapshot.current = null
    setEditingMateId(null)
    store.setSelectedMateId(null)
    requestSolve()  // restore the solved pose the reverted refs imply
  }, [mutate, requestSolve])

  const handleDeleteMate = useCallback((featureId: string) => {
    // Freeze the on-screen configuration into the seeds before dropping the
    // constraint. The doc's seeds are stale (only a dragged part's seed is
    // written back), so re-solving straight from them would restart the mate
    // solver at the placement poses and snap every part -- especially the one the
    // deleted mate positioned -- back to its drop spot, reading as parts
    // vanishing. Baked first, the re-solve relaxes only the freed DOF.
    const transforms = useAssemblyStore.getState().transforms
    mutate(d => removeMate(bakeSolvedTransforms(d, transforms), featureId))
    mateSnapshot.current = null
    setEditingMateId(null)
    useAssemblyStore.getState().setSelectedMateId(null)
    requestSolve()  // the freed DOF must let the parts settle back
  }, [mutate, requestSolve])

  const handleUpdateMate = useCallback((featureId: string, patch: MateParamPatch) => {
    // A mate parameter edit (offset, angle, flip, ratio, radius) does not
    // move any part on its own — the solve is the only thing that may move
    // them.  Baking the current solved transforms into the part seeds here
    // would incorporate the previous solve's roll into the new seed, and
    // the solver's seed-relative angle (mate_residuals.rs) would then add
    // the new angle on top of that, accumulating every time the user types
    // a new value.  The part seeds stay at whatever the last position
    // change (drag, ground toggle, mate deletion) wrote; a mate param edit
    // only changes what the solver targets from that same seed.
    mutate(d => updateMate(d, featureId, patch))
    // Deferred while a chip is armed: a solve here would drop the candidate set
    // the armed field is still cycling.
    useAssemblyStore.getState().requestSolveOrDefer()
  }, [mutate])

  // Renaming is a pure label edit: no solve, it constrains nothing.
  const handleRenameMate = useCallback((featureId: string, label: string | undefined) => {
    mutate(d => setMateLabel(d, featureId, label))
  }, [mutate])

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
            {solveError && (
              <ErrorBanner
                message={`Solver error: ${solveError}`}
                onDismiss={() => useAssemblyStore.getState().setSolveError(null)}
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
