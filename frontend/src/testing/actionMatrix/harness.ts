// The headless harness behind one action-matrix entry: a fresh DocSession over
// a corpus document, the real part command table registered against the real
// stores, and a PartCommandContext whose callbacks perform the same session
// calls Part.tsx's handlers do. Nothing here calls a mutation handler or a
// spec body directly: every entry goes registry.execute -> spec.run -> context
// callback -> DocSession, the path a user's click or keypress takes.
//
// The page callbacks that need solved bodies or React lifecycle (the 3D half
// of delete_selected, the add-feature edit-session wrapper) are bounded to the
// document-only equivalent, with the divergence named at each callback. The
// matrix targets come from the document itself, so body picks cannot occur.
import type { PartDoc, PartFeature, Mutation, Sketch, SketchData } from '@/types/cad'
import { createDocSession, type DocSession, type EditorFacts } from '@/session/DocSession'
import type { SolveScheduler } from '@/session/SolveScheduler'
import type { DirtyFacts } from '@/session/dirty'
import type { Result, SessionFailure } from '@/session/result'
import { CommandRegistry, type CommandResult } from '@/utils/core/commandSpec'
import type { CommandName } from '@/utils/core/commandNames'
import {
  PART_COMMAND_SPECS,
  getSketchState,
  type PartCommandContext,
  type PartCommandSpec,
  type ShowMessagePayload,
} from '@/pages/commandEntries'
import { useEditorState } from '@/hooks/useEditorState'
import { setSketchCallback, useSketchUiStore } from '@/stores/sketchEditorStore'
import { sketchOwnedDeleteTargets } from '@/stores/editorState'
import { randomId } from '@/utils/yamlMutations/helpers'
import { initializeTools } from '@/tools'
import type { MatrixTarget } from './corpus'

// The same store reset stores/__tests__/helpers/sketchEditorStoreTestSetup
// performs, inlined because that helper imports vitest's beforeEach at module
// top and the regeneration script runs through vite-node, which cannot load a
// module touching vitest. Keep the two field lists in step.
function resetMatrixStores(): void {
  useEditorState.setState({
    normalSelection: new Set(),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    selectionDomain: 'sketch_2d',
    hoveredSelectionId: null,
    hoveredPickKey: null,
    isPointerDown: false,
    drag: null,
    activeTool: null,
    activeFeatureId: null,
    dimensionPicks: [],
    pendingBrepProjectionIds: [],
    activePickField: null,
    hoveredVertexId: null,
    hoveredVertexPosition: null,
    hoveredSnapKind: null,
    hoveredConstraintEntityIds: new Set(),
    modeStack: [],
    entityKindMap: {},
  })
  useSketchUiStore.setState({ pendingDialog: null })
  setSketchCallback('onMutation', null)
  setSketchCallback('onMutationBatch', null)
  setSketchCallback('beginBrepProjection', null)
  setSketchCallback('cancelBrepProjection', null)
}

// The solver the session schedules into: the fake one from the session suites,
// or the real solveLocally-backed one. Same shape as the fuzz driver's.
export interface MatrixSolver {
  scheduler: SolveScheduler<PartDoc>
  settle(): void
}

export interface MatrixHarness {
  session: DocSession
  registry: CommandRegistry<PartCommandContext>
  // Every showMessage the run produced, in order: the constraint rejections and
  // not-implemented notices that are the command's observable refusal.
  messages: ShowMessagePayload[]
  // Session failures observed on the sketch mutation seam. The UI surfaces
  // these through failLoud (a throw in test mode, a warning in dev), which the
  // matrix cannot use: the regeneration script runs through vite-node
  // (MODE=development) while the suites run through vitest (MODE=test), and a
  // mode-dependent handler would make the committed baseline depend on how it
  // was generated. Recording the Result keeps both runs identical; the runner
  // turns the first failure into a failed entry, so a store-driven command
  // cannot hide a failed mutation behind the ok its body returns.
  mutationFailures: SessionFailure[]
  // The exact callbacks the store seam is wired to, exposed so the contract
  // test can drive the failure path without a corpus row.
  handleMutation(mutation: Mutation): Result
  handleMutationBatch(mutations: Mutation[]): Result
  // Registers a spec after the real table (used by the contract-test seam).
  register(spec: PartCommandSpec): void
  // Runs one command and settles the session: fake schedulers have to flush,
  // real ones settle on their own, so this is the one await point per entry.
  run(command: CommandName, params?: unknown): Promise<CommandResult>
  dispose(): void
}

// Installs the target's selection into the real stores, exactly the state the
// UI would hold when the user's click precedes the command. entityKindMap is
// populated for the whole document because applyConstraint reads kinds for the
// selected entity ids.
export function installTarget(spec: PartDoc, target: MatrixTarget): void {
  const entityKindMap: Record<string, string> = {}
  for (const feature of spec.features ?? []) {
    if (feature.kind !== 'sketch') continue
    for (const entity of feature.entities ?? []) {
      entityKindMap[`entity:${feature.id}:${entity.id}`] = entity.kind
    }
  }
  useEditorState.setState({
    normalSelection: target.kind === 'none' ? new Set<string>() : new Set<string>([target.id]),
    selectedPicks: new Map(),
    chipOwnedSelection: new Set(),
    activeFeatureId: target.featureId,
    entityKindMap,
  })
}

