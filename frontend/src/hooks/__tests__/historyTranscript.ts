// A session script and its part-editor driver.
//
// A transcript is a list of the calls a user session makes: mutations, groups,
// preview/session/brep boundaries, a save landing, a rollback drag and history
// moves. The driver runs the steps in order through the REAL usePartDoc (the
// DocSession adapter) and mutationHandlers over the mocked document/solver
// seams (usePartDoc.undoHarness), then reads the observable end state once. The step
// and result types are plain data on purpose: a future DocSession driver
// reuses them unchanged, so nothing here may leak the part hook's shape.
import { act } from '@testing-library/react'
import { renderHookStrict } from '@/utils/testing/renderHookStrict'
import { usePartDoc } from '@/hooks/usePartDoc'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useUnsavedChangesStore } from '@/stores/unsavedChangesStore'
import { describeMutation } from '@/utils/core/mutationDescriptions'
import { docRef, resetHarness } from './usePartDoc.undoHarness'
import type { PartDoc, Mutation } from '@/types/cad'

export type TranscriptStep =
  | { kind: 'mutation'; mutation: Mutation }
  | { kind: 'group'; mutations: Mutation[] }
  | { kind: 'previewStart' }
  | { kind: 'previewCommit'; mutation: Mutation }
  | { kind: 'previewCancel' }
  | { kind: 'sessionStart'; suppressed: boolean; featureId?: string }
  | { kind: 'sessionCommit' }
  | { kind: 'sessionCancel' }
  | { kind: 'brepArm' }
  | { kind: 'brepCancel' }
  // A save landing: publishes the moved save count without a content
  // fingerprint, the shape a caller that cannot say what it wrote produces.
  | { kind: 'save' }
  | { kind: 'undo' }
  | { kind: 'redo' }
  // A rollback-bar drag: the store owns the position, the mirror writes the doc.
  | { kind: 'rollback'; position: number }

export interface TranscriptEditorState {
  editingFeatureId: string | null
  rollbackPosition: number | null
  pickBoundary: number | null
}

export interface TranscriptResult {
  doc: PartDoc | null
  undoLabels: string[]
  redoLabels: string[]
  dirty: boolean
  editorState: TranscriptEditorState
}

export interface TranscriptOptions {
  // An independent snapshot of the live doc after every step. Suites need it
  // when a handler mints random ids: comparing a redo against the forward doc
  // of the same run is well-defined, comparing across runs is not.
  onStep?: (doc: PartDoc | null, stepIndex: number) => void
}

// The page's resetEditState on the way out of an editor (useEditFeature): it
// clears the editing id and pick boundary and re-derives the bar from the live
// doc. Production runs it AFTER a commit (commitEditFeature) and BEFORE a
// cancel (cancelEditFeature, so the cancel's own replay and re-derivation read
// the parked position), so the driver keeps that order and a row appended after
// a session boundary reads the transient state the app would.
function exitEditCleanup(): void {
  const store = usePartEditorStore.getState()
  store.setEditingFeatureId(null)
  store.setPickBoundary(null)
  store.setRollbackPosition(docRef.current?.rollback ?? null)
}

function applyStep(hook: ReturnType<typeof usePartDoc>, step: TranscriptStep): void {
  switch (step.kind) {
    case 'mutation':
      hook.handleMutation(step.mutation)
      return
    case 'group':
      hook.commitMutationGroup(step.mutations)
      return
    case 'previewStart':
      hook.startPreviewMode(docRef.current as PartDoc)
      return
    case 'previewCommit':
      hook.commitPreview(step.mutation)
      return
    case 'previewCancel':
      hook.cancelPreview()
      return
    case 'sessionStart':
      // Production enters the session first and stamps the edited feature
      // afterwards (useEditFeature's enterEditFeature), so the id is set after
      // the session baseline exists, exactly as the page does it.
      hook.startEditSession(step.suppressed)
      if (step.featureId !== undefined) usePartEditorStore.getState().setEditingFeatureId(step.featureId)
      return
    case 'sessionCommit':
      hook.commitEditSession()
      exitEditCleanup()
      return
    case 'sessionCancel':
      exitEditCleanup()
      hook.cancelEditSession()
      return
    case 'brepArm':
      hook.beginBrepProjection()
      return
    case 'brepCancel':
      hook.cancelBrepProjection()
      return
    case 'save':
      useUnsavedChangesStore.getState().markSaved()
      return
    case 'undo':
      hook.handleUndo()
      return
    case 'redo':
      hook.handleRedo()
      return
    case 'rollback':
      usePartEditorStore.getState().setRollbackPosition(step.position)
      hook.handleMutation({ type: 'set_rollback', position: step.position })
      return
  }
}

export function runPartTranscript(
  startDoc: PartDoc,
  steps: TranscriptStep[],
  options: TranscriptOptions = {},
): TranscriptResult {
  resetHarness()
  docRef.current = structuredClone(startDoc)
  usePartEditorStore.getState().setPickBoundary(null)
  useUnsavedChangesStore.getState().setDirty(false)
  const { result } = renderHookStrict(() => usePartDoc('u', { solveOnLoad: false }))
  for (let i = 0; i < steps.length; i++) {
    act(() => { applyStep(result.current, steps[i]) })
    if (options.onStep) options.onStep(structuredClone(docRef.current), i)
  }
  return {
    doc: docRef.current,
    undoLabels: result.current.undoStack.map(e => describeMutation(e.mutation)),
    redoLabels: result.current.redoStack.map(e => describeMutation(e.mutation)),
    dirty: useUnsavedChangesStore.getState().dirty,
    editorState: {
      editingFeatureId: usePartEditorStore.getState().editingFeatureId,
      rollbackPosition: usePartEditorStore.getState().rollbackPosition,
      pickBoundary: usePartEditorStore.getState().pickBoundary,
    },
  }
}
