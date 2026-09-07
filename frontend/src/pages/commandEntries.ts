import { CONSTRAINTS, ENTITIES } from '@/registry'
import type { ConstraintDef } from '@/registry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { projectSelection } from '@/tools/projectSelectionCommand'
import { modalOwnsEscape } from '@/utils/core/modalEscape'
import type { CommandEntry } from '@/pages/hooks/useCommandRegistration'

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

export interface ShowMessagePayload {
  title: string
  message: string
  variant?: 'info' | 'success' | 'error'
}

/**
 * Maps one constraint definition to its `apply_<kind>` command body. The toast
 * branch is reachable only for a constraint explicitly flagged
 * `implemented: false`; a missing keyboard shortcut never means "not
 * implemented", only that the constraint is not bound to a key.
 */
export function constraintCommandFn(
  c: ConstraintDef,
  getState: () => Pick<ReturnType<typeof useSketchEditorStore.getState>, 'applyConstraint'>,
  showMessage: (payload: ShowMessagePayload) => void,
): () => void {
  return c.implemented === false
    ? () => { showMessage({ title: 'Not Implemented', message: `Constraint "${c.label}" is not yet implemented.`, variant: 'info' }); }
    : () => {
        const reason = getState().applyConstraint(c.kind)
        if (reason !== null) showMessage({ title: 'Cannot apply constraint', message: reason, variant: 'error' })
      }
}

/**
 * Builds the full command entry list for the sketch editor.
 * Pass stable (useCallback-wrapped) handler references so the returned array
 * can be used as a useMemo dependency without unnecessary re-registrations.
 */
export function buildCommandEntries(
  handleUndo: () => void,
  handleRedo: () => void,
  handleDeleteSelectedFeatures: () => void,
  handleToggleSketchPlaneVisibility: () => void,
  handleTogglePlaneVisibility: () => void,
  handleAddExtrude: () => void,
  handleAddHole: () => void,
  handleAddTransform: () => void,
  showMessage: (payload: ShowMessagePayload) => void,
): CommandEntry[] {
  const getState = useSketchEditorStore.getState
  return [
    { name: 'undo',                  fn: handleUndo },
    { name: 'redo',                  fn: handleRedo },
    { name: 'delete_selected',       fn: () => { getState().deleteSelected(); handleDeleteSelectedFeatures() } },
    { name: 'toggle_sketch_plane_visibility', fn: handleToggleSketchPlaneVisibility },
    { name: 'toggle_plane_visibility',        fn: handleTogglePlaneVisibility },
    // The store spells select mode `activeTool: null`, so this disarms rather
    // than arming anything. Select behavior is the dispatchSketchClick fallback
    // (`state.toggleNormalSelection`) plus the backplane clear, not a
    // registered tool; `getEffectiveTool(null)` resolves to 'drag'. Kept as a
    // programmatic-only command for toolbar/keymap compatibility.
    { name: 'set_tool_select',       fn: () => getState().setActiveTool(null) },
    { name: 'set_tool_drag',         fn: () => getState().setActiveTool('drag') },
    // Drawing-entity tools are derived from the registry so a newly registered
    // entity (e.g. ellipse) automatically gets its set_tool_<activeTool> command
    // -- the toolbar button dispatches set_tool_<activeTool>, so a missing entry
    // silently makes the tool unclickable.
    ...ENTITIES.filter(e => e.activeTool && e.activeTool !== 'project').map(e => ({
      name: 'set_tool_' + e.activeTool,
      fn: () => getState().setActiveTool(e.activeTool!),
    })),
    // Project is a selection action first, a pick tool second: with something
    // already selected it projects the whole selection and consumes it, so the
    // click that invoked the tool is also the click that finished it. Only an
    // empty (or unprojectable) selection falls through to the pick flow.
    { name: 'set_tool_project', fn: () => {
      if (!projectSelection()) getState().setActiveTool('project')
    }},
    { name: 'set_tool_rect',         fn: () => getState().setActiveTool('rect') },
    { name: 'set_tool_center_rect',  fn: () => getState().setActiveTool('center_rect') },
    // N-gon and center_rect are compound drawing tools with no ENTITIES entry, so
    // their set_tool_<tool> commands are hardcoded (the toolbar button dispatches
    // set_tool_ngon; a missing entry would make the button silently inert).
    { name: 'set_tool_ngon',         fn: () => getState().setActiveTool('ngon') },
    { name: 'set_tool_dimension',    fn: () => getState().setActiveTool('dimension') },
    { name: 'toggle_construction',   fn: () => getState().toggleConstruction() },
    ...CONSTRAINTS.map(c => ({
      name: `apply_${c.kind}`,
      fn: constraintCommandFn(c, getState, showMessage),
    })),
    { name: 'cancel_draw', fn: () => {
        // Escape is shared. Every modal on the Dialog shell and the sketch value
        // dialog bind their own window listener, so both they and this command
        // see the same keystroke: without standing down, dismissing a message box
        // would also throw away the draw and the armed tool behind it. Each
        // dialog closes itself, so Escape still does exactly one thing.
        const st = getState()
        switch (escapeStage({
          modalOwns: modalOwnsEscape(),
          pendingDialog: st.pendingDialog,
          activePickField: st.activePickField,
          drawPoints: st.drawPoints,
          dimensionPicks: st.dimensionPicks,
        })) {
          // A modal or the sketch value dialog owns Escape: leave everything as is.
          case 'modal':
            return
          // A pick field is open (invariant: activeTool is null here, so there is
          // no tool to keep). Clear both, pick before tool to satisfy the mode
          // stack ordering invariant.
          case 'pick':
            st.clearDraw()
            st.setActivePickField(null)
            st.setActiveTool(null)
            return
          // Something is mid-gesture under the armed tool: cancel just that,
          // leaving the tool armed so the next click starts a fresh entity. The
          // dimension branch also drops the scratch projections the gesture
          // materialised, mirroring what setActiveTool does on a real tool switch.
          case 'cancel_gesture':
            st.clearDraw()
            if (st.dimensionPicks.length > 0) {
              st.cancelBrepProjectionGesture()
              st.clearDimensionPicks()
            }
            return
          // Nothing in progress: the historical Escape, clear the draw and
          // disarm. Pick first, tool second: on a desynced stack with 'pick' on
          // top the tool's deactivate hook would otherwise pop the pick's entry.
          case 'disarm':
            st.clearDraw()
            st.setActivePickField(null)
            st.setActiveTool(null)
            return
        }
    }},
    { name: 'set_tool_mirror', fn: () => {
      showMessage({ title: 'Not Implemented', message: 'Mirror tool is not yet implemented.', variant: 'info' })
    }},
    // Offset is a selection action, not a draw mode: it operates on the currently
    // selected sketch entities. Prompt for the signed distance, then dispatch.
    { name: 'apply_offset', fn: () => {
      const st = getState()
      const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 200
      const cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 200
      st.openDialog({
        position: [cx, cy],
        label: 'Offset distance',
        defaultValue: '5',
        validate: (input) => (isNaN(parseFloat(input)) ? 'Enter a number' : null),
        onConfirm: (input) => { st.applyOffset(parseFloat(input)); st.closeDialog() },
        onCancel: () => st.closeDialog(),
      })
    }},
    { name: 'add_extrude', fn: handleAddExtrude },
    { name: 'add_hole', fn: handleAddHole },
    { name: 'add_transform', fn: handleAddTransform },
  ]
}
