import { CONSTRAINTS, ENTITIES, CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import type { ConstraintDef } from '@/registry'
import type { DocSession } from '@/session/DocSession'
import type { Result } from '@/session/result'
import { okResult } from '@/session/result'
import type { ActiveTool } from '@/types/cad'
import { useEditorState } from '@/hooks/useEditorState'
import type { EditorState } from '@/stores/editorState'
import { useSketchUiStore, CANNOT_APPLY_TITLE, type SketchUiState } from '@/stores/sketchEditorStore'
import { projectSelection } from '@/tools/projectSelectionCommand'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import { CORE_KEYBINDINGS } from '@/utils/core/commandRegistry'
import { narrowCommandName } from '@/utils/core/commandNames'
import type { CommandName } from '@/utils/core/commandNames'
import { noParams, objectParams, Field, type CommandResult, type ErasedCommandSpec, type CommandSpec } from '@/utils/core/commandSpec'

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
  cancelBrepProjectionGesture: () => void
  clearDimensionPicks: () => void
}) {
  st.clearDraw()
  if (st.dimensionPicks.length > 0) {
    st.cancelBrepProjectionGesture()
    st.clearDimensionPicks()
  }
}

export interface ShowMessagePayload {
  title: string
  message: string
  variant?: 'info' | 'success' | 'error'
}

// Commands read from both stores: the editor state (selection, tools, draw
// state) and the sketch UI store (the pending value dialog). This merged
// getter keeps each command body one `st` away from whatever it needs.
export type SketchCommandState = EditorState & SketchUiState
export const getSketchState = (): SketchCommandState => ({
  ...useEditorState.getState(),
  ...useSketchUiStore.getState(),
})

/**
 * The live inputs of the sketch/part command table. The page builds one of
 * these around its session and page callbacks; a spec body reads everything it
 * needs from here, so a spec is static data and the table can be enumerated
 * headlessly.
 */
export interface PartCommandContext {
  editor: 'part'
  // The live session. Undo/redo availability is read from its history, the
  // same stacks the toolbar mirrors.
  session: DocSession | null
  // The live L2 editor state plus the sketch UI store, read at call time.
  state(): SketchCommandState
  undo(): void
  redo(): void
  // The page folds a mixed sketch and 3D selection through several stores and
  // returns nothing; a headless context that cannot perform the delete returns
  // a failure Result so the command never reads as an ok that did nothing.
  deleteSelectedFeatures(): CommandResult | void
  toggleSketchPlaneVisibility(): void
  togglePlaneVisibility(): void
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
  ...CONSTRAINT_SHORTCUTS,
  ...ENTITY_SHORTCUTS,
])

function partShortcut(id: CommandName): string | undefined {
  return PART_SHORTCUTS.get(id)
}

function hasEntitySelection(st: SketchCommandState): boolean {
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

const undoSpec: PartCommandSpec = {
  id: 'undo',
  label: 'Undo',
  shortcut: partShortcut('undo'),
  params: noParams(),
  undoable: false,
  enabled: ctx => (!ctx.session || ctx.session.historyEntries().undo.length === 0 ? 'nothing to undo' : true),
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
  enabled: ctx => (!ctx.session || ctx.session.historyEntries().redo.length === 0 ? 'nothing to redo' : true),
  run: ctx => {
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
  label: 'Toggle sketches/planes',
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
    if (!projectSelection()) ctx.state().setActiveTool('project')
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

const mirrorSpec: PartCommandSpec = {
  id: 'set_tool_mirror',
  label: 'Mirror tool',
  shortcut: partShortcut('set_tool_mirror'),
  params: noParams(),
  undoable: false,
  // The button is disabled without a selection, exactly as before; the command
  // itself still surfaces the not-implemented notice when it runs.
  enabled: ctx => {
    const st = ctx.state()
    const active = st.activeTool === 'mirror'
    return hasEntitySelection(st) || active ? true : 'select an entity first'
  },
  run: ctx => {
    ctx.showMessage({ title: 'Not Implemented', message: 'Mirror tool is not yet implemented.', variant: 'info' })
    return okResult()
  },
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

// The value-dialog front end for apply_offset. Programmatic callers pass the
// parsed distance straight to execute; this is the path the toolbar button
// takes, so the user experience is unchanged.
export function openOffsetDialog(onDistance: (distance: number) => void): void {
  const st = useSketchUiStore.getState()
  const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 200
  const cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 200
  st.openDialog({
    position: [cx, cy],
    label: 'Offset distance',
    defaultValue: '5',
    validate: (input) => (isNaN(parseFloat(input)) ? 'Enter a number' : null),
    onConfirm: (input) => {
      onDistance(parseFloat(input))
      st.closeDialog()
    },
    onCancel: () => st.closeDialog(),
  })
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

const addExtrudeSpec = addFeatureSpec('add_extrude', 'Add extrude', 'extrude', { sketchQuery: '', distance: 10 })
const addHoleSpec = addFeatureSpec('add_hole', 'Add hole', 'hole')
const addTransformSpec = addFeatureSpec('add_transform', 'Add transform', 'transform')
const addShellSpec = addFeatureSpec('add_shell', 'Add shell', 'shell')
const addMoveFaceSpec = addFeatureSpec('add_move_face', 'Add move face', 'move_face')
const addDeleteFaceSpec = addFeatureSpec('add_delete_face', 'Add delete face', 'delete_face')

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
  ...constraintSpecs,
  cancelDrawSpec,
  mirrorSpec,
  offsetSpec,
  addExtrudeSpec,
  addHoleSpec,
  addTransformSpec,
  addShellSpec,
  addMoveFaceSpec,
  addDeleteFaceSpec,
]
