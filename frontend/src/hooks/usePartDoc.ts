import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { PartDoc, Mutation, SketchData } from '@/types/cad'
import { useDocumentState } from '@/hooks/useDocumentState'
import { useSolver } from '@/hooks/useSolver'
import { createDocSession, clampRollbackPosition, type DocSession } from '@/session/DocSession'
import type { SessionFailure } from '@/session/result'
import { cloneDocForUndo } from '@/utils/yamlMutations/undoSnapshot'
import { createWorkerSolveScheduler, type ReSolveFn } from '@/hooks/workerSolveScheduler'
import { failLoud } from '@/stores/stateInvariants'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { usePartEditorStore } from '@/stores/partEditorStore'

export { BUILTIN_FEATURE_DEFAULTS, BUILTIN_FEATURE_IDS } from '@/hooks/useDocumentState'

// The pinned refusal messages, transcribed from the pre-session hook: the
// session returns neutral error codes and this adapter is the part editor's
// voice, so the existing guard suites keep pinning the exact text.
const LEGACY_FAILURE_MESSAGES: Partial<Record<SessionFailure['code'], string>> = {
  'preview-already-open': '[usePartDoc] startPreviewMode called while a preview is already active (nested preview not supported)',
  'preview-over-session': '[usePartDoc] startPreviewMode called while an edit session is active (a session owns the document until commit or cancel)',
  'edit-already-open': '[usePartDoc] startEditSession called while an edit session is already active (nested edit session not supported)',
  'rollback-unsynced': '[usePartDoc] set_rollback dispatched with the rollback store not pre-synced',
}

// The toolbar and the debug panel read `entry.mutation`; every session push
// stores the mutation behind the label, and this is the belt-and-braces carrier
// for a history entry that predates one (the contract suite's synthetic pushes).
const labelCarrier = (label: string): Mutation => ({ type: 'preview_commit', description: label })

type StackEntry = { doc: PartDoc; mutation: Mutation }

