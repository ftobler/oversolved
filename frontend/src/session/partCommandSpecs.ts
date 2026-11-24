import { CONSTRAINTS, ENTITIES, CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import type { ConstraintDef } from '@/registry'
import type { DocSession } from '@/session/DocSession'
import type { Result } from '@/session/result'
import { okResult } from '@/session/result'
import type { ActiveTool } from '@/types/cad'
import { filletSelectionPlan, mirrorSelectionPlan, patternSelectionPlan } from '@/utils/geometry/selectionPlans'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import { CORE_KEYBINDINGS, SKETCH_KEYBINDINGS } from '@/utils/core/keymaps'
import { CANNOT_APPLY_TITLE } from '@/utils/core/applyTitles'
import { canFinishDraw } from '@/utils/geometry/drawFinish'
import { narrowCommandName } from '@/utils/core/commandNames'
import { cannotEvaluate } from '@/utils/core/valueRules'
import { evalExpr } from '@/kernel/evalExpr'
import { planPatternEntities } from '@/utils/yamlMutations/sketchPattern'
import { MAX_PATTERN_INSTANCES } from '@/utils/geometry/sketchPattern'
import type { CommandName } from '@/utils/core/commandNames'
import { noParams, objectParams, Field, type CommandResult, type ErasedCommandSpec, type CommandSpec, type FieldSpec, type ParseOutcome } from '@/utils/core/commandSpec'
import { projectedSelectionTargets, type FreezeProjectionMode } from '@/utils/yamlMutations/freezeProjection'
import { DEFAULT_EXTRUDE_DISTANCE } from '@/utils/yamlMutations'
import type { FilletCornerMap } from '@/utils/geometry/filletCorner'

// The four ordered outcomes of the Escape key in the sketch editor. The first
// matching rule wins, so this is the single source of truth the `cancel_draw`
// command body and its tests both read from:
//   - 'modal'          a modal or the sketch value dialog owns Escape; do nothing.
//   - 'pick'           a pick field is open; clear the draw and drop the field.
//   - 'cancel_gesture' something is mid-draw (draw points or dimension picks);
//                      cancel just that, keep the armed tool so the next click
//                      starts a fresh entity.
//   - 'disarm'         nothing in progress; clear the draw and disarm the tool.
export type EscapeStage = 'modal' | 'pick' | 'cancel_gesture' | 'disarm'

export function escapeStage(fields: {
  modalOwns: boolean
  pendingDialog: unknown
  activePickField: unknown
  // drawPoints array from the store; length > 0 means an entity is half-placed.
  drawPoints: { length: number }
  // dimensionPicks array from the store; length > 0 means a dim is half-built.
  dimensionPicks: { length: number }
}): EscapeStage {
  if (fields.modalOwns || fields.pendingDialog !== null) return 'modal'
  if (fields.activePickField !== null) return 'pick'
  if (fields.drawPoints.length > 0 || fields.dimensionPicks.length > 0) return 'cancel_gesture'
  return 'disarm'
}

// The cancel half of the `cancel_draw` 'cancel_gesture' arm, shared with the
// undo command's first stage so the two cannot drift: both drop just the entity
// in progress and keep the armed tool for the next click. clearDraw first, then
// the dimension-only scratch cleanup that mirrors what setActiveTool does on a
// real tool switch (dropping the projections the gesture materialised).
export function cancelInProgressGesture(st: {
  clearDraw: () => void
  dimensionPicks: { length: number }
  cancelPlacementGesture: () => void
  clearDimensionPicks: () => void
}) {
  st.clearDraw()
  if (st.dimensionPicks.length > 0) {
    st.cancelPlacementGesture()
    st.clearDimensionPicks()
  }
}

export interface ShowMessagePayload {
  title: string
  message: string
  variant?: 'info' | 'success' | 'error'
}

// The part of the editor state a part command reads. It is structural rather
// than a store type so this table stays in the core: the page passes its live
// editor state, and a headless context passes the defaults no session drives.
export interface PartCommandState {
  activeFeatureId: string | null
  normalSelection: Set<string>
  entityKindMap: Record<string, string>
  constructionEntityKeys: ReadonlySet<string>
  filletCornerMap: FilletCornerMap
  activeTool: ActiveTool
  drawPoints: readonly [number, number][]
  dimensionPicks: readonly unknown[]
  // The constraint id a placement prompt is open for (null when no placement
  // editor is up) and the projections the gesture materialized. Undo and redo
  // resolve that gesture before they pop or reach history.
  pendingPlacementConstraintId: string | null
  pendingBrepProjectionIds: readonly string[]
  activePickField: unknown
  pendingDialog: unknown
  setActiveTool(tool: ActiveTool): void
  setActivePickField(field: unknown): void
  clearDraw(): void
  finishDraw(): boolean
  cancelPlacementGesture(): void
  commitPlacementGesture(): void
  clearDimensionPicks(): void
  toggleConstruction(): void
  mirrorSelection(): string | null
  filletCorners(radius: number): string | null
  patternEntities(count: number, pitch: number): string | null
  applyOffset(distance: number): void
  applyConstraint(kind: string): string | null
  freezeProjection(mode: FreezeProjectionMode): void
}

/**
 * The live inputs of the sketch/part command table. The page builds one of
 * these around its session and page callbacks; a spec body reads everything it
 * needs from here, so a spec is static data and the table can be enumerated
 * headlessly. `state` and the page callbacks are the injected ports: the core
 * never imports the editor stores or the selection tools.
 */
export interface PartCommandContext {
  editor: 'part'
  // The live session. Undo/redo availability is read from its history, the
  // same stacks the toolbar mirrors.
  session: DocSession | null
  // The live editor state, read at call time. The page merges the L2 store and
  // the sketch UI store; a headless run supplies idle defaults.
  state(): PartCommandState
  undo(): void
  redo(): void
  // The page folds a mixed sketch and 3D selection through several stores and
  // returns nothing; a headless context that cannot perform the delete returns
  // a failure Result so the command never reads as an ok that did nothing.
  deleteSelectedFeatures(): CommandResult | void
  toggleSketchPlaneVisibility(): void
  togglePlaneVisibility(): void
  // The project tool's selection-first action lives in the UI (it reads the
  // sketch store); a context that cannot project returns false.
  projectSelection(): boolean
  // A feature add: the session Result when the mutation ran, null when there
  // is no document yet.
  addFeature(kind: string, extra?: Record<string, unknown>): Result | null
  showMessage(payload: ShowMessagePayload): void
}

export type PartCommandSpec = ErasedCommandSpec<PartCommandContext>

// The canonical shortcut per command, first binding wins. The keymaps stay the
// single source; the specs mirror them for the docs table and tooltips.
function firstShortcut(pairs: readonly (readonly [string, CommandName])[]): Map<CommandName, string> {
  const map = new Map<CommandName, string>()
  for (const [key, command] of pairs) {
    if (!map.has(command)) map.set(command, key)
  }
  return map
}

const PART_SHORTCUTS = firstShortcut([
  ...CORE_KEYBINDINGS.map(b => [b.key, b.command] as const),
  ...SKETCH_KEYBINDINGS.map(b => [b.key, b.command] as const),
  ...CONSTRAINT_SHORTCUTS,
  ...ENTITY_SHORTCUTS,
])

function partShortcut(id: CommandName): string | undefined {
  return PART_SHORTCUTS.get(id)
}

function hasEntitySelection(st: PartCommandState): boolean {
  return Array.from(st.normalSelection).some(id => id.startsWith('entity:'))
}

// A tool activation: disarm (null) or arm the tool id.
function toolSpec(id: CommandName, label: string, tool: ActiveTool): PartCommandSpec {
  return {
    id,
    label,
    shortcut: partShortcut(id),
    params: noParams(),
    enabled: () => true,
    undoable: false,
    run: ctx => {
      ctx.state().setActiveTool(tool)
      return okResult()
    },
  }
}

// A dimension placement is open when the store still names its prompt or holds
// the projections the gesture materialized. This is the tool switch's condition:
// every path that abandons a placement (undo, redo, a tool switch, leaving the
// sketch, arming a pick) resolves the same gesture.
function placementOpen(st: {
  pendingPlacementConstraintId: string | null
  pendingBrepProjectionIds: readonly string[]
}): boolean {
  return st.pendingPlacementConstraintId !== null || st.pendingBrepProjectionIds.length > 0
}

const undoSpec: PartCommandSpec = {
  id: 'undo',
  label: 'Undo',
  shortcut: partShortcut('undo'),
  params: noParams(),
  undoable: false,
  // The session owns the floor: inside a sketch with nothing of its own left to
  // revert this reads unavailable, so the toolbar and the shortcut grey out
  // instead of offering a keystroke that resolves to nothing. An open placement
  // is always undoable: the press cancels it even when no entry sits above the
  // session floor.
  enabled: ctx => {
    if (placementOpen(ctx.state())) return true
    return !ctx.session || !ctx.session.canUndo() ? 'nothing to undo' : true
  },
  run: ctx => {
    const st = ctx.state()
    // Undo shares Escape's cancel_gesture first stage: a half-placed draw
    // point or a half-built dimension is thrown away by the first Ctrl+Z
    // WITHOUT popping a real history entry. Without it, one keystroke both
    // discards the point and pops the stack -- two changes from one press.
    // With nothing in progress it falls through to the real undo unchanged.
    //
    // Deliberately NOT the 'pick' stage: an armed pick field is not a
    // half-placed gesture, it is part of the edit session that owns the
    // document (a just-added feature's editor arms one), and undo's contract
    // there is "commit the open work, then pop" -- Part.addFeatureCancel
    // pins Ctrl+Z removing the feature that armed the field. Escape's 'pick'
    // arm is about abandoning a gesture, so it stays with cancel_draw only.
    // A placement whose prompt is open owns the gesture: undo cancels it and
    // stops there, exactly as the keyboard path would. Without this the toolbar
    // undo would cancel the transaction in the session while the store's
    // pending id and the dialog survived against a constraint the rewind removed.
    if (placementOpen(st)) {
      st.cancelPlacementGesture()
      return okResult()
    }
    if (st.drawPoints.length > 0 || st.dimensionPicks.length > 0) {
      cancelInProgressGesture(st)
      return okResult()
    }
    ctx.undo()
    return okResult()
  },
}

const redoSpec: PartCommandSpec = {
  id: 'redo',
  label: 'Redo',
  shortcut: partShortcut('redo'),
  params: noParams(),
  undoable: false,
  enabled: ctx => (!ctx.session || !ctx.session.canRedo() ? 'nothing to redo' : true),
  run: ctx => {
    const st = ctx.state()
    // Redo resolves a placement the way the session does: the finished
    // dimension is kept by committing it. Clearing only in the session would
    // leave the store believing a prompt is still up.
    if (placementOpen(st)) {
      st.commitPlacementGesture()
      return okResult()
    }
    ctx.redo()
    return okResult()
  },
}

const deleteSelectedSpec: PartCommandSpec = {
  id: 'delete_selected',
  label: 'Delete selection',
  shortcut: partShortcut('delete_selected'),
  params: noParams(),
  undoable: true,
  enabled: () => true,
  // The page handler owns the whole selection: it folds a mixed sketch + 3D
  // selection into one commitMutationGroup, and otherwise defers the sketch
  // half to the store's own deleteSelected (which dispatches and wipes). It
  // must run first so it sees the full selection before any store wipe. A
  // context that cannot perform the delete (headless) returns a failure, which
  // is propagated instead of being flattened into an ok.
  run: ctx => ctx.deleteSelectedFeatures() ?? okResult(),
}

const toggleSketchPlaneVisibilitySpec: PartCommandSpec = {
  id: 'toggle_sketch_plane_visibility',
  label: 'Toggle reference geometry',
  shortcut: partShortcut('toggle_sketch_plane_visibility'),
  params: noParams(),
  undoable: true,
  enabled: () => true,
  run: ctx => {
    ctx.toggleSketchPlaneVisibility()
    return okResult()
  },
}

const togglePlaneVisibilitySpec: PartCommandSpec = {
  id: 'toggle_plane_visibility',
  label: 'Toggle planes',
  shortcut: partShortcut('toggle_plane_visibility'),
  params: noParams(),
  undoable: true,
  enabled: () => true,
  run: ctx => {
    ctx.togglePlaneVisibility()
    return okResult()
  },
}

// The store spells select mode `activeTool: null`, so this disarms rather
// than arming anything. Select behavior is the dispatchSketchClick fallback
// (`state.toggleNormalSelection`) plus the backplane clear, not a registered
// tool; `getEffectiveTool(null)` resolves to 'drag'. Kept as a
// programmatic-only command for toolbar/keymap compatibility.
const selectToolSpec = toolSpec('set_tool_select', 'Select tool', null)

const dragToolSpec = toolSpec('set_tool_drag', 'Drag tool', 'drag')

// Drawing-entity tools are derived from the registry so a newly registered
// entity (e.g. ellipse) automatically gets its set_tool_<activeTool> command
// -- the toolbar button dispatches set_tool_<activeTool>, so a missing entry
// silently makes the tool unclickable.
const entityToolSpecs: PartCommandSpec[] = ENTITIES
  .filter(e => e.activeTool && e.activeTool !== 'project')
  .map(e => toolSpec(narrowCommandName('set_tool_' + e.activeTool), `${e.label} tool`, e.activeTool!))

// Project is a selection action first, a pick tool second: with something
// already selected it projects the whole selection and consumes it, so the
// click that invoked the tool is also the click that finished it. Only an
// empty (or unprojectable) selection falls through to the pick flow.
const projectToolSpec: PartCommandSpec = {
  id: 'set_tool_project',
  label: 'Project tool',
  shortcut: partShortcut('set_tool_project'),
  params: noParams(),
  undoable: false,
  enabled: () => true,
  run: ctx => {
    if (!ctx.projectSelection()) ctx.state().setActiveTool('project')
    return okResult()
  },
}

// Rect, center_rect and n-gon are compound drawing tools with no ENTITIES
// entry, so their set_tool_<tool> commands are hardcoded (the toolbar
// buttons dispatch them; a missing entry would make a button silently inert).
const rectToolSpec = toolSpec('set_tool_rect', 'Rectangle tool', 'rect')
const centerRectToolSpec = toolSpec('set_tool_center_rect', 'Center rectangle tool', 'center_rect')
const ngonToolSpec = toolSpec('set_tool_ngon', 'N-gon tool', 'ngon')
const dimensionToolSpec = toolSpec('set_tool_dimension', 'Dimension tool', 'dimension')

const toggleConstructionSpec: PartCommandSpec = {
  id: 'toggle_construction',
  label: 'Toggle construction',
  shortcut: partShortcut('toggle_construction'),
  params: noParams(),
  undoable: true,
  enabled: () => true,
  run: ctx => {
    ctx.state().toggleConstruction()
    return okResult()
  },
}

const freezeModeField: FieldSpec<FreezeProjectionMode> = {
  type: '"fixed" | "free"',
  parse: (raw): ParseOutcome<FreezeProjectionMode> => raw === 'fixed' || raw === 'free'
    ? { ok: true, value: raw }
    : { ok: false, error: 'expected "fixed" or "free"' },
}

// The freeze command is selection-driven: the context menu selects its picked
// entity or tile first, and the command palette uses the current selection.
// `enabled` reads the document because only a projection row (or a face
// projection's member) can be frozen; a plain entity selection is not enough.
const freezeProjectionSpec: CommandSpec<PartCommandContext, { mode: FreezeProjectionMode }> = {
  id: 'freeze_projection',
  label: 'Convert projection to fixed',
  shortcut: partShortcut('freeze_projection'),
  params: objectParams({ mode: freezeModeField }),
  undoable: true,
  enabled: ctx => {
    const st = ctx.state()
    if (st.activeFeatureId === null || st.normalSelection.size === 0) {
      return 'no projected entity or projection selected'
    }
    const feature = (ctx.session?.getDoc()?.features ?? [])
      .find(candidate => candidate.id === st.activeFeatureId)
    if (feature?.kind !== 'sketch') return 'no projected entity or projection selected'
    return projectedSelectionTargets(feature, st.normalSelection).length > 0
      ? true
      : 'no projected entity or projection selected'
  },
  run: (ctx, { mode }) => {
    ctx.state().freezeProjection(mode)
    return okResult()
  },
}

/**
 * Maps one constraint definition to its `apply_<kind>` command spec. The toast
 * branch is reachable only for a constraint explicitly flagged
 * `implemented: false`; a missing keyboard shortcut never means "not
 * implemented", only that the constraint is not bound to a key.
 */
export function constraintCommandSpec(c: ConstraintDef): CommandSpec<PartCommandContext, null> {
  return {
    id: narrowCommandName(`apply_${c.kind}`),
    label: `Apply ${c.label}`,
    shortcut: partShortcut(narrowCommandName(`apply_${c.kind}`)),
    params: noParams(),
    undoable: true,
    enabled: () => true,
    run: ctx => {
      if (c.implemented === false) {
        ctx.showMessage({ title: 'Not Implemented', message: `Constraint "${c.label}" is not yet implemented.`, variant: 'info' })
        return okResult()
      }
      const reason = ctx.state().applyConstraint(c.kind)
      if (reason !== null) ctx.showMessage({ title: CANNOT_APPLY_TITLE, message: reason, variant: 'error' })
      return okResult()
    },
  }
}

const constraintSpecs: PartCommandSpec[] = CONSTRAINTS.map(constraintCommandSpec)

// The keyboard/mouse stamp-down twin of cancel_draw: finishes the gesture in
// progress instead of throwing it away. Bound to Enter in sketch-edit mode; a
// right click and a double click on the draw plane call the same store action.
const finishDrawSpec: PartCommandSpec = {
  id: 'finish_draw',
  label: 'Finish drawing',
  shortcut: partShortcut('finish_draw'),
  params: noParams(),
  undoable: true,
  enabled: ctx => (canFinishDraw(ctx.state().activeTool, ctx.state().drawPoints) ? true : 'nothing to finish'),
  run: ctx => {
    ctx.state().finishDraw()
    return okResult()
  },
}

const cancelDrawSpec: PartCommandSpec = {
  id: 'cancel_draw',
  label: 'Cancel',
  shortcut: partShortcut('cancel_draw'),
  params: noParams(),
  undoable: false,
  enabled: () => true,
  run: ctx => {
    // Escape is shared. Every modal on the Dialog shell and the sketch value
    // dialog bind their own window listener, so both they and this command
    // see the same keystroke: without standing down, dismissing a message box
    // would also throw away the draw and the armed tool behind it. Each
    // dialog closes itself, so Escape still does exactly one thing.
    const st = ctx.state()
    switch (escapeStage({
      modalOwns: modalOwnsEscape(),
      pendingDialog: st.pendingDialog,
      activePickField: st.activePickField,
      drawPoints: st.drawPoints,
      dimensionPicks: st.dimensionPicks,
    })) {
      // A modal or the sketch value dialog owns Escape: leave everything as is.
      case 'modal':
        return okResult()
      // A pick field is open (invariant: activeTool is null here, so there is
      // no tool to keep). Clear both, pick before tool to satisfy the mode
      // stack ordering invariant.
      case 'pick':
        st.clearDraw()
        st.setActivePickField(null)
        st.setActiveTool(null)
        return okResult()
      // Something is mid-gesture under the armed tool: cancel just that,
      // leaving the tool armed so the next click starts a fresh entity. The
      // dimension branch also drops the scratch projections the gesture
      // materialised, mirroring what setActiveTool does on a real tool switch.
      case 'cancel_gesture':
        cancelInProgressGesture(st)
        return okResult()
      // Nothing in progress: the historical Escape, clear the draw and
      // disarm. Pick first, tool second: on a desynced stack with 'pick' on
      // top the tool's deactivate hook would otherwise pop the pick's entry.
      case 'disarm':
        st.clearDraw()
        st.setActivePickField(null)
        st.setActiveTool(null)
        return okResult()
    }
  },
}

// Mirror is a selection action like offset, not a draw mode: the selected
// entities are the sources and one selected line is the axis (the construction
// one when several lines are selected), so no value dialog is needed. `enabled`
// and the store action read the same mirrorSelectionPlan over the same store
// state, so a keyboard press on a selection that cannot carry the mirror is
// refused at the gate rather than silently dropped.
const mirrorSpec: PartCommandSpec = {
  id: 'mirror_entities',
  label: 'Mirror selection',
  shortcut: partShortcut('mirror_entities'),
  params: noParams(),
  undoable: true,
  enabled: ctx => {
    const st = ctx.state()
    const plan = mirrorSelectionPlan(st.normalSelection, st.activeFeatureId, st.entityKindMap, st.constructionEntityKeys)
    return 'reason' in plan ? plan.reason : true
  },
  run: ctx => {
    const reason = ctx.state().mirrorSelection()
    if (reason !== null) ctx.showMessage({ title: 'Cannot mirror selection', message: reason, variant: 'error' })
    return okResult()
  },
}

// Fillet is a selection action like mirror: every selected sketch vertex is one
// corner and its partner comes from the published corner map. The radius is
// data, and the toolbar path collects it through openFilletDialog. `enabled` and
// the store action read the same filletSelectionPlan over the same state, so a
// press on a vertex with no unique line partner is refused at the gate.
const filletCornersSpec: CommandSpec<PartCommandContext, { radius: number }> = {
  id: 'fillet_corners',
  label: 'Fillet corners',
  shortcut: partShortcut('fillet_corners'),
  params: objectParams({ radius: Field.number() }),
  undoable: true,
  enabled: ctx => {
    const st = ctx.state()
    const plan = filletSelectionPlan(st.normalSelection, st.activeFeatureId, st.filletCornerMap)
    return 'reason' in plan ? plan.reason : true
  },
  run: (ctx, { radius }) => {
    const reason = ctx.state().filletCorners(radius)
    if (reason !== null) ctx.showMessage({ title: 'Cannot fillet corner', message: reason, variant: 'error' })
    return okResult()
  },
}

// Pattern is a selection action like mirror: the selected entities of the
// active sketch are the sources. The dialog front end is the linear case along
// +X; grid, rotate and copy are drive modes. `enabled` and the store action
// read the same patternSelectionPlan, so the gate cannot drift from the action.
const patternEntitiesSpec: CommandSpec<PartCommandContext, { count: number; pitch: number }> = {
  id: 'pattern_entities',
  label: 'Pattern entities',
  shortcut: partShortcut('pattern_entities'),
  params: objectParams({ count: Field.number(), pitch: Field.number() }),
  undoable: true,
  enabled: ctx => {
    const st = ctx.state()
    const plan = patternSelectionPlan(st.normalSelection, st.activeFeatureId)
    return 'reason' in plan ? plan.reason : true
  },
  run: (ctx, { count, pitch }) => {
    // The applier refuses silently (a dev warn), so the document checks the
    // drive rule runs (the cap, a projected source, the entity limit) are run
    // here first and shown, instead of dispatching a step that writes nothing.
    const st = ctx.state()
    const selection = patternSelectionPlan(st.normalSelection, st.activeFeatureId)
    const doc = ctx.session?.getDoc() ?? null
    if (!('reason' in selection) && doc !== null) {
      const plan = planPatternEntities(doc, {
        featureId: st.activeFeatureId!, sourceIds: selection.sourceIds, mode: 'linear', count, pitch,
      })
      if ('reason' in plan) {
        ctx.showMessage({ title: 'Cannot pattern entities', message: plan.reason, variant: 'error' })
        return okResult()
      }
    }
    const reason = st.patternEntities(count, pitch)
    if (reason !== null) ctx.showMessage({ title: 'Cannot pattern entities', message: reason, variant: 'error' })
    return okResult()
  },
}

/** The pattern dialog's text, `count pitch` (or `count, pitch`), each an
 *  expression: `4 12` and `2*3 10` both read. A reason when it does not. Pure,
 *  so the dialog's parse is tested without a store. */
export function parsePatternInput(input: string): { count: number; pitch: number } | { reason: string } {
  const text = input.trim()
  const parts = (text.includes(',') ? text.split(',') : text.split(/\s+/)).map(s => s.trim()).filter(s => s !== '')
  if (parts.length !== 2) return { reason: `enter "count pitch", for example "4 12", got "${text}"` }
  const count = evalExpr(parts[0])
  const pitch = evalExpr(parts[1])
  if (isNaN(count)) return { reason: cannotEvaluate(parts[0]) }
  if (isNaN(pitch)) return { reason: cannotEvaluate(parts[1]) }
  if (!Number.isInteger(count) || count < 2) return { reason: `count must be a whole number of at least 2 (the source included), got ${count}` }
  if (count > MAX_PATTERN_INSTANCES) return { reason: `count ${count} is above the cap of ${MAX_PATTERN_INSTANCES} instances` }
  if (pitch === 0) return { reason: 'pitch must not be zero' }
  return { count, pitch }
}

// Offset is a selection action, not a draw mode: it operates on the currently
// selected sketch entities. The distance is data; the dialog below is only the
// user-facing front end that collects it and calls execute.
const offsetSpec: CommandSpec<PartCommandContext, { distance: number }> = {
  id: 'apply_offset',
  label: 'Offset selection',
  shortcut: partShortcut('apply_offset'),
  params: objectParams({ distance: Field.number() }),
  undoable: true,
  enabled: ctx => (hasEntitySelection(ctx.state()) ? true : 'no entities selected'),
  run: (ctx, { distance }) => {
    ctx.state().applyOffset(distance)
    return okResult()
  },
}

function addFeatureSpec(id: CommandName, label: string, kind: string, extra?: Record<string, unknown>): PartCommandSpec {
  return {
    id,
    label,
    shortcut: partShortcut(id),
    params: noParams(),
    undoable: true,
    enabled: () => true,
    run: ctx => ctx.addFeature(kind, extra) ?? okResult(),
  }
}

const addExtrudeSpec = addFeatureSpec('add_extrude', 'Add extrude', 'extrude', { sketchQuery: '', distance: DEFAULT_EXTRUDE_DISTANCE })
const addHoleSpec = addFeatureSpec('add_hole', 'Add hole', 'hole')
const addTransformSpec = addFeatureSpec('add_transform', 'Add transform', 'transform')
const addShellSpec = addFeatureSpec('add_shell', 'Add shell', 'shell')
const addMoveFaceSpec = addFeatureSpec('add_move_face', 'Add move face', 'move_face')
const addDeleteFaceSpec = addFeatureSpec('add_delete_face', 'Add delete face', 'delete_face')
const addSplitSpec = addFeatureSpec('add_split', 'Add split', 'split')
const addLinearPatternSpec = addFeatureSpec('add_linear_pattern', 'Add linear pattern', 'linear_pattern')
const addCircularPatternSpec = addFeatureSpec('add_circular_pattern', 'Add circular pattern', 'circular_pattern')
const addCurvePatternSpec = addFeatureSpec('add_curve_pattern', 'Add curve pattern', 'curve_pattern')
const addInstancePatternSpec = addFeatureSpec('add_instance_pattern', 'Add instance pattern', 'instance_pattern')
const addWrapSpec = addFeatureSpec('add_wrap', 'Add wrap', 'wrap', { sketchQuery: '' })

/**
 * The sketch/part editor's full command table. Static data: every body reads
 * its inputs from the context it is handed, so the list can be registered for
 * any mounted editor and enumerated in tests without a DOM.
 */
export const PART_COMMAND_SPECS: readonly ErasedCommandSpec<PartCommandContext>[] = [
  undoSpec,
  redoSpec,
  deleteSelectedSpec,
  toggleSketchPlaneVisibilitySpec,
  togglePlaneVisibilitySpec,
  selectToolSpec,
  dragToolSpec,
  ...entityToolSpecs,
  projectToolSpec,
  rectToolSpec,
  centerRectToolSpec,
  ngonToolSpec,
  dimensionToolSpec,
  toggleConstructionSpec,
  freezeProjectionSpec,
  ...constraintSpecs,
  finishDrawSpec,
  cancelDrawSpec,
  mirrorSpec,
  filletCornersSpec,
  patternEntitiesSpec,
  offsetSpec,
  addExtrudeSpec,
  addHoleSpec,
  addTransformSpec,
  addShellSpec,
  addMoveFaceSpec,
  addDeleteFaceSpec,
  addSplitSpec,
  addLinearPatternSpec,
  addCircularPatternSpec,
  addCurvePatternSpec,
  addInstancePatternSpec,
  addWrapSpec,
]
