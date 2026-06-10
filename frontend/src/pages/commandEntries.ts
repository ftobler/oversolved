import { CONSTRAINTS, ENTITIES } from '@/registry'
import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import type { CommandEntry } from '@/pages/hooks/useCommandRegistration'

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
    ...ENTITIES.filter(e => e.activeTool).map(e => ({
      name: 'set_tool_' + e.activeTool,
      fn: () => getState().setActiveTool(e.activeTool!),
    })),
    { name: 'set_tool_rect',         fn: () => getState().setActiveTool('rect') },
    { name: 'set_tool_center_rect',  fn: () => getState().setActiveTool('center_rect') },
    { name: 'set_tool_dimension',    fn: () => getState().setActiveTool('dimension') },
    { name: 'toggle_construction',   fn: () => getState().toggleConstruction() },
    ...CONSTRAINTS.map(c => ({
      name: `apply_${c.kind}`,
      fn: c.shortcut
        ? () => getState().applyConstraint(c.kind)
        : () => { alert(`Constraint "${c.label}" is not yet implemented.`); },
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
      alert('Mirror tool is not yet implemented.')
    }},
    { name: 'add_extrude', fn: handleAddExtrude },
    { name: 'add_hole', fn: handleAddHole },
    { name: 'add_transform', fn: handleAddTransform },
  ]
}
