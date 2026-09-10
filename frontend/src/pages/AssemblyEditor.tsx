import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { errorMessage } from '@/utils/core/errorMessage'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, setAssemblyCallbacks, DEFAULT_ASSEMBLY_EDITOR_DATA, type MateFieldTarget } from '@/stores/assemblyStore'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import LoadingOverlay from '@/components/dialogs/LoadingOverlay'
import AssemblyViewport, { type AssemblyViewportHandle } from '@/components/Viewport/AssemblyViewport'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { useAssemblyCommands } from '@/pages/AssemblyKeyboardShortcuts'
import { insertMateCommand, type AssemblyCommandHandlers } from '@/pages/assemblyCommandEntries'
import { editingInstanceHandle as editingInstanceHandleOf, editingMateId as editingMateIdOf } from '@/utils/assemblyEditingSubject'
import {
  findInstance,
  findMate,
  mintFeatureId,
} from '@/utils/assemblyMutations'
import { runAssemblyOperation, type AssemblyOperationId } from '@/utils/assemblyOperations'
import { executeCommand } from '@/utils/core/commandRegistry'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import { MateEditor } from '@/components/layout/MateEditor'
import { PartInstanceEditor } from '@/components/layout/PartInstanceEditor'
import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'
import RenameDialog from '@/components/dialogs/RenameDialog'
import AssemblyExport, { type AssemblyExportHandle } from '@/pages/AssemblyExport'
import { backendBundle } from '@/adapters/backend'
import { getAssemblyBuiltins } from '@/utils/assemblyRender'
import { assemblyVerdict } from '@/utils/core/assemblyStatus'
import { MATE_KINDS, MATE_KIND_LABELS } from '@/utils/mateKinds'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import AssemblyMeasurementDisplay from '@/components/layout/AssemblyMeasurementDisplay'
import type { MateKind, MateFeatureDef, PartInstance } from '@/types/cad'
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
    saveDoc,
    renameDoc,
    cloneDoc,
  } = useAssemblyDoc(uuid)
  const navigate = useNavigate()
  const [pickerOpen, setPickerOpen] = useState(false)
  // The mate the tridot menu asked to rename, with the name the row was showing
  // so the dialog opens pre-filled even when the mate has no explicit label.
  const [renameMateTarget, setRenameMateTarget] = useState<{ id: string; currentName: string } | null>(null)
  const { requestSolve } = useAssemblySolve(uuid, doc)
  const {
    commitSession,
    cancelSession,
    mutate,
    mutateOneShot,
    handleUndo,
    handleRedo,
  } = useAssemblyUndoRedo(docRef, setDoc, requestSolve)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)
  const selectedMateId = useAssemblyStore(s => s.selectedMateId)
  const activeMateField = useAssemblyStore(s => s.activeMateField)
  const solveStatus = useAssemblyStore(s => s.solveStatus)
  const showPickDebug = useAssemblyStore(s => s.showPickDebug)
  // One store-owned tagged subject instead of two useState ids. The selectors
  // are the only place "which editor is open" is read.
  const editingSubject = useAssemblyStore(s => s.editingSubject)
  const editingMateId = editingMateIdOf(editingSubject)
  const editingInstanceHandle = editingInstanceHandleOf(editingSubject)

  // Part document names, so the tree shows 'Bracket' rather than the raw uuid.
  // A failed list is swallowed on purpose: names are a nicety here and the tree
  // falls back to the uuid, which is worse to read but never wrong.
  const [docNames, setDocNames] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    backendBundle.documents.list()
      .then(list => {
        if (cancelled) return
        const map: Record<string, string> = {}
        for (const d of list) map[d.uuid] = d.name
        setDocNames(map)
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

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

  // The store owns the drag/gizmo state machine but not the document; give it
  // the hook's doc mutators and the one-solve-per-pointer-up trigger. Drag
  // commits and [Delete] deletes are one-shot, ref picks fold into the open
  // edit session.
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
  // instances, mates, bodies, transforms, edgeCurves, anchors, pickGeometry)
  // untouched, since those are React-mirrored via setSnapshot,
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
  const handleSave = useCallback(async () => {
    // Capture a thumbnail of the solved scene on save, like the part editor. The
    // capturer is optional: the save still proceeds when the viewport is absent.
    // The boolean rides back to the toolbar so a failed save never flashes its
    // saved check.
    if (!uuid || !doc) return false
    return saveDoc(uuid, doc, viewportRef.current?.captureScreenshotForSaving)
  }, [uuid, doc, saveDoc])

  // Declared after handleSave so the header's "Save & Exit" gets the real
  // function rather than a temporal-dead-zone reference.
  useUnsavedChangesGuard(handleSave)

  const handleClone = useCallback(async () => {
    if (!uuid) return
    try {
      const data = await cloneDoc(uuid)
      navigate(`/documents/${data.uuid}`)
    } catch (e) {
      setError(errorMessage(e, 'Failed to clone document'))
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
    commitSession()
    useAssemblyStore.getState().closeEditor()
  }, [commitSession])

  // Run a table operation against the live doc and the page's effects. The
  // operation decides bake/undo/solve; the page only supplies the context.
  const runOperation = useCallback((id: AssemblyOperationId, payload: unknown) => {
    runAssemblyOperation(id, payload as never, {
      doc: docRef.current,
      transforms: useAssemblyStore.getState().settledPoses(),
      mutateSession: mutate,
      mutateOneShot,
      requestSolve,
      requestSolveOrDefer: () => useAssemblyStore.getState().requestSolveOrDefer(),
    })
  }, [docRef, mutate, mutateOneShot, requestSolve])

  // Insert a mate with both references empty, open its editor and arm ref_a, so
  // the very next click in the viewport aims the first reference. No solve yet:
  // an unreferenced mate has nothing to constrain. The append is a structural
  // one-shot, so cancelling the fresh editor can never lose the insert, and the
  // previously open editor is closed first so the new mate never folds into its
  // coalescing session.
  const handleInsertMate = useCallback((kind: MateKind) => {
    const id = mintFeatureId()
    closeOpenEditor()
    runOperation('add_mate', { kind, id })
    const store = useAssemblyStore.getState()
    store.setSelectedMateId(id)
    store.openMateEditor(id)  // a fresh mate opens straight into its editor
    store.setActiveMateField({ featureId: id, field: 'ref_a' })
  }, [runOperation, closeOpenEditor])

  // The [Delete] key maps to `delete_selected`; the store decides whether that
  // is the selected mate or the selected part and closes its editor when it is
  // the deleted subject.
  const handleDeleteSelected = useCallback(() => {
    useAssemblyStore.getState().deleteSelected()
  }, [])

  // Ctrl+Z / Ctrl+Shift+Z land here via the assembly keymap. Undo always exits
  // an open editor: the hook's restore resets the store-owned editing subject,
  // and the coalesced session is dropped by the hook itself.
  const handleUndoCommand = handleUndo
  const handleRedoCommand = handleRedo

  const handlePick = useCallback((docId: string, docRev: number) => {
    executeCommand('add_part', { docId, docRev })
  }, [])

  const handleOpenPartNewTab = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (inst) window.open(`/documents/${inst.doc_id}`, '_blank')
  }, [instances])

  const handleDelete = useCallback((handle: string) => {
    runOperation('delete_part', handle)
    const store = useAssemblyStore.getState()
    if (store.selectedPartHandle === handle) store.setSelectedPartHandle(null)
    if (store.editingSubject.kind === 'instance' && store.editingSubject.handle === handle) store.closeEditor()
  }, [runOperation])

  const handleSelect = useCallback((handle: string) => {
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [])

  // Instance edit: open the inline editor and attach the gizmo to the part being
  // edited. Switching editors commits any open session so each edited subject's
  // changes land in their own step. Cancel needs no snapshot of the instance:
  // the hook pins the whole pre-session doc on the session's first edit.
  const handleEditInstance = useCallback((handle: string) => {
    closeOpenEditor()
    useAssemblyStore.getState().openInstanceEditor(handle)
    useAssemblyStore.getState().setSelectedPartHandle(handle)
  }, [closeOpenEditor])

  const handleCommitInstance = useCallback(() => {
    // Accept closes the coalescing session: every live position/rotation/fixed
    // edit lands as one undo step.
    commitSession()
    useAssemblyStore.getState().closeEditor()
  }, [commitSession])

  const handleCancelInstance = useCallback(() => {
    // The rewind belongs to the session, not to the edited instance: every one
    // of this editor's controls bakes EVERY non-fixed instance's solved pose
    // into its seed, so restoring the edited instance alone would leave those
    // rewritten seeds behind with no undo entry and a clean dirty flag.
    cancelSession()
    useAssemblyStore.getState().closeEditor()
    requestSolve()  // undo any live position/fixed edit
  }, [requestSolve, cancelSession])

  // A plain row click selects the mate: it highlights the row without opening
  // the editor. Selecting away from a mate mid-edit commits that editor's
  // session (Cancel is the explicit revert) and closes it.
  const handleSelectMate = useCallback((featureId: string) => {
    const store = useAssemblyStore.getState()
    if (store.editingSubject.kind === 'mate' && store.editingSubject.id !== featureId) {
      commitSession()
      store.closeEditor()
    }
    store.setSelectedMateId(featureId)
  }, [commitSession])

  // The pencil opens the inline editor. Switching editors commits any open
  // session so each mate's edits land in their own step; that commit is also
  // what leaves this mate's own session unpinned, so its Cancel rewinds to the
  // doc as it opens here.
  const handleEditMate = useCallback((featureId: string) => {
    closeOpenEditor()
    const store = useAssemblyStore.getState()
    store.setSelectedMateId(featureId)
    store.openMateEditor(featureId)
  }, [closeOpenEditor])

  // Accept: leaving the mate disarms its field, which settles the owed solve,
  // and the coalesced session commits as one undo step.
  const handleCommitMate = useCallback(() => {
    commitSession()
    const store = useAssemblyStore.getState()
    store.closeEditor()
    store.setSelectedMateId(null)
  }, [commitSession])

  const handleCancelMate = useCallback(() => {
    const store = useAssemblyStore.getState()
    store.setActiveMateField(null)  // stop aiming before we rewrite the slots
    // Whole-session rewind, same as the instance editor's Cancel: nothing on the
    // mate path bakes today, but a partial revert of the mate def alone is the
    // shape that let the instance editor's bakes escape, so it is not repeated.
    cancelSession()
    store.closeEditor()
    store.setSelectedMateId(null)
    requestSolve()  // restore the solved pose the reverted refs imply
  }, [requestSolve, cancelSession])

  const handleDeleteMate = useCallback((featureId: string) => {
    runOperation('delete_mate', featureId)
    const store = useAssemblyStore.getState()
    if (store.selectedMateId === featureId) store.setSelectedMateId(null)
    if (store.editingSubject.kind === 'mate' && store.editingSubject.id === featureId) store.closeEditor()
  }, [runOperation])

  const handleRenameMate = useCallback((featureId: string, label: string | undefined) => {
    runOperation('rename_mate', { id: featureId, label })
  }, [runOperation])

  // The dialog already trims and refuses an empty name, so whatever arrives here
  // is a label worth writing.
  const handleRenameMateConfirm = useCallback((label: string) => {
    if (!renameMateTarget) return
    handleRenameMate(renameMateTarget.id, label)
    setRenameMateTarget(null)
  }, [renameMateTarget, handleRenameMate])

  // Escape (assembly keymap's cancel_edit) closes whichever editor is open by
  // routing to its Cancel, which rewinds the session.
  const handleCancelEdit = useCallback(() => {
    const subject = useAssemblyStore.getState().editingSubject
    if (subject.kind === 'instance') handleCancelInstance()
    else if (subject.kind === 'mate') handleCancelMate()
  }, [handleCancelInstance, handleCancelMate])

  // Every document operation routes through runOperation; the UI-only commands
  // (picker, export, undo/redo/delete, cancel) keep their own handlers. The mate
  // insert commands carry the kind in the name and open the fresh mate's editor.
  const assemblyHandlers = useMemo<AssemblyCommandHandlers>(() => ({
    undo: handleUndoCommand,
    redo: handleRedoCommand,
    delete_selected: handleDeleteSelected,
    cancel_edit: handleCancelEdit,
    export_assembly: openExport,
    insert_part_instance: openPicker,
    add_part: (payload) => runOperation('add_part', payload),
    duplicate_part: (payload) => runOperation('duplicate_part', payload),
    delete_part: (payload) => handleDelete(payload as string),
    set_part_visible: (payload) => runOperation('set_part_visible', payload),
    set_builtin_visible: (payload) => runOperation('set_builtin_visible', payload),
    set_part_fixed: (payload) => runOperation('set_part_fixed', payload),
    set_part_fixed_oneshot: (payload) => runOperation('set_part_fixed_oneshot', payload),
    set_part_position: (payload) => runOperation('set_part_position', payload),
    set_part_rotation: (payload) => runOperation('set_part_rotation', payload),
    delete_mate: (payload) => handleDeleteMate(payload as string),
    update_mate: (payload) => runOperation('update_mate', payload),
    reorder_part: (payload) => runOperation('reorder_part', payload),
    reorder_mate: (payload) => runOperation('reorder_mate', payload),
    rename_mate: (payload) => runOperation('rename_mate', payload),
    ...Object.fromEntries(MATE_KINDS.map(kind => [insertMateCommand(kind), () => handleInsertMate(kind)])),
  }), [
    handleUndoCommand, handleRedoCommand, handleDeleteSelected, handleCancelEdit,
    openExport, openPicker, runOperation, handleDelete, handleDeleteMate, handleInsertMate,
  ])
  useAssemblyCommands(assemblyHandlers)

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
      onSetFixed={f => executeCommand('set_part_fixed', { handle: inst.handle, fixed: f })}
      onSetPosition={pos => executeCommand('set_part_position', { handle: inst.handle, pos })}
      onSetRotation={euler => executeCommand('set_part_rotation', { handle: inst.handle, euler })}
    />
  ), [])

  const renderMateEditor = useCallback((mate: { id: string; mate: MateFeatureDef }) => (
    <MateEditor
      featureId={mate.id}
      mate={mate.mate}
      result={solveStatus?.mates[mate.id]}
      activeField={activeMateField}
      labelFor={labelFor}
      onArmField={handleArmMateField}
      onUpdate={patch => executeCommand('update_mate', { id: mate.id, patch })}
    />
  ), [solveStatus, activeMateField, labelFor, handleArmMateField])

  // The banner names the unsatisfiable mates by their authored label when they
  // have one, falling back to the feature id.
  const mateNameFor = useCallback(
    (id: string) => mates.find(m => m.id === id)?.mate.label || undefined,
    [mates],
  )
  const verdict = assemblyVerdict(solveStatus, mateNameFor)

  if (loading) {
    return <div className="document-viewer"><p>Loading...</p></div>
  }

  return (
    <div className="document-viewer">
      <AssemblyToolbar
        docName={docName}
        onRename={handleRename}
        handleSave={handleSave}
        handleClone={handleClone}
        rightContent={
          <button
            className="toolbar-btn"
            aria-label="Toggle debug collision rendering"
            title={showPickDebug ? 'Hide debug collision rendering' : 'Show debug collision rendering'}
            onClick={() => useAssemblyStore.getState().setShowPickDebug(!showPickDebug)}
          >
            <span className="material-icons-outlined">{showPickDebug ? 'visibility' : 'visibility_off'}</span>
          </button>
        }
      />
      <div className="doc-container">
        <aside className="doc-sidebar">
          <AssemblyTree
            instances={instances}
            builtins={builtins}
            mates={mates}
            status={solveStatus}
            labelFor={labelFor}
            selectedHandle={selectedPartHandle}
            selectedMateId={selectedMateId}
            editingMateId={editingMateId}
            editingInstanceHandle={editingInstanceHandle}
            onSelectPart={handleSelect}
            onReorderInstance={(movingHandle, beforeHandle) => executeCommand('reorder_part', { movingHandle, beforeHandle })}
            onReorderMate={(movingId, beforeId) => executeCommand('reorder_mate', { movingId, beforeId })}
            onOpenPartNewTab={handleOpenPartNewTab}
            onDuplicateInstance={(handle) => executeCommand('duplicate_part', handle)}
            onDeleteInstance={(handle) => executeCommand('delete_part', handle)}
            onToggleVisible={(handle, visible) => executeCommand('set_part_visible', { handle, visible })}
            onToggleFixed={(handle, fixed) => executeCommand('set_part_fixed_oneshot', { handle, fixed })}
            onToggleBuiltinVisible={(id, visible) => executeCommand('set_builtin_visible', { id, visible })}
            onEditInstance={handleEditInstance}
            onCommitInstance={handleCommitInstance}
            onCancelInstance={handleCancelInstance}
            renderInstanceEditor={renderInstanceEditor}
            onSelectMate={handleSelectMate}
            onEditMate={handleEditMate}
            onCommitMate={handleCommitMate}
            onCancelMate={handleCancelMate}
            onDeleteMate={(featureId) => executeCommand('delete_mate', featureId)}
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
              onClick={() => executeCommand('insert_part_instance')}
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
                onClick={() => executeCommand(insertMateCommand(kind))}
              >
                <img src={MATE_KIND_ICONS[kind]} alt={MATE_KIND_LABELS[kind]} />
              </button>
            ))}
            <div className="toolbar-separator" />
            <button
              className="editor-btn"
              title="Export assembly"
              aria-label="Export assembly"
              onClick={() => executeCommand('export_assembly')}
            >
              <img src={exportIcon} alt="Export assembly" />
            </button>
          </div>
          <div className="assembly-viewport-host">
            <AssemblyViewport
              ref={viewportRef}
              hud={<AssemblyMeasurementDisplay measurementIcon={measurementIcon} />}
            />
            {/* The assembly solve mirrors useSolverStore.isSolving and claims its
                onCancelSolve slot, so the shared overlay renders the spinner and
                cancel for a full (non-live) solve; it is opacity-0 when idle. */}
            <LoadingOverlay />
            {(verdict.failed || error) && (
              <ErrorBanner
                message={verdict.failed ? `Solver error: ${verdict.message}` : `Error: ${error}`}
                onDismiss={() => {
                  // Retire only the verdict the banner reads; the per-mate and
                  // per-part row marks stay, exactly as the old solveError clear
                  // left mateResults in place.
                  const current = useAssemblyStore.getState().solveStatus
                  useAssemblyStore.setState({
                    solveStatus: current ? { ...current, verdict: 'none', error: undefined } : null,
                  })
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
