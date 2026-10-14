// The session/solver publication store. Its fields are the live facts the
// session engine and the solver produce -- doc, features, history stacks,
// solve results, bodies, timings and validation -- and each one is written by
// exactly one publisher at the point it is produced (usePartDoc for the
// session facts, useSolver for the solve facts, the page for doc-derived view
// data). It is not editor state: rollbackPosition, pickBoundary and
// editingFeatureId live in stores/editorState.ts, and the viewport's derived
// non-solve fields (ghostMode, partColors, partStyle, activeSketchFeatureId)
// live there too. The old useSyncPartEditorStore mirror that copied React state
// through setSnapshot is gone; nothing here merges snapshots.
import { create } from 'zustand'
import type { BodyResult, PartFeature, PartDoc, Sketch, Mutation, RebuildValidation } from '@/types/cad'

type UndoEntry = { doc: unknown; mutation: Mutation }

export interface PartEditorData {
  features: PartFeature[]
  doc: PartDoc | null
  visibleFeatures: Set<string>
  visibleBodies: Set<string> | undefined
  partLabels: Record<string, string>
  solveResults: Record<string, unknown>
  bodies: Record<string, BodyResult>
  pickBodies: Record<string, BodyResult>
  isRebuilding: boolean
  featureTimings: Record<string, number>
  validation: RebuildValidation | null
  otherSketches: Record<string, Sketch>
  undoStack: UndoEntry[]
  redoStack: UndoEntry[]
}

export const DEFAULT_PART_EDITOR_DATA: PartEditorData = {
  features: [],
  doc: null,
  visibleFeatures: new Set(),
  visibleBodies: undefined,
  partLabels: {},
  solveResults: {},
  bodies: {},
  pickBodies: {},
  isRebuilding: false,
  featureTimings: {},
  validation: null,
  otherSketches: {},
  undoStack: [],
  redoStack: [],
}

interface PartEditorState extends PartEditorData {
  // The session facts: the adapter publishes them as the session moves, so the
  // session is the single writer and components read one copy.
  publishSession: (data: Pick<PartEditorData, 'doc' | 'features' | 'undoStack' | 'redoStack'>) => void
  // The solve facts: useSolver publishes them where it used to set its own
  // React state, so the solver remains the writer.
  publishSolve: (data: Pick<PartEditorData, 'solveResults' | 'bodies' | 'pickBodies' | 'featureTimings' | 'validation'>) => void
  // The doc-derived view data the page computes (visibility sets, labels,
  // sibling sketches) plus its own rebuild flag. Editor-derived fields
  // (ghostMode, partColors, partStyle, activeSketchFeatureId) go to the L2
  // store instead.
  publishDerived: (data: Pick<PartEditorData, 'visibleFeatures' | 'visibleBodies' | 'partLabels' | 'otherSketches' | 'isRebuilding'>) => void
  // The canonical wipe for the whole publication store: the editor's unmount
  // calls this so a keyed remount cannot paint the previous document's facts
  // before the new session publishes its own. Delegated to by the call site,
  // never hand-listed there.
  resetPublishedState: () => void
}

export const usePartEditorStore = create<PartEditorState>((set) => ({
  ...DEFAULT_PART_EDITOR_DATA,
  publishSession: (data) => set(data),
  publishSolve: (data) => set(data),
  publishDerived: (data) => set(data),
  resetPublishedState: () => set({ ...DEFAULT_PART_EDITOR_DATA }),
}))
