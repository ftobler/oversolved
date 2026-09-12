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
import { buildAssemblyHandlers, insertMateCommand, type AssemblyCommandHandlers } from '@/pages/assemblyCommandEntries'
import { editingInstanceHandle as editingInstanceHandleOf, editingMateId as editingMateIdOf } from '@/utils/assemblyEditingSubject'
import {
  findInstance,
  findMate,
  mintFeatureId,
} from '@/utils/assemblyMutations'
import { runAssemblyOperation, type AssemblyOperationId } from '@/utils/assemblyOperations'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { interpretEntry } from '@/workspace/kinds'
import type { AssemblySubject } from '@/utils/assemblySelection'
import { executeCommand } from '@/utils/core/commandRegistry'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import { Sidebar } from '@/components/layout/Sidebar'
import { MateEditor } from '@/components/layout/MateEditor'
import { PartInstanceEditor } from '@/components/layout/PartInstanceEditor'
import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'
import RenameDialog from '@/components/dialogs/RenameDialog'
import AssemblyExport, { type AssemblyExportHandle } from '@/pages/AssemblyExport'
import { getAssemblyBuiltins } from '@/utils/assemblyRender'
import { assemblyVerdict } from '@/utils/core/assemblyStatus'
import { MATE_KINDS, MATE_KIND_LABELS } from '@/utils/mateKinds'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import AssemblyMeasurementDisplay from '@/components/layout/AssemblyMeasurementDisplay'
import type { MateKind, MateFeatureDef, PartInstance, Transform3D } from '@/types/cad'
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

