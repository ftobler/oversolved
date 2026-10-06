import { vi } from 'vitest'
import { usePartEditorStore } from '@/stores/partEditorStore'
import { useSketchEditorStore, setSketchCallback } from '@/stores/sketchEditorStore'
import type { PartDoc, Mutation } from '@/types/cad'

// Exercises usePartDoc against the REAL useUndoRedo and the REAL mutation
// handlers. The other usePartDoc undo tests mock the stack out, so they only
// prove which calls were made -- never that an edit session, a preview and the
// stack actually compose. This is the flow a user walks.
//
// The undo integration, preview boundary and brep-gesture suites each mount the
// same harness, so the mock header and the fixture helpers live here once.

export const makeDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'extrude-1', kind: 'extrude', label: 'first' }],
} as unknown as PartDoc)

export const makeSketchDoc = (): PartDoc => ({
  version: 1,
  kind: 'part',
  features: [{ id: 'sk1', kind: 'sketch' }],
} as unknown as PartDoc)

export const docRef = { current: makeDoc() }
export const reSolve = vi.fn()

// The mocked module shapes. Each test file registers them with vi.mock through
// an async import of this module, so the factory runs after the module is
// evaluated and docRef/reSolve keep their identity across the suite.
export const documentStateMock = () => ({
  useDocumentState: () => ({
    doc: docRef.current, docRef, docName: 'test', setDocName: vi.fn(),
    setDoc: (d: PartDoc) => { docRef.current = d },
    loading: false, error: null, setError: vi.fn(),
    saveDoc: vi.fn(), renameDoc: vi.fn(), cloneDoc: vi.fn(),
  }),
  BUILTIN_FEATURE_DEFAULTS: {},
  BUILTIN_FEATURE_IDS: new Set<string>(),
})

export const solverMock = () => ({
  useSolver: () => ({
    solveResults: {}, setSolveResults: vi.fn(), bodies: {}, pickBodies: {},
    solving: false, solveError: null, setSolveError: vi.fn(), solveResult: null,
    featureTimings: {}, reSolve, validation: null,
  }),
})

export const renameTo = (label: string): Mutation =>
  ({ type: 'rename_feature', featureId: 'extrude-1', label }) as Mutation

export const labelOf = () => (docRef.current.features?.[0] as { label?: string }).label

export const sketchEntitiesOf = (): { id: string; kind: string }[] =>
  (docRef.current.features?.[0] as { entities: { id: string; kind: string }[] }).entities ?? []

export const sketchConstraintsOf = (): { kind: string }[] =>
  (docRef.current.features?.[0] as { constraints?: { kind: string }[] }).constraints ?? []

// The per-test reset every suite opens with: park the doc back at the fixture
// and clear the transient stores and sketch callbacks, so a leaked callback or
// suppress flag from one test cannot reach the next.
export const resetHarness = (): void => {
  docRef.current = makeDoc()
  reSolve.mockClear()
  usePartEditorStore.getState().setEditingFeatureId(null)
  usePartEditorStore.getState().setRollbackPosition(null)
  useSketchEditorStore.getState().resetTransientState()
  setSketchCallback('onMutation', null)
  setSketchCallback('onMutationBatch', null)
  setSketchCallback('beginBrepProjection', null)
  setSketchCallback('cancelBrepProjection', null)
  setSketchCallback('getSketch', null)
}
