import { CONSTRAINTS, ENTITIES } from '@/registry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { projectSelection } from '@/tools/projectSelectionCommand'
import type { CommandEntry } from '@/pages/hooks/useCommandRegistration'

export interface ShowMessagePayload {
  title: string
  message: string
  variant?: 'info' | 'success' | 'error'
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
      fn: c.shortcut
        ? () => getState().applyConstraint(c.kind)
        : () => { showMessage({ title: 'Not Implemented', message: `Constraint "${c.label}" is not yet implemented.`, variant: 'info' }); },
    })),
    { name: 'cancel_draw', fn: () => {
        getState().clearDraw()
        getState().setActiveTool(null)
        getState().setActivePickField(null)
    }},
    { name: 'cancel_pick', fn: () => {
      getState().setActivePickField(null)
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