export function usePartDoc(uuid: string | undefined, { solveOnLoad = true, onFirstSolve, workspace }: { solveOnLoad?: boolean; onFirstSolve?: () => void; workspace?: string } = {}) {
  const reSolveRef = useRef<ReSolveFn | null>(null)
  // Set by the page: the transient editor state that does not live in the
  // session (forced visibility, sketch-editor selection/pick, popovers, panel
  // mode). The adapter runs it on the engine's teardown event.
  const undoTeardownRef = useRef<(() => void) | null>(null)

  const {
    doc, setDoc, docRef, docName,
    loading, error, setError,
    saveDoc, renameDoc, cloneDoc,
  } = useDocumentState(uuid, reSolveRef, { solveOnLoad, workspace })

  // The solver state the session reads through its ports. The setters land via
  // effects because useSolver is called after the session; a mutation only runs
  // from an event, by which time both refs are filled.
  const solveResultsRef = useRef<Record<string, SketchData>>({})
  const setSolveResultsRef = useRef<((next: Record<string, SketchData>) => void) | null>(null)
  const validationRef = useRef<unknown>(null)
  const bodiesRef = useRef<unknown>(null)

  // One session per mounted editor, created lazily on first render. Its ports
  // read the refs and stores live, so the captured closures never go stale.
  // The refs reach createDocSession only inside those ports; the session calls
  // them from event paths and never during render, which the refs rule cannot
  // see through the object literal.
  // eslint-disable-next-line react-hooks/refs -- the ports below are called by the session's event paths only
  const [session] = useState<DocSession>(() => createDocSession({
    cloneDoc: cloneDocForUndo,
    doc: {
      get: () => docRef.current,
      set: next => {
        docRef.current = next
        setDoc(next)
      },
    },
    solve: createWorkerSolveScheduler(() => reSolveRef.current),
    solveResults: {
      get: () => solveResultsRef.current,
      set: next => setSolveResultsRef.current?.(next),
    },
    editorFacts: () => {
      const store = usePartEditorStore.getState()
      return { editingFeatureId: store.editingFeatureId, rollbackPosition: store.rollbackPosition }
    },
    dirtyFacts: () => {
      const store = useUnsavedChangesStore.getState()
      return { dirty: store.dirty, saves: store.saves, savedHash: store.savedHash }
    },
    docId: uuid ?? null,
    getValidation: () => validationRef.current,
    getBodies: () => bodiesRef.current,
  }))

  const clearStashForSolved = useCallback((featureIds: string[]) => {
    session.clearStashForSolved(featureIds)
  }, [session])

  const {
    solveResults, setSolveResults, bodies, pickBodies, pickStateReady,
    solving, solveError, setSolveError,
    featureTimings, reSolve,
    validation,
  } = useSolver(uuid, { onFirstSolve, onSolveApplied: clearStashForSolved }, docRef, setDoc)

  useEffect(() => { reSolveRef.current = reSolve }, [reSolve])
  useEffect(() => { solveResultsRef.current = solveResults }, [solveResults])
  useEffect(() => { setSolveResultsRef.current = setSolveResults }, [setSolveResults])
  useEffect(() => { validationRef.current = validation }, [validation])
  useEffect(() => { bodiesRef.current = bodies }, [bodies])

  // The session is the store; every event bumps its version, so the hook
  // re-renders through useSyncExternalStore. The move events also perform the
  // editor writes the old engine did inline.
  const subscribe = useCallback((onStoreChange: () => void) => {
    return session.subscribe(event => {
      if (event.type === 'transactionsDropped') {
        // The page callback runs FIRST so it can still read which feature was
        // being edited; closing the store's editor fields here keeps this the
        // complete "abandon the editor" unit.
        undoTeardownRef.current?.()
        usePartEditorStore.getState().setEditingFeatureId(null)
        usePartEditorStore.getState().setPickBoundary(null)
      } else if (event.type === 'historyRestored') {
        usePartEditorStore.getState().setRollbackPosition(clampRollbackPosition(event.entry.doc))
        useUnsavedChangesStore.getState().setDirty(true)
      }
      onStoreChange()
    })
  }, [session])

  const getSnapshot = useCallback(() => session.version(), [session])
  const version = useSyncExternalStore(subscribe, getSnapshot)

  // A save landing moves the live facts; the session's dirty override (if any)
  // has done its job and the store flag decides again.
  useEffect(() => {
    let saves = useUnsavedChangesStore.getState().saves
    return useUnsavedChangesStore.subscribe(state => {
      if (state.saves !== saves) {
        saves = state.saves
        session.noteSaved()
      }
    })
  }, [session])

  const mirrorDirty = useCallback(() => {
    useUnsavedChangesStore.getState().setDirty(session.isDirty())
  }, [session])

  const reportFailure = useCallback((result: SessionFailure) => {
    failLoud(LEGACY_FAILURE_MESSAGES[result.code] ?? `[usePartDoc] ${result.message}`)
  }, [])

  const handleMutation = useCallback((m: Mutation) => {
    setSolveError(null)
    // No document yet: a silent no-op, exactly as the old funnel's null guard.
    if (!session.getDoc()) return
    const result = session.execute(m)
    if (!result.ok) reportFailure(result)
    mirrorDirty()
  }, [session, setSolveError, reportFailure, mirrorDirty])

  const commitMutationGroup = useCallback((ms: Mutation[]) => {
    setSolveError(null)
    if (!session.getDoc() || ms.length === 0) return
    const result = session.executeGroup(ms)
    if (!result.ok) reportFailure(result)
    mirrorDirty()
  }, [session, setSolveError, reportFailure, mirrorDirty])

  const findTransaction = useCallback((kind: 'preview' | 'edit' | 'brep'): string | null =>
    session.transactions().find(txn => txn.kind === kind)?.id ?? null, [session])

  const startPreviewMode = useCallback((originalDoc: PartDoc) => {
    const result = session.begin('preview', { baseline: originalDoc })
    if (!result.ok) reportFailure(result)
  }, [session, reportFailure])

  const commitPreview = useCallback((mutation: Mutation) => {
    const id = findTransaction('preview')
    if (!id) {
      failLoud('[usePartDoc] commitPreview called with no active preview')
      return
    }
    session.commit(id, { mutation })
    mirrorDirty()
  }, [session, findTransaction, mirrorDirty])

  const cancelPreview = useCallback((): PartDoc | null => {
    const id = findTransaction('preview')
    if (!id) return null
    session.cancel(id)
    mirrorDirty()
    return session.getDoc()
  }, [session, findTransaction, mirrorDirty])

  const startEditSession = useCallback((suppressUndo: boolean) => {
    if (!session.getDoc()) return
    const result = session.begin('edit', { suppressed: suppressUndo })
    if (!result.ok) reportFailure(result)
  }, [session, reportFailure])

  const commitEditSession = useCallback(() => {
    const id = findTransaction('edit')
    if (!id) return
    session.commit(id)
    mirrorDirty()
  }, [session, findTransaction, mirrorDirty])

  const cancelEditSession = useCallback(() => {
    const id = findTransaction('edit')
    if (id) {
      session.cancel(id)
      const restored = session.getDoc()
      if (restored) usePartEditorStore.getState().setRollbackPosition(clampRollbackPosition(restored))
    } else {
      // No session (the add-and-enter pattern sets only editingFeatureId): the
      // exit still re-solves so the viewport is not left on a discarded edit.
      session.refreshSolve()
    }
    mirrorDirty()
  }, [session, findTransaction, mirrorDirty])

  const beginBrepProjection = useCallback(() => {
    session.begin('brep')
  }, [session])

  const cancelBrepProjection = useCallback(() => {
    const id = findTransaction('brep')
    if (id) session.cancel(id)
  }, [session, findTransaction])

  const handleUndo = useCallback(() => { session.undo() }, [session])

  const handleRedo = useCallback(() => { session.redo() }, [session])

  const registerUndoTeardown = useCallback((fn: (() => void) | null) => {
    undoTeardownRef.current = fn
  }, [])

  const stacks = useMemo(() => {
    const entries = session.historyEntries()
    const toStack = (list: readonly { doc: PartDoc; label: string; meta?: Mutation }[]): StackEntry[] =>
      list.map(entry => ({ doc: entry.doc, mutation: entry.meta ?? labelCarrier(entry.label) }))
    // The snapshot carries the version it was built at; the counter is the
    // invalidation key, so the stacks keep their identity between events while
    // the store mirror's dependency check watches them.
    return { undoStack: toStack(entries.undo), redoStack: toStack(entries.redo), version }
  }, [session, version])
  const { undoStack, redoStack } = stacks

  return {
    doc,
    setDoc,
    docRef,
    docName,
    loading,
    error,
    setError,
    solveResults,
    setSolveResults,
    featureTimings,
    bodies,
    pickBodies,
    pickStateReady,
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
    startPreviewMode,
    commitPreview,
    cancelPreview,
    startEditSession,
    commitEditSession,
    cancelEditSession,
    registerUndoTeardown,
  }
}
