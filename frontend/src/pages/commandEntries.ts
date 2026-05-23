import { CONSTRAINTS } from '@/registry'
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
    { name: 'set_tool_line',         fn: () => getState().setActiveTool('line') },
    { name: 'set_tool_circle',       fn: () => getState().setActiveTool('circle') },
    { name: 'set_tool_arc',          fn: () => getState().setActiveTool('arc') },
    { name: 'set_tool_point',        fn: () => getState().setActiveTool('point') },
    { name: 'set_tool_rect',         fn: () => getState().setActiveTool('rect') },
    { name: 'set_tool_center_rect',  fn: () => getState().setActiveTool('center_rect') },
    { name: 'set_tool_project',      fn: () => getState().setActiveTool('project') },
    { name: 'set_tool_dimension',    fn: () => getState().setActiveTool('dimension') },
    { name: 'toggle_construction',   fn: () => getState().toggleConstruction() },
    ...CONSTRAINTS.filter(c => c.shortcut).map(c => ({
      name: `apply_${c.kind}`,
      fn: () => getState().applyConstraint(c.kind),
    })),
    { name: 'cancel_draw', fn: () => {
        getState().clearDraw()
        getState().setActiveTool(null)
        getState().setActivePickField(null)
    }},
    { name: 'cancel_pick', fn: () => {
      getState().setActivePickField(null)
    }},
    { name: 'add_extrude', fn: handleAddExtrude },
    { name: 'add_hole', fn: handleAddHole },
    { name: 'add_transform', fn: handleAddTransform },
  ]
}
