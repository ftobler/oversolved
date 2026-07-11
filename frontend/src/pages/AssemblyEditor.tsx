import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { useAssemblyStore, setAssemblyCallbacks, type MateFieldTarget } from '@/stores/assemblyStore'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import AssemblyViewport from '@/components/Viewport/AssemblyViewport'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useCommandRegistration } from '@/pages/hooks/useCommandRegistration'
import { AssemblyTree } from '@/components/layout/AssemblyTree'
import { MateEditor } from '@/components/layout/MateEditor'
import { PartInstanceEditor } from '@/components/layout/PartInstanceEditor'
import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'
import AssemblyExport, { type AssemblyExportHandle } from '@/pages/AssemblyExport'
import { backendBundle } from '@/adapters/backend'
import {
  appendMate,
  appendPartInstance,
  findInstance,
  findMate,
  mintFeatureId,
  removeInstance,
  removeMate,
  replaceInstance,
  replaceMate,
  setBuiltinVisible,
  setInstanceVisible,
  setInstanceFixed,
  setInstancePosition,
  setMateLabel,
  updateMate,
  type MateParamPatch,
} from '@/utils/assemblyMutations'
import { getAssemblyBuiltins } from '@/utils/assemblyRender'
import { MATE_KINDS, MATE_KIND_LABELS, EMPTY_MATE_REF } from '@/utils/mateKinds'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import type { AssemblyDoc, MateKind, MateFeatureDef, PartInstance, AssemblyFeature } from '@/types/cad'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import mateIcon from '@/assets/icons/constraint-coincident.svg'
import exportIcon from '@/assets/icons/icon-download.svg'
import cancelIcon from '@/assets/icons/dialog-cancel.svg'
import '@/pages/Part.css'
import '@/pages/Assembly.css'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/utils/builtins'

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
  const [mateMenuOpen, setMateMenuOpen] = useState(false)
  const [editingInstanceHandle, setEditingInstanceHandle] = useState<string | null>(null)
  const { requestSolve } = useAssemblySolve(uuid, doc)
  const selectedPartHandle = useAssemblyStore(s => s.selectedPartHandle)
  const selectedMateId = useAssemblyStore(s => s.selectedMateId)
  const activeMateField = useAssemblyStore(s => s.activeMateField)
  const mateResults = useAssemblyStore(s => s.mateResults)
  const solveError = useAssemblyStore(s => s.solveError)

  // Snapshots taken when editing begins, so Cancel can revert every live edit
  // (mates and instances edit the doc in place; there is no other undo point).
  const mateSnapshot = useRef<{ id: string; def: MateFeatureDef } | null>(null)
  const instanceSnapshot = useRef<{ handle: string; inst: PartInstance } | null>(null)

  // Part document names, so the tree shows 'Bracket' rather than the raw uuid.
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
      .catch(() => { /* names are a nicety; fall back to the uuid */ })
    return () => { cancelled = true }
  }, [])

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

  const handleSave = useCallback(() => {
    if (uuid && doc) saveDoc(uuid, doc)
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
    store.setActiveMateField({ featureId: id, field: 'ref_a' })
  }, [mutate])

  const commands = useMemo(() => [
    { name: 'insert_part_instance', fn: openPicker },
    { name: 'export_assembly', fn: openExport },
    ...MATE_KINDS.map(kind => ({ name: `insert_mate_${kind}`, fn: () => handleInsertMate(kind) })),
  ], [openPicker, openExport, handleInsertMate])
  useCommandRegistration(commands)

  const handlePick = useCallback((docId: string, docRev: number) => {
    mutate(d => appendPartInstance(d, docId, docRev))
    requestSolve()  // the new instance has no bodies until the assembly re-solves
  }, [mutate, requestSolve])

  const handleOpenPart = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (!inst) return
    useAssemblyStore.getState().setActivePartHandle(handle)
    navigate(`/documents/${inst.doc_id}`)
  }, [instances, navigate])

  const handleOpenPartNewTab = useCallback((handle: string) => {
    const inst = instances.find(i => i.handle === handle)
    if (inst) window.open(`/documents/${inst.doc_id}`, '_blank')
  }, [instances])

  const handleDelete = useCallback((handle: string) => {
    mutate(d => removeInstance(d, handle))
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

  const handleToggleFixed = useCallback((handle: string, fixed: boolean) => {
    mutate(d => setInstanceFixed(d, handle, fixed))
    // Grounding changes which bodies the LM solver may move: the current solve
    // is stale the moment the flag flips.
    requestSolve()
  }, [mutate, requestSolve])

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

  const handleSetGrounded = useCallback((handle: string, grounded: boolean) => {
    mutate(d => setInstanceFixed(d, handle, grounded))
    requestSolve()
  }, [mutate, requestSolve])

  const handleSetPosition = useCallback((handle: string, pos: { tx: number; ty: number; tz: number }) => {
    mutate(d => setInstancePosition(d, handle, pos))
    requestSolve()
  }, [mutate, requestSolve])

  // Selecting a mate opens (and edits) it. Snapshot the current def so Cancel
  // reverts. Insert already primed the snapshot for the mate it created.
  const handleSelectMate = useCallback((featureId: string) => {
    if (mateSnapshot.current?.id !== featureId) {
      const def = doc ? findMate(doc, featureId) : undefined
      mateSnapshot.current = def ? { id: featureId, def: { ...def } } : null
    }
    useAssemblyStore.getState().setSelectedMateId(featureId)
  }, [doc])

  // Accept: leaving the mate disarms its field, which settles the owed solve.
  const handleCommitMate = useCallback(() => {
    mateSnapshot.current = null
    useAssemblyStore.getState().setSelectedMateId(null)
  }, [])

  const handleCancelMate = useCallback(() => {
    const snap = mateSnapshot.current
    const store = useAssemblyStore.getState()
    store.setActiveMateField(null)  // stop aiming before we rewrite the slots
    if (snap) mutate(d => replaceMate(d, snap.id, snap.def))
    mateSnapshot.current = null
    store.setSelectedMateId(null)
    requestSolve()  // restore the solved pose the reverted refs imply
  }, [mutate, requestSolve])

  const handleDeleteMate = useCallback((featureId: string) => {
    mutate(d => removeMate(d, featureId))
    mateSnapshot.current = null
    useAssemblyStore.getState().setSelectedMateId(null)
    requestSolve()  // the freed DOF must let the parts settle back
  }, [mutate, requestSolve])

  const handleUpdateMate = useCallback((featureId: string, patch: MateParamPatch) => {
    mutate(d => updateMate(d, featureId, patch))
    // Deferred while a chip is armed: a solve here would drop the candidate set
    // the armed field is still cycling.
    useAssemblyStore.getState().requestSolveOrDefer()
  }, [mutate])

  // Renaming is a pure label edit: no solve, it constrains nothing.
  const handleRenameMate = useCallback((featureId: string, label: string | undefined) => {
    mutate(d => setMateLabel(d, featureId, label))
  }, [mutate])

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
    }
  }, [doc, selectedMateId, selectedMate])

  const renderInstanceEditor = useCallback((inst: PartInstance) => (
    <PartInstanceEditor
      instance={inst}
      onSetGrounded={g => handleSetGrounded(inst.handle, g)}
      onSetPosition={pos => handleSetPosition(inst.handle, pos)}
    />
  ), [handleSetGrounded, handleSetPosition])

  const renderMateEditor = useCallback((mate: { id: string; mate: MateFeatureDef }, defaultName: string) => (
    <MateEditor
      featureId={mate.id}
      mate={mate.mate}
      result={mateResults[mate.id]}
      activeField={activeMateField}
      labelFor={labelFor}
      defaultName={defaultName}
      onArmField={handleArmMateField}
      onUpdate={patch => handleUpdateMate(mate.id, patch)}
      onRename={label => handleRenameMate(mate.id, label)}
    />
  ), [mateResults, activeMateField, labelFor, handleArmMateField, handleUpdateMate, handleRenameMate])

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
            editingInstanceHandle={editingInstanceHandle}
            onSelectPart={handleSelect}
            onOpenPart={handleOpenPart}
            onOpenPartNewTab={handleOpenPartNewTab}
            onDeleteInstance={handleDelete}
            onToggleVisible={handleToggleVisible}
            onToggleFixed={handleToggleFixed}
            onToggleBuiltinVisible={handleToggleBuiltinVisible}
            onEditInstance={handleEditInstance}
            onCommitInstance={handleCommitInstance}
            onCancelInstance={handleCancelInstance}
            renderInstanceEditor={renderInstanceEditor}
            onSelectMate={handleSelectMate}
            onCommitMate={handleCommitMate}
            onCancelMate={handleCancelMate}
            onDeleteMate={handleDeleteMate}
            renderMateEditor={(m, defaultName) => renderMateEditor(m, defaultName)}
          />
          {mateMenuOpen && (
            <div className="mate-kind-picker">
              <div className="mate-editor-header">
                <span>Insert mate</span>
                <button
                  type="button"
                  className="feature-context-btn"
                  onClick={() => setMateMenuOpen(false)}
                  title="Close"
                  aria-label="Close mate menu"
                >
                  <img src={cancelIcon} alt="Close" />
                </button>
              </div>
              <ul className="assembly-tree-list mate-kind-menu">
                {MATE_KINDS.map(kind => (
                  <li key={kind}>
                    <button
                      type="button"
                      className="mate-kind-option"
                      onClick={() => { setMateMenuOpen(false); handleInsertMate(kind) }}
                    >
                      {MATE_KIND_LABELS[kind]}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
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
            <button
              className={`editor-btn ${mateMenuOpen ? 'active' : ''}`}
              title="Insert mate"
              aria-label="Insert mate"
              aria-expanded={mateMenuOpen}
              onClick={() => setMateMenuOpen(o => !o)}
              disabled={readOnly}
            >
              <img src={mateIcon} alt="Insert mate" />
            </button>
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
            <AssemblyViewport />
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
      </footer>
      <AssemblyPartPicker
        isOpen={pickerOpen}
        selfUuid={uuid}
        onClose={() => setPickerOpen(false)}
        onPick={handlePick}
      />
      <AssemblyExport ref={exportRef} doc={doc} docName={docName} />
    </div>
  )
}
