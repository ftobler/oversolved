import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAssemblyDoc } from '@/hooks/useAssemblyDoc'
import { errorMessage } from '@/utils/core/errorMessage'
import { useAssemblySolve } from '@/hooks/useAssemblySolve'
import { capturePreview } from '@/stores/previewStore/capture'
import { useAssemblyUndoRedo } from '@/hooks/useAssemblyUndoRedo'
import { useAssemblyStore, setAssemblyCallbacks, DEFAULT_ASSEMBLY_EDITOR_DATA, type MateFieldTarget } from '@/stores/assemblyStore'
import { useSolverStore } from '@/stores/solverStore'
import { ErrorBanner } from '@/components/shared/ErrorBanner'
import { LoadingState } from '@/components/shared/LoadingState'
import LoadingOverlay from '@/components/dialogs/LoadingOverlay'
import EditorErrorBoundary from '@/components/misc/EditorErrorBoundary'
import AssemblyViewport, { type AssemblyViewportHandle } from '@/components/Viewport/AssemblyViewport'
import ViewOptionsButton from '@/components/Viewport/ViewOptionsButton'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { discardUnsavedEdits } from '@/recovery/discardUnsavedEdits'
import { useOpenEntryInNewTab } from '@/hooks/useOpenEntryInNewTab'
import { confirmDiscardUnsavedChanges, useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { useAssemblyCommands } from '@/pages/AssemblyKeyboardShortcuts'
import { insertMateCommand, type AssemblyCommandContext } from '@/pages/assemblyCommandEntries'
import { CommandRegistryProvider, useCommandRegistryWithContext } from '@/contexts/CommandRegistryContext'
import { editingInstanceHandle as editingInstanceHandleOf, editingMateId as editingMateIdOf } from '@/utils/assemblyEditingSubject'
import {
  findInstance,
  findMate,
  mintFeatureId,
  partInstances,
} from '@/utils/assemblyMutations'
import { loadAssemblyDocText } from '@/persistence/docSchema'
import { runAssemblyOperation, type AssemblyOperationId, type AssemblyOperationInputs } from '@/utils/assemblyOperations'
import { useWorkspaceSessionStore } from '@/stores/workspaceSessionStore'
import { interpretEntry } from '@/workspace/kinds'
import { cyclePath } from '@/workspace/refs'
import type { EntryMeta, ReferenceEdges } from '@/workspace/types'
import { addStepAssembly, addStepPart, STEP_NO_SOLIDS } from '@/workspace/stepPart'
import { splitStepViaWorker } from '@/kernel/worker/solverClient'
import StepImportDialog from '@/components/dialogs/StepImportDialog'
import type { StepImportMode } from '@/workspace/stepImportMode'
import { stepImportLimitError } from '@/stores/documentStore/stepImport'
import type { AssemblySubject } from '@/utils/assemblySelection'
import { executeCommand } from '@/utils/core/commandRegistry'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import { AssemblyDocumentPanel } from '@/components/layout/AssemblyDocumentPanel'
import { AssemblyEditPanel } from '@/components/layout/AssemblyEditPanel'
import { MATE_KIND_ICONS } from '@/components/layout/mateKindIcons'
import { PanelsToggle } from '@/components/layout/PanelsToggle'
import { MateEditor } from '@/components/layout/MateEditor'
import { PartInstanceEditor, type PartOption } from '@/components/layout/PartInstanceEditor'
import AssemblyPartPicker from '@/components/dialogs/AssemblyPartPicker'
import RenameDialog from '@/components/dialogs/RenameDialog'
import RawDocumentDialog from '@/components/dialogs/RawDocumentDialog'
import AssemblyExport, { type AssemblyExportHandle } from '@/pages/AssemblyExport'
import { getAssemblyBuiltins } from '@/utils/assemblyRender'
import { assemblyVerdict } from '@/utils/core/assemblyStatus'
import { MATE_KINDS, MATE_KIND_LABELS } from '@/utils/mateKinds'
import AssemblyToolbar from '@/pages/AssemblyToolbar'
import AssemblyMeasurementDisplay from '@/components/layout/AssemblyMeasurementDisplay'
import type { AssemblyDoc, MateKind, MateFeatureDef, PartInstance, Transform3D } from '@/types/cad'
import featurePartIcon from '@/assets/icons/feature-part.svg'
import measurementIcon from '@/assets/icons/measurement.svg'
import '@/pages/Part.css'
import '@/pages/Assembly.css'

// The empty view shared by every render before the workspace list lands.
const NO_DOC_NAMES: Record<string, string> = {}

// One entry list read four ways: tree labels, the live-part and live-assembly
// sets the mutation guard checks, the instance editor's rebind options and the
// picker's grouped tile source. They are built together so no path can update
// some of them and leave the rest stale.
interface PartListView {
  names: Record<string, string>
  entries: EntryMeta[]
}

export default function AssemblyEditor({ uuid, workspaceId }: { uuid: string; workspaceId?: string }) {
  const {
    doc,
    setDoc,
    docRef,
    loading,
    error,
    setError,
    loadFailure,
    setLoadFailure,
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
  // Declared here rather than beside handleSave below: the first-solve preview
  // capture reads it, and that callback has to exist before the solve hook.
  const viewportRef = useRef<AssemblyViewportHandle>(null)
  const handleFirstSolve = useCallback(() => {
    // Thumbnail the solved scene, the part editor's first-solve capture for the
    // assembly: saving was the only writer of a preview, so an assembly opened
    // and never saved had none. It waits for the viewport's own fit, so the
    // capture frames the assembly rather than whatever camera was live when the
    // solve landed. Best-effort and fire-and-forget -- a viewport that is absent,
    // has no GL context or never fits is a miss, never an error -- and the key
    // is the save path's, so both writers address one record.
    viewportRef.current?.whenFramed?.(() => {
      void capturePreview(viewportRef.current?.captureScreenshotForSaving, workspaceId, uuid)
    })
  }, [uuid, workspaceId])
  const { requestSolve, rebuild } = useAssemblySolve(uuid, doc, { onFirstSolve: handleFirstSolve })
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
  const hiddenLeafPaths = useAssemblyStore(s => s.hiddenLeafPaths)
  // The assembly solve mirrors its running flag into the solver store for the
  // shared LoadingOverlay; the Parts header's rebuild button reads the same flag,
  // so a running solve spins it and refuses a second request.
  const isSolving = useSolverStore(s => s.isSolving)
  // One store-owned tagged subject instead of two useState ids. The selectors
  // are the only place "which editor is open" is read.
  const editingSubject = useAssemblyStore(s => s.editingSubject)
  const editingMateId = editingMateIdOf(editingSubject)
  const editingInstanceHandle = editingInstanceHandleOf(editingSubject)

  // The phone drawer's open flag, the part editor's twin: below the breakpoint
  // Part.css hides the tree and the toolbar's one toggle reopens it as a strip
  // over the editor. Above it the flag is inert.
  const [panelsOpen, setPanelsOpen] = useState(false)

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

  // Part document names, so the tree shows 'Bracket' rather than the raw uuid,
  // plus the instance editor's rebind options: this workspace's parts, minus
  // the assembly itself (pointing an instance at its own assembly is a cycle).
  // This one list is also the picker's tile source and the add_part guard's
  // live-part set, so the names, the guard and the tiles can never disagree
  // about which parts exist. A read failure is kept rather than swallowed: the
  // picker shows it, since a list that never lands is otherwise an Insert
  // button with nothing to pick and no reason why.
  const [partList, setPartList] = useState<PartListView | null>(null)
  const [partListError, setPartListError] = useState<string | null>(null)
  // A read is in flight. The picker shows its spinner and refuses to confirm
  // while this is true, so the previous rows cannot be inserted against a
  // workspace that has since dropped one of them.
  const [partListRefreshing, setPartListRefreshing] = useState(false)
  // The workspace reference graph, refreshed with the list. Cycles are a
  // placement rule over this graph, so the picker and the operation guard read
  // the same snapshot.
  const [references, setReferences] = useState<ReferenceEdges>({})
  const docNames = partList?.names ?? NO_DOC_NAMES
  // Null until the list lands: an empty set would be a real answer (no parts),
  // but an unloaded one must not refuse a pick the user just made.
  const knownPartIds = useRef<ReadonlySet<string> | null>(null)
  const knownAssemblyIds = useRef<ReadonlySet<string> | null>(null)
  // The newest list request only. Two reads are in flight whenever the picker
  // opens (the mount read is still going), and an older answer landing last
  // would overwrite the newer guard set with the stale one, which is the exact
  // mismatch this list exists to prevent.
  const listReqRef = useRef(0)

  const applyPartList = useCallback((list: readonly EntryMeta[], edges: ReferenceEdges) => {
    const names: Record<string, string> = {}
    const parts = new Set<string>()
    const assemblies = new Set<string>()
    for (const entry of list) {
      names[entry.id] = entry.name
      const interpreted = interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind })
      if (!interpreted.ok) continue
      if (interpreted.docKind === 'part') parts.add(entry.id)
      else if (interpreted.docKind === 'assembly') assemblies.add(entry.id)
    }
    knownPartIds.current = parts
    knownAssemblyIds.current = assemblies
    setReferences(edges)
    setPartList({ names, entries: list as EntryMeta[] })
  }, [])

  // The list is a view, not the document: refresh it on mount, when the picker
  // opens, when the instance editor opens, and after a STEP import, so a part
  // or assembly added or deleted in another tab is pickable (or gone) without
  // reopening the assembly. The picker reads the same list, so its tiles and
  // the add_part guard learn about that part together.
  const refreshPartList = useCallback((isCancelled: () => boolean = () => false) => {
    const reqId = ++listReqRef.current
    const current = () => reqId === listReqRef.current && !isCancelled()
    if (!session) {
      knownPartIds.current = null
      knownAssemblyIds.current = null
      // Deferred a microtask: a synchronous clear here is a setState inside the
      // mount effect's body, and nothing may be picked before it lands anyway.
      queueMicrotask(() => {
        if (!current()) return
        setPartList(null)
        setPartListError(null)
        setPartListRefreshing(false)
      })
      return
    }
    // A read is a pending answer, not an empty one: mark it before the request
    // so the picker cannot confirm a row from the previous read while the
    // workspace may already have dropped it. Same microtask reason as above.
    queueMicrotask(() => {
      if (!current()) return
      setPartListError(null)
      setPartListRefreshing(true)
    })
    Promise.all([session.listEntries(), session.referenceEdges()])
      .then(([list, edges]) => {
        if (!current()) return
        applyPartList(list, edges)
        setPartListRefreshing(false)
      })
      .catch(e => {
        if (!current()) return
        setPartListError(errorMessage(e, 'Failed to list workspace documents'))
        setPartListRefreshing(false)
      })
  }, [session, applyPartList])

  // The picker's zero-arg refresh. Kept as a stable callback rather than an
  // inline arrow: the picker re-runs its open effect when this identity
  // changes, and a fresh arrow per render would read the list again on every
  // landing (a refresh loop).
  const refreshPartListNow = useCallback(() => refreshPartList(), [refreshPartList])

  useEffect(() => {
    let cancelled = false
    refreshPartList(() => cancelled)
    return () => { cancelled = true }
  }, [refreshPartList])

  // The stored graph does not yet know about the open document's own unsaved
  // instances, and the open document is exactly the host a new placement is
  // tested against. Merging its live instance list into its outgoing edges is
  // what makes two unsaved placements in one session see each other.
  const effectiveReferences = useMemo(() => ({
    ...references,
    [uuid]: instances.map(inst => inst.doc_id),
  }), [references, instances, uuid])

  const cycleReasonFor = useCallback((docId: string): string | undefined => {
    const path = cyclePath(effectiveReferences, uuid, docId)
    if (path === null) return undefined
    const names = path.map(id => (id === uuid ? 'this assembly' : (docNames[id] ?? id)))
    const candidate = docNames[docId] ?? docId
    return `Adding ${candidate} would make a circular assembly: ${names.join(' > ')}`
  }, [effectiveReferences, uuid, docNames])

  // The picker and the instance editor's rebind list share this split: parts
  // first, then assemblies, each with the cycle refusal the operation guard will
  // also apply. A disabled assembly stays listed so the user can see why.
  const listOptions = useMemo(() => {
    const parts: PartOption[] = []
    const assemblies: PartOption[] = []
    for (const entry of partList?.entries ?? []) {
      if (entry.id === uuid) continue
      const interpreted = interpretEntry({ kind: entry.kind, name: entry.name, docKind: entry.docKind })
      if (!interpreted.ok) continue
      if (interpreted.docKind === 'part') {
        parts.push({ id: entry.id, name: entry.name, kind: 'part' })
      } else if (interpreted.docKind === 'assembly') {
        const reason = cycleReasonFor(entry.id)
        assemblies.push({
          id: entry.id,
          name: entry.name,
          kind: 'assembly',
          ...(reason !== undefined && { disabledReason: reason }),
        })
      }
    }
    const byName = (a: PartOption, b: PartOption) => a.name.localeCompare(b.name)
    parts.sort(byName)
    assemblies.sort(byName)
    return { parts, assemblies }
  }, [partList, uuid, cycleReasonFor])

  const partOptions = useMemo(
    () => (partList === null ? undefined : [...listOptions.parts, ...listOptions.assemblies]),
    [partList, listOptions],
  )

  const assemblyIdSet = useMemo(
    () => new Set(listOptions.assemblies.map(option => option.id)),
    [listOptions],
  )
  const knownKind = useCallback((docId: string): 'part' | 'assembly' | undefined => {
    if (knownAssemblyIds.current?.has(docId)) return 'assembly'
    if (knownPartIds.current?.has(docId)) return 'part'
    return undefined
  }, [])

  // The tree needs each referenced sub-assembly's own instance list, at any
  // depth, to draw its child rows. A failed read lands as `null`, which the
  // model renders as a failed row rather than hiding the placement.
  const [subassemblyDocs, setSubassemblyDocs] = useState<Record<string, AssemblyDoc | null>>({})
  useEffect(() => {
    let cancelled = false
    if (!session) {
      // Deferred a microtask: no session is a mount-time state, and clearing it
      // synchronously in the effect would cascade a render.
      queueMicrotask(() => { if (!cancelled) setSubassemblyDocs({}) })
      return () => { cancelled = true }
    }
    void (async () => {
      const docs: Record<string, AssemblyDoc | null> = {}
      const seen = new Set<string>()
      const visit = async (list: readonly PartInstance[]) => {
        for (const inst of list) {
          if (seen.has(inst.doc_id) || !assemblyIdSet.has(inst.doc_id)) continue
          seen.add(inst.doc_id)
          try {
            const entry = await session.readEntry(inst.doc_id)
            const loaded = entry.kind === 'document'
              ? loadAssemblyDocText(entry.text ?? '', { name: entry.name })
              : null
            const doc = loaded?.ok ? loaded.doc : null
            docs[inst.doc_id] = doc
            if (doc) await visit(partInstances(doc))
          } catch {
            docs[inst.doc_id] = null
          }
        }
      }
      await visit(instances)
      if (!cancelled) setSubassemblyDocs(docs)
    })()
    return () => { cancelled = true }
  }, [session, instances, assemblyIdSet])

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
  // Commit so the session's edits are not stranded mid-teardown, not so they
  // stay undoable: the next mount's load calls clearAssemblyHistory, which
  // wipes this very entry before any editor can consume it. What keeps the
  // edits is useUnsavedChangesGuard and the header/breadcrumb discard prompt,
  // which resolve long before this runs. Callback de-registration is a separate
  // effect below, so a mid-session re-registration can no longer commit (and
  // split) a session that is still being edited. commitSession is stable (its
  // only dep is docRef, a stable ref), so this effect never re-fires while
  // mounted.
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

  // Register the durable discard for this editor's document: assembly documents
  // carry no recovery journal (docId null), so only the workspace working copy
  // is reset, and only when it is ahead.
  useEffect(() => {
    if (!uuid) return
    useUnsavedChangesStore.getState().setDiscardHandler(() =>
      discardUnsavedEdits({ workspace: workspaceId ?? null, docId: null }),
    )
    return () => { useUnsavedChangesStore.getState().setDiscardHandler(null) }
  }, [uuid, workspaceId])

  const handleClone = useCallback(async () => {
    if (!uuid) return
    try {
      const data = await cloneDoc(uuid)
      // The clone is taken from the stored document, so walking onto it would
      // leave this editor's unsaved edits behind: another exit from the entry
      // route, and it asks like every other one.
      const target = `/workspaces/${workspaceId ?? uuid}/entries/${data.uuid}`
      if (confirmDiscardUnsavedChanges(() => navigate(target))) navigate(target)
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
  // operation decides bake/undo/solve; the page only supplies the context. The
  // generic keeps the payload typed per operation: command specs parse their
  // params before they get here, so no payload crosses this boundary as
  // `unknown`.
  const runOperation = useCallback(<K extends AssemblyOperationId>(id: K, payload: AssemblyOperationInputs[K]) => {
    runAssemblyOperation(id, payload, {
      doc: docRef.current,
      transforms: useAssemblyStore.getState().settledPoses(),
      // I8: the outward link a part instance authors is refused at the mutation
      // unless the doc it names is a live part or assembly entry in this
      // workspace.
      knownPartIds: knownPartIds.current ?? undefined,
      knownAssemblyIds: knownAssemblyIds.current ?? undefined,
      // The cycle guard's graph, with the open document's live instances merged
      // in by `effectiveReferences`. An instance may never point at an assembly
      // that already contains this one.
      references: effectiveReferences,
      nameOf: (docId: string) => docNames[docId],
      assemblyDocId: uuid,
      mutateSession: mutate,
      mutateOneShot,
      requestSolve,
      requestSolveOrDefer: () => useAssemblyStore.getState().requestSolveOrDefer(),
    })
  }, [docRef, mutate, mutateOneShot, requestSolve, uuid, effectiveReferences, docNames])

  // Insert a mate with both references empty, open its editor and arm ref_a, so
  // the very next click in the viewport aims the first reference. The append
  // itself is wired in the static insert_mate_* specs (mint the id, close the
  // previous session, run add_mate); this is only the editor side effect after
  // it lands.
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
  // same one path every other mutation takes. A refused insert (the I8 guard,
  // a cycle) comes back as a failed Result and is shown: without this the
  // dialog closed and nothing happened, which is the bug this path was fixed
  // for.
  const handlePick = useCallback((docId: string, docRev: number) => {
    const added = executeCommand('add_part', { docId, docRev })
    if (!added.ok) setError(added.message)
  }, [setError])

  // Import STEP drops a file into the open workspace as its own part document,
  // then instances it through the ordinary add_part command. The store write is
  // one save (the file entry, the part and their edge), so the pair cannot
  // half-exist; undo covers the instance and leaves the part in the workspace,
  // the same way delete_part never deletes the document it placed.
  //
  // A picked file opens the mode dialog first: A is this whole-file import, and
  // B2 splits it into one part per solid (the assembly already exists, so B1
  // would be A and is not offered).
  const [stepImport, setStepImport] = useState<{ fileName: string; bytes: Uint8Array } | null>(null)

  // Every part a gesture just created joins the live-part set before its
  // add_part(s) command runs, so the outward-link guard accepts them; the picker
  // view gets the same entries, so a later rebind can choose them too. The
  // workspace list is asked again afterwards so the optimistic entries and the
  // stored rows cannot drift.
  const registerImportedParts = useCallback((parts: readonly { id: string; name: string }[]) => {
    if (parts.length === 0) return
    if (knownPartIds.current) {
      knownPartIds.current = new Set([...knownPartIds.current, ...parts.map(part => part.id)])
    }
    setPartList(prev => {
      if (prev === null) return prev
      const names = { ...prev.names }
      const entries = [...prev.entries]
      for (const part of parts) {
        names[part.id] = part.name
        if (!entries.some(entry => entry.id === part.id)) {
          // A STEP import always lands a part, so the optimistic row says part
          // even before the store list is asked again.
          entries.push({
            id: part.id,
            path: `documents/${part.name}.yaml`,
            kind: 'document',
            name: part.name,
            docKind: 'part',
          })
        }
      }
      return { names, entries }
    })
    refreshPartList()
  }, [refreshPartList])

  const handleImportStep = useCallback(() => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.step,.stp'
    input.onchange = async () => {
      const file = input.files?.[0]
      if (!file) return
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
      setStepImport({ fileName: file.name, bytes })
    }
    input.click()
  }, [setError])

  // The STEP mode the user picked. A adds the whole file as one part through
  // the ordinary add_part command; B2 splits the file into per-solid STEP bytes,
  // writes one part per solid, and adds every instance in ONE add_parts command
  // so undo covers the whole import. A one-solid file falls through to A: the
  // split proved it has nothing to split, and importing the original bytes keeps
  // the part identical to modes A and B1.
  const handleStepImportConfirm = useCallback(async (mode: StepImportMode) => {
    const picked = stepImport
    setStepImport(null)
    if (picked === null) return
    const workspace = workspaceId ?? session?.workspace ?? uuid
    const importWhole = async () => {
      const imported = await addStepPart(workspace, picked.bytes, { fileName: picked.fileName })
      registerImportedParts([{ id: imported.partId, name: imported.name }])
      const added = executeCommand('add_part', { docId: imported.partId, docRev: 0 })
      if (!added.ok) setError(added.message)
    }
    try {
      if (mode === 'part') {
        await importWhole()
        return
      }
      const split = await splitStepViaWorker(picked.bytes)
      if (split === null) {
        setError('STEP splitting needs the local kernel; reload the page and try again')
        return
      }
      if (split.solids.length === 0) {
        setError(STEP_NO_SOLIDS)
        return
      }
      if (split.solids.length === 1) {
        await importWhole()
        return
      }
      const imported = await addStepAssembly(workspace, picked.bytes, {
        fileName: picked.fileName,
        mode: 'assembly_split',
        solids: split.solids.map(solid => solid.bytes),
        intoAssembly: uuid,
      })
      registerImportedParts(imported.parts)
      runOperation('add_parts', imported.parts.map(part => ({ docId: part.id, docRev: 0 })))
    } catch (e) {
      setError(errorMessage(e, 'Failed to import STEP'))
    }
  }, [uuid, workspaceId, session, stepImport, setError, registerImportedParts, runOperation])

  const openEntryInNewTab = useOpenEntryInNewTab(workspaceId ?? uuid)
  const handleOpenPartNewTab = useCallback((handle: string, docId?: string) => {
    const inst = instances.find(i => i.handle === handle)
    const target = docId ?? inst?.doc_id
    if (target) openEntryInNewTab(target)
  }, [instances, openEntryInNewTab])

  const handleSelect = useCallback((handle: string, leafPath?: string) => {
    // A child row selects the top-level instance that moves, plus the leaf the
    // viewport highlights. The store's union keeps it one subject.
    useAssemblyStore.getState().selectPart(handle, leafPath)
  }, [])

  // Instance edit: open the right edit card and attach the gizmo to the part
  // being edited. Switching editors commits any open session so each edited
  // subject's changes land in their own step. Cancel needs no snapshot of the
  // instance: the hook pins the whole pre-session doc on the session's first
  // edit.
  const handleEditInstance = useCallback((handle: string) => {
    closeOpenEditor()
    // The picker's source is a view of the workspace, not the document: refresh
    // it on open so a part added or deleted in another tab is pickable, or
    // refused before it can be written.
    refreshPartList()
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
  }, [closeOpenEditor, docRef, refreshPartList])

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

  // The pencil opens the mate's right edit card. Switching editors commits any
  // open session so each mate's edits land in their own step; that commit is
  // also what leaves this mate's own session unpinned, so its Cancel rewinds to
  // the doc as it opens here.
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

  // Both the tree menu and the open mate card open the one dialog through this,
  // so the two ends cannot drift in what they seed it with.
  const requestRenameMate = useCallback((id: string, currentName: string) => {
    setRenameMateTarget({ id, currentName })
  }, [])

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

  // Undo's first stage: a live drag is abandoned through the viewport's own
  // gesture teardown, the same one Escape runs, rather than having the entry
  // above it popped from under the held button. The store's cancel is the
  // fallback for a command table with no viewport: the viewport handle clears
  // the module-level pointer machine and the published gizmoDrag as well, which
  // the store's cancel alone cannot reach.
  const manipulationLive = useCallback(
    () => useAssemblyStore.getState().manipulation !== null,
    [],
  )
  const cancelManipulation = useCallback(
    () => {
      const viewport = viewportRef.current
      if (viewport) {
        viewport.cancelGesture()
        return
      }
      useAssemblyStore.getState().cancelPartManipulation()
    },
    [],
  )

  // The command-to-operation wiring lives in the static ASSEMBLY_COMMAND_SPECS
  // table; the page only supplies the live context (the operation host, the UI
  // side effects and the store-backed history depths). A test can run the same
  // specs against a stub context and observe exactly which operations fire.
  const commandContext = useMemo<AssemblyCommandContext>(() => ({
    editor: 'assembly',
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
    manipulationLive,
    cancelManipulation,
    undoDepth: () => useAssemblyStore.getState().undoStack.length,
    redoDepth: () => useAssemblyStore.getState().redoStack.length,
  }), [
    runOperation, handleUndo, handleRedo, handleDeleteSelected, handleCancelEdit,
    openPicker, openExport, closeOpenEditor, handleMateInserted,
    handleDeleteSubject, manipulationLive, cancelManipulation,
  ])
  const commandRegistry = useCommandRegistryWithContext(commandContext)
  useAssemblyCommands(commandRegistry)

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
      // The edited subject is left alone: setSnapshot's `subject_removed`
      // reduction closes the edit card when its mate no longer resolves. This
      // effect only retires the selection that armed the pick.
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
      partOptions={partOptions}
      onSetPartDoc={docId => {
        if (!docId) return  // the missing placeholder is not a choice
        // The command reports its own refusal (a stale part, the assembly
        // itself) as a failed Result, so the rebind path shows it the same way
        // the insert path does.
        const result = executeCommand('set_part_doc', { handle: inst.handle, docId })
        if (!result.ok) setError(result.message)
      }}
      onSetFixed={f => executeCommand('set_part_fixed', { handle: inst.handle, fixed: f })}
      onSetPosition={pos => executeCommand('set_part_position', { handle: inst.handle, pos })}
      onSetRotation={euler => executeCommand('set_part_rotation', { handle: inst.handle, euler })}
    />
  ), [poseBasis, partOptions, setError])

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
    return <div className="document-viewer"><LoadingState label="Loading..." /></div>
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
          <button className="toolbar-btn" onClick={() => navigate(workspaceId ? `/workspaces/${workspaceId}` : '/workspaces')}>
            Back to documents
          </button>
        </div>
        {/* A document the loader refused keeps its bytes reachable: the dialog
            is the read-only view plus the raw export. */}
        <RawDocumentDialog failure={loadFailure} onClose={() => setLoadFailure(null)} />
      </div>
    )
  }

  return (
    <CommandRegistryProvider value={commandRegistry}>
    <div className="document-viewer">
      <AssemblyToolbar
        docName={docName}
        onRename={handleRename}
        handleSave={handleSave}
        handleClone={handleClone}
        onImport={handleImportStep}
        onExport={() => executeCommand('export_assembly')}
      />
      <div className={`doc-container${panelsOpen ? ' panels-open' : ''}`}>
        <div className="doc-editor">
          <div className="editor-toolbar">
            <PanelsToggle open={panelsOpen} onToggle={() => setPanelsOpen(v => !v)} />
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
          </div>
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
          <div className="viewport-stage">
            <EditorErrorBoundary label="assembly viewport">
              <AssemblyViewport
                ref={viewportRef}
                readout={<AssemblyMeasurementDisplay measurementIcon={measurementIcon} />}
                // No Show group: an assembly has no feature tree, so the part
                // editor alone supplies the document-visibility rows.
                viewOptions={<ViewOptionsButton allowSectionPick={false} allowAmbientOcclusion={false} />}
              />
            </EditorErrorBoundary>
            {/* The assembly solve mirrors useSolverStore.isSolving and claims its
                onCancelSolve slot, so the shared overlay renders the spinner and
                cancel for a full (non-live) solve; it is opacity-0 when idle. */}
            <LoadingOverlay />
            {instances.length === 0 && mates.length === 0 && !error && (
              <p className="assembly-empty-hint">Empty assembly - insert parts to get started.</p>
            )}
            {/* Both overlay columns are positioning-only and click-through, so
                the gaps between the cards still orbit and pick in the viewport;
                each card opts back in (Glass.css `.glass-panel`). The left
                column is the navigator, the right one the open editor. */}
            <div className="floating-left">
              <AssemblyDocumentPanel
                instances={instances}
                builtins={builtins}
                mates={mates}
                status={solveStatus}
                labelFor={labelFor}
                subassemblies={subassemblyDocs}
                docKindOf={knownKind}
                docNames={docNames}
                hiddenLeafPaths={hiddenLeafPaths}
                onSetLeafVisible={(key, visible) => useAssemblyStore.getState().setLeafVisible(key, visible)}
                onRebuild={rebuild}
                isRebuilding={isSolving}
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
                onSelectMate={handleSelectMate}
                onEditMate={handleEditMate}
                onCommitMate={handleCommitMate}
                onCancelMate={handleCancelMate}
                onDeleteMate={(featureId) => executeCommand('delete_mate', featureId)}
                onRequestRenameMate={requestRenameMate}
              />
            </div>
            {editingSubject.kind !== 'none' && (
              <div className="floating-right">
                {/* The same stack the part editor uses, so the edit card and
                    its status card keep that column's gap and its phone
                    scroll behaviour. */}
                <div className="right-overlay-stack">
                  <AssemblyEditPanel
                    editing={editingSubject}
                    instances={instances}
                    mates={mates}
                    status={solveStatus}
                    labelFor={labelFor}
                    onCommitInstance={handleCommitInstance}
                    onCancelInstance={handleCancelInstance}
                    onCommitMate={handleCommitMate}
                    onCancelMate={handleCancelMate}
                    onRenameMate={requestRenameMate}
                    renderInstanceEditor={renderInstanceEditor}
                    renderMateEditor={(mate) => renderMateEditor(mate)}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
      <AssemblyPartPicker
        isOpen={pickerOpen}
        selfUuid={uuid}
        session={session}
        entries={partList?.entries ?? null}
        refreshing={partListRefreshing}
        listError={partListError}
        onRefresh={refreshPartListNow}
        cycleReasonFor={cycleReasonFor}
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
      <StepImportDialog
        isOpen={stepImport !== null}
        fileName={stepImport?.fileName ?? ''}
        variant="assembly"
        onImport={mode => { void handleStepImportConfirm(mode) }}
        onCancel={() => setStepImport(null)}
      />
      <AssemblyExport ref={exportRef} doc={doc} docName={docName} docNames={docNames} />
    </div>
    </CommandRegistryProvider>
  )
}
