// The headless driver for the frozen session/history transcripts. It plays the
// adapter: a doc cell, the editor-facts and dirty-facts stubs the session reads
// through its ports, and the HistoryRestored and teardown UI writes the React
// adapter applies. The step and result types are historyTranscript's, imported
// type-only so the frozen table has one definition.
import type { PartDoc, SketchData } from '@/types/cad'
import {
  clampRollbackPosition,
  createDocSession,
  type DocSession,
  type TransactionKind,
} from '@/session/DocSession'
import type { TranscriptOptions, TranscriptResult, TranscriptStep } from '@/hooks/__tests__/historyTranscript'
import { createFakeSolveScheduler, type FakeSolveScheduler } from './fakeSolveScheduler'

export interface SessionTranscriptHarness extends TranscriptResult {
  session: DocSession
  solve: FakeSolveScheduler<PartDoc>
  docCell: { current: PartDoc | null }
  solveResults: { current: Record<string, SketchData> }
  editorFacts: { editingFeatureId: string | null; rollbackPosition: number | null; pickBoundary: number | null }
  dirtyFacts: { dirty: boolean; saves: number; savedHash: number | null }
}

export function runSessionTranscript(
  startDoc: PartDoc,
  steps: TranscriptStep[],
  options: TranscriptOptions = {},
): SessionTranscriptHarness {
  const docCell: { current: PartDoc | null } = { current: structuredClone(startDoc) }
  const editorFacts = {
    editingFeatureId: null as string | null,
    rollbackPosition: null as number | null,
    // UI-only (the session does not own the pick boundary); the driver clears it
    // on the teardown event exactly as the adapter does.
    pickBoundary: null as number | null,
  }
  const dirtyFacts = { dirty: false, saves: 0, savedHash: null as number | null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const solve = createFakeSolveScheduler<PartDoc>()
  const session = createDocSession({
    cloneDoc: doc => structuredClone(doc),
    doc: { get: () => docCell.current, set: next => { docCell.current = next } },
    solve,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({
      editingFeatureId: editorFacts.editingFeatureId,
      rollbackPosition: editorFacts.rollbackPosition,
    }),
    dirtyFacts: () => dirtyFacts,
  })

  const mirrorDirty = () => {
    const decision = session.takeDirtyDecision()
    if (decision !== null) dirtyFacts.dirty = decision
  }
  const exitEditCleanup = () => {
    editorFacts.editingFeatureId = null
    editorFacts.pickBoundary = null
    editorFacts.rollbackPosition = docCell.current?.rollback ?? null
  }
  const findId = (kind: TransactionKind): string | null =>
    session.transactions().find(txn => txn.kind === kind)?.id ?? null

  session.subscribe(event => {
    if (event.type === 'transactionsDropped') {
      // The adapter's teardown: the page callback runs first in production,
      // then the editor fields it owns.
      editorFacts.editingFeatureId = null
      editorFacts.pickBoundary = null
    } else if (event.type === 'historyRestored') {
      editorFacts.editingFeatureId = null
      editorFacts.pickBoundary = null
      editorFacts.rollbackPosition = clampRollbackPosition(event.entry.doc)
      dirtyFacts.dirty = true
    }
  })

  const applyStep = (step: TranscriptStep): void => {
    switch (step.kind) {
      case 'mutation':
        session.execute(step.mutation)
        mirrorDirty()
        return
      case 'group':
        session.executeGroup(step.mutations)
        mirrorDirty()
        return
      case 'previewStart':
        session.begin('preview', { baseline: docCell.current ?? undefined })
        return
      case 'previewCommit': {
        const id = findId('preview')
        if (id) session.commit(id, { mutation: step.mutation })
        mirrorDirty()
        return
      }
      case 'previewCancel': {
        const id = findId('preview')
        if (id) session.cancel(id)
        mirrorDirty()
        return
      }
      case 'sessionStart': {
        session.begin('edit', { suppressed: step.suppressed })
        // Production enters the session first and stamps the edited feature
        // afterwards (useEditFeature's enterEditFeature).
        if (step.featureId !== undefined) editorFacts.editingFeatureId = step.featureId
        return
      }
      case 'sessionCommit': {
        const id = findId('edit')
        if (id) session.commit(id)
        mirrorDirty()
        exitEditCleanup()
        return
      }
      case 'sessionCancel': {
        exitEditCleanup()
        const id = findId('edit')
        if (id) session.cancel(id)
        else session.refreshSolve()
        // The adapter re-derives the bar from the restored doc after a cancel.
        if (docCell.current) editorFacts.rollbackPosition = clampRollbackPosition(docCell.current)
        mirrorDirty()
        return
      }
      case 'brepArm':
        session.begin('brep')
        return
      case 'brepCancel': {
        const id = findId('brep')
        if (id) session.cancel(id)
        return
      }
      case 'save':
        // The store's markSaved with no fingerprint.
        dirtyFacts.dirty = false
        dirtyFacts.saves += 1
        dirtyFacts.savedHash = null
        session.noteSaved()
        return
      case 'undo':
        session.undo()
        mirrorDirty()
        return
      case 'redo':
        session.redo()
        mirrorDirty()
        return
      case 'rollback':
        editorFacts.rollbackPosition = step.position
        session.execute({ type: 'set_rollback', position: step.position })
        mirrorDirty()
        return
    }
  }

  for (let i = 0; i < steps.length; i++) {
    applyStep(steps[i])
    if (options.onStep) options.onStep(structuredClone(docCell.current), i)
  }

  return {
    doc: docCell.current,
    undoLabels: session.historyEntries().undo.map(entry => entry.label),
    redoLabels: session.historyEntries().redo.map(entry => entry.label),
    dirty: dirtyFacts.dirty,
    editorState: {
      editingFeatureId: editorFacts.editingFeatureId,
      rollbackPosition: editorFacts.rollbackPosition,
      pickBoundary: editorFacts.pickBoundary,
    },
    session,
    solve,
    docCell,
    solveResults,
    editorFacts,
    dirtyFacts,
  }
}