export function createMatrixHarness(spec: PartDoc, solver: MatrixSolver): MatrixHarness {
  // A fresh tool registry and a store reset per entry: a command leaving the
  // mode stack or a callback behind must not leak into the next entry.
  initializeTools()
  resetMatrixStores()
  const initialDoc = structuredClone(spec)
  const cell: { current: PartDoc | null } = { current: initialDoc }
  const facts: EditorFacts = {
    editingFeatureId: null,
    // The page syncs the rollback bar from the loaded doc (syncRollbackFromDoc),
    // so a mutation's mirror writes back the doc's own position.
    rollbackPosition: initialDoc.rollback ?? null,
  }
  const dirty: DirtyFacts = { dirty: false, saves: 0, savedHash: null }
  const solveResults: { current: Record<string, SketchData> } = { current: {} }
  const session = createDocSession({
    cloneDoc: doc => structuredClone(doc),
    doc: { get: () => cell.current, set: next => { cell.current = next } },
    solve: solver.scheduler,
    solveResults: { get: () => solveResults.current, set: next => { solveResults.current = next } },
    editorFacts: () => ({ editingFeatureId: facts.editingFeatureId, rollbackPosition: facts.rollbackPosition }),
    dirtyFacts: () => dirty,
  })

  // The sketch store's mutation seam, the same registration Part.tsx performs
  // on mount; a store-driven command body (constraints, offset, delete) lands
  // through here. Part.tsx's handleMutation reports a non-ok Result through
  // failLoud; the harness records it instead (see mutationFailures) so vitest
  // and the vite-node regeneration script classify a run identically.
  const mutationFailures: SessionFailure[] = []
  const record = (result: Result): Result => {
    if (!result.ok) mutationFailures.push(result)
    return result
  }
  const handleMutation = (mutation: Mutation): Result => record(session.execute(mutation))
  const handleMutationBatch = (mutations: Mutation[]): Result => record(session.executeGroup(mutations))
  setSketchCallback('onMutation', m => { handleMutation(m) })
  setSketchCallback('onMutationBatch', ms => { handleMutationBatch(ms) })
  setSketchCallback('onRebuild', () => {})
  setSketchCallback('onExitSketch', () => {})
  setSketchCallback('getSketch', featureId => {
    const feature = cell.current?.features?.find(f => f.id === featureId)
    return feature?.kind === 'sketch' ? feature as unknown as Sketch : null
  })
  setSketchCallback('beginBrepProjection', () => { session.begin('brep') })
  setSketchCallback('cancelBrepProjection', () => {
    const brep = session.transactions().find(txn => txn.kind === 'brep')
    if (brep) session.cancel(brep.id)
  })

  const messages: ShowMessagePayload[] = []
  const features = (): PartFeature[] => cell.current?.features ?? []

  // Part.tsx's handleDeleteSelectedFeatures without solved bodies: the doc-only
  // target set never contains a body pick, so the 3D branch collapses to the
  // feature deletes the tree performs; a sketch selection keeps the store's own
  // deleteSelected. The mixed selection is still one executeGroup, one undo
  // entry, as the page folds it.
  const deleteSelectedFeatures = (): void => {
    const store = useEditorState.getState()
    const selection = store.normalSelection
    const featureDeletes: Mutation[] = []
    for (const id of selection) {
      if (!id.startsWith('@') || id.startsWith('@builtin_')) continue
      const ref = id.slice(1)
      if (features().some(f => f.id === ref)) featureDeletes.push({ type: 'delete_feature', featureId: ref })
    }
    const sketchDelete = sketchOwnedDeleteTargets(selection, store.activeFeatureId)
    if (featureDeletes.length > 0) {
      const group: Mutation[] = sketchDelete.length > 0
        ? [{ type: 'delete', targets: sketchDelete }, ...featureDeletes]
        : featureDeletes
      session.executeGroup(group)
      store.clearSelectionAfterDelete()
      return
    }
    store.deleteSelected()
  }

  // Part.tsx's handleAddFeature minus the React lifecycle (edit-session open,
  // rollback and pick-field staging): the document effect is the same mutation
  // with a freshly minted id and the same label shape.
  const addFeature = (kind: string, extra?: Record<string, unknown>): Result => {
    const featureId = randomId(18)
    const label = `${kind} ${(features()?.length ?? 0) + 1}`
    return session.execute({ type: `add_${kind}`, featureId, label, ...extra } as Mutation)
  }

  const context: PartCommandContext = {
    editor: 'part',
    session,
    state: getSketchState,
    undo: () => { session.undo() },
    redo: () => { session.redo() },
    deleteSelectedFeatures,
    toggleSketchPlaneVisibility: () => { session.execute({ type: 'toggle_sketch_plane_visibility' }) },
    togglePlaneVisibility: () => { session.execute({ type: 'toggle_plane_visibility' }) },
    addFeature,
    showMessage: payload => { messages.push(payload) },
  }

  const registry = new CommandRegistry<PartCommandContext>(() => context)
  for (const commandSpec of PART_COMMAND_SPECS) registry.register(commandSpec)

  return {
    session,
    registry,
    messages,
    mutationFailures,
    handleMutation,
    handleMutationBatch,
    register(spec) {
      registry.register(spec)
    },
    async run(command, params) {
      const result = registry.execute(command, params)
      solver.settle()
      await session.idle()
      return result
    },
    dispose() {
      setSketchCallback('onMutation', null)
      setSketchCallback('onMutationBatch', null)
      setSketchCallback('onRebuild', null)
      setSketchCallback('onExitSketch', null)
      setSketchCallback('getSketch', null)
      setSketchCallback('beginBrepProjection', null)
      setSketchCallback('cancelBrepProjection', null)
      useSketchUiStore.setState({ pendingDialog: null })
    },
  }
}