export default function AssemblyEditor({ uuid, workspaceId }: { uuid: string; workspaceId?: string }) {
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
  } = useAssemblyDoc(uuid, workspaceId)
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
  // One store-owned tagged subject instead of two independent ids: the part
  // handle and the mate id are read off its two arms, so both can never be live.
  const subject = useAssemblyStore(s => s.subject)
  const selectedPartHandle = subject?.kind === 'part' ? subject.handle : null
  const selectedMateId = subject?.kind === 'mate' ? subject.id : null
  const activeMateField = useAssemblyStore(s => s.activeMateField)
  const solveStatus = useAssemblyStore(s => s.solveStatus)
  const showPickDebug = useAssemblyStore(s => s.showPickDebug)
  // One store-owned tagged subject instead of two useState ids. The selectors
  // are the only place "which editor is open" is read.
  const editingSubject = useAssemblyStore(s => s.editingSubject)
  const editingMateId = editingMateIdOf(editingSubject)
  const editingInstanceHandle = editingInstanceHandleOf(editingSubject)

  // The pose basis each instance editor was opened against. Frozen so a
  // background solve cannot move the number fields the user is typing in;
  // recaptured when a different instance is edited. The operation bake reads
  // the live settledPoses() fresh, so the frozen fields and the committed pose
  // are allowed to differ while a solve is still settling.
  const [poseBasis, setPoseBasis] = useState<{ handle: string; pose?: Transform3D } | null>(null)

  // The open workspace session, installed by WorkspacePage. The tree labels
  // parts from it and the add_part guard checks its live part entries; it never
  // reaches across the library.
  const session = useWorkspaceSessionStore(s => s.session)

  // Part document names, so the tree shows 'Bracket' rather than the raw uuid.
  // A failed list is swallowed on purpose: names are a nicety here and the tree
  // falls back to the uuid, which is worse to read but never wrong. The same
  // fetch is where the add_part guard's live-part set comes from, so the two can
  // never disagree about which parts this workspace holds.
  const [docNames, setDocNames] = useState<Record<string, string>>({})
  // Null until the list lands: an empty set would be a real answer (no parts),
  // but an unloaded one must not refuse a pick the user just made.
  const knownPartIds = useRef<ReadonlySet<string> | null>(null)
  useEffect(() => {
    if (!session) {
      knownPartIds.current = null
      return
    }
    knownPartIds.current = null
    let cancelled = false
    session.listEntries()
      .then(list => {
        if (cancelled) return
        const names: Record<string, string> = {}
        const parts = new Set<string>()
        for (const entry of list) {
          names[entry.id] = entry.name
          const interpreted = interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind })
          if (interpreted.ok && interpreted.docKind === 'part') parts.add(entry.id)
        }
        setDocNames(names)
        knownPartIds.current = parts
      })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [session])

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

  // Unmount-only: the editor is going away with a pinned coalescing session.
  // Commit so navigation leaves exactly one entry instead of dropping the edits
  // from undo forever. Callback de-registration is a separate effect below, so
  // a mid-session re-registration can no longer commit (and split) a session
  // that is still being edited. commitSession is stable (deps only pushUndo and
  // docRef, both stable), so this effect never re-fires while mounted.
  useEffect(() => {
    return () => { commitSession() }
  }, [commitSession])

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
      // De-registration only. The unmount commit above is its own effect so a
      // re-registration while a pinned session is live cannot close it.
      setAssemblyCallbacks(null)
    }
  }, [mutateOneShot, mutate, requestSolve])

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
      navigate(`/workspaces/${workspaceId ?? uuid}/entries/${data.uuid}`)
    } catch (e) {
      setError(errorMessage(e, 'Failed to clone document'))
    }
  }, [uuid, workspaceId, cloneDoc, navigate, setError])

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
      // I8: the outward link a part instance authors is refused at the mutation
      // unless the doc it names is a live part entry in this workspace.
      knownPartIds: knownPartIds.current ?? undefined,
      mutateSession: mutate,
      mutateOneShot,
      requestSolve,
      requestSolveOrDefer: () => useAssemblyStore.getState().requestSolveOrDefer(),
    })
  }, [docRef, mutate, mutateOneShot, requestSolve])

  // Insert a mate with both references empty, open its editor and arm ref_a, so
  // the very next click in the viewport aims the first reference. The append
  // itself is wired in buildAssemblyHandlers (mint, close the previous session,
  // run add_mate); this is only the editor side effect after it lands.
  const handleMateInserted = useCallback((id: string, _kind: MateKind) => {
    const store = useAssemblyStore.getState()
    store.selectMate(id)
    store.openMateEditor(id)  // a fresh mate opens straight into its editor
    store.setActiveMateField({ featureId: id, field: 'ref_a' })
  }, [])

  // The [Delete] key maps to `delete_selected`; the store decides whether that
  // is the selected mate or the selected part and closes its editor when it is
  // the deleted subject.
  const handleDeleteSelected = useCallback(() => {
    useAssemblyStore.getState().deleteSelected()
  }, [])

  // The tree row's delete action. It routes through the same store action as the
  // [Delete] key, so the two cannot drift; the store closes the editor that named
  // the deleted subject.
  const handleDeleteSubject = useCallback((subjectToDelete: AssemblySubject) => {
    useAssemblyStore.getState().deleteSubject(subjectToDelete)
  }, [])

  // The picker's commit runs the add_part operation through the registry, the
  // same one path every other mutation takes.
  const handlePick = useCallback((docId: string, docRev: number) => {
    executeCommand('add_part', { docId, docRev })
  }, [])

  const handleOpenPartNewTab = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (inst) window.open(`/documents/${inst.doc_id}`, '_blank')
  }, [instances])

  const handleSelect = useCallback((handle: string) => {
    useAssemblyStore.getState().selectPart(handle)
  }, [])

  // Instance edit: open the inline editor and attach the gizmo to the part being
  // edited. Switching editors commits any open session so each edited subject's
  // changes land in their own step. Cancel needs no snapshot of the instance:
  // the hook pins the whole pre-session doc on the session's first edit.
  const handleEditInstance = useCallback((handle: string) => {
    closeOpenEditor()
    useAssemblyStore.getState().openInstanceEditor(handle)
    useAssemblyStore.getState().selectPart(handle)
    // Freeze the drawn pose here, before any edit this session can trigger a
    // background solve. Switching instances recaptures it. Falls back to the
    // seed for a part no solve has posed yet, so the basis is never undefined.
    const doc = docRef.current
    setPoseBasis({
      handle,
      pose: useAssemblyStore.getState().settledPose(handle) ?? (doc ? findInstance(doc, handle)?.transform : undefined),
    })
  }, [closeOpenEditor, docRef])

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
    store.selectMate(featureId)
  }, [commitSession])

  // The pencil opens the inline editor. Switching editors commits any open
  // session so each mate's edits land in their own step; that commit is also
  // what leaves this mate's own session unpinned, so its Cancel rewinds to the
  // doc as it opens here.
  const handleEditMate = useCallback((featureId: string) => {
    closeOpenEditor()
    const store = useAssemblyStore.getState()
    store.selectMate(featureId)
    store.openMateEditor(featureId)
  }, [closeOpenEditor])

  // Accept: leaving the mate disarms its field, which settles the owed solve,
  // and the coalesced session commits as one undo step.
  const handleCommitMate = useCallback(() => {
    commitSession()
    const store = useAssemblyStore.getState()
    store.closeEditor()
    store.selectMate(null)
  }, [commitSession])

  const handleCancelMate = useCallback(() => {
    const store = useAssemblyStore.getState()
    store.setActiveMateField(null)  // stop aiming before we rewrite the slots
    // Whole-session rewind, same as the instance editor's Cancel: nothing on the
    // mate path bakes today, but a partial revert of the mate def alone is the
    // shape that let the instance editor's bakes escape, so it is not repeated.
    cancelSession()
    store.closeEditor()
    store.selectMate(null)
    requestSolve()  // restore the solved pose the reverted refs imply
  }, [requestSolve, cancelSession])

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
  // routing to its Cancel, which rewinds the session. A modal or the export
  // dialog owns Escape while it is up: stand down so dismissing a message box
  // does not also rewind the edit behind it (mirrors cancel_draw's stand-down).
  const handleCancelEdit = useCallback(() => {
    if (modalOwnsEscape()) return
    const subject = useAssemblyStore.getState().editingSubject
    if (subject.kind === 'instance') handleCancelInstance()
    else if (subject.kind === 'mate') handleCancelMate()
  }, [handleCancelInstance, handleCancelMate])

  // The command-to-operation wiring lives in buildAssemblyHandlers so the page
  // only supplies the live host and the UI side effects; a test can build the
  // same handlers with spies and observe exactly which operations fire.
  // eslint-disable-next-line react-hooks/refs -- buildAssemblyHandlers only stores these callbacks; runOperation reads docRef when a command fires, never during render
  const assemblyHandlers = useMemo<AssemblyCommandHandlers>(() => buildAssemblyHandlers({
    runOperation,
    undo: handleUndo,
    redo: handleRedo,
    deleteSelected: handleDeleteSelected,
    cancelEdit: handleCancelEdit,
    openInsertPart: openPicker,
    openExport,
    mintMateId: mintFeatureId,
    closeOpenEditor,
    onMateInserted: handleMateInserted,
    deleteSubject: handleDeleteSubject,
  }), [
    runOperation, handleUndo, handleRedo, handleDeleteSelected, handleCancelEdit,
    openPicker, openExport, closeOpenEditor, handleMateInserted,
    handleDeleteSubject,
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
      useAssemblyStore.getState().selectMate(null)
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
      useAssemblyStore.getState().selectPart(null)
    }
  }, [doc, selectedPartHandle])

  // The editor edits the pose basis frozen when it opened, so a background
  // solve cannot move its fields. No live pose subscription is needed (and a
  // shallow one over settledPoses would churn while a drag is settling): the
  // seed is the only fallback, for an editor not opened through
  // handleEditInstance.
  const renderInstanceEditor = useCallback((inst: PartInstance) => (
    <PartInstanceEditor
      instance={inst}
      pose={(poseBasis?.handle === inst.handle ? poseBasis.pose : undefined) ?? inst.transform}
      onSetFixed={f => executeCommand('set_part_fixed', { handle: inst.handle, fixed: f })}
      onSetPosition={pos => executeCommand('set_part_position', { handle: inst.handle, pos })}
      onSetRotation={euler => executeCommand('set_part_rotation', { handle: inst.handle, euler })}
    />
  ), [poseBasis])

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

  // A failed load has no document to edit. Rendering the editor over a null doc
  // leaves a live-looking toolbar and tree whose every mutation silently
  // no-ops, so this is terminal: the error and one way out, no retry token that
  // would just re-expose the dead editor.
  if (error && !doc) {
    return (
      <div className="document-viewer">
        <div className="assembly-load-failed" role="alert">
          <p>Error: {error}</p>
          <button className="toolbar-btn" onClick={() => navigate('/documents')}>
            Back to documents
          </button>
        </div>
      </div>
    )
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
        <Sidebar
          documentPanel={
            <AssemblyTree
              instances={instances}
              builtins={builtins}
              mates={mates}
              status={solveStatus}
              labelFor={labelFor}
              subject={subject}
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
          }
        />
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
            {instances.length === 0 && mates.length === 0 && !error && (
              <p className="assembly-empty-hint">Empty assembly - insert parts to get started.</p>
            )}
          </div>
        </div>
      </div>
      <AssemblyPartPicker
        isOpen={pickerOpen}
        selfUuid={uuid}
        session={session}
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
