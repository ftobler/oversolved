import { CONSTRAINTS } from '../registry'
import { useSketchEditorStore } from '../stores/sketchEditorStore'
import type { CommandEntry } from './hooks/useCommandRegistration'

/**
 * Builds the full command entry list for the sketch editor.
 * Pass stable (useCallback-wrapped) handler references so the returned array
 * can be used as a useMemo dependency without unnecessary re-registrations.
 */
export function buildCommandEntries(
  handleUndo: () => void,
  handleRedo: () => void,
  handleDeleteSelectedFeatures: () => void,
): CommandEntry[] {
  const getState = useSketchEditorStore.getState
  return [
    { name: 'undo',                  fn: handleUndo },
    { name: 'redo',                  fn: handleRedo },
    { name: 'delete_selected',       fn: () => { getState().deleteSelected(); handleDeleteSelectedFeatures() } },
    { name: 'set_tool_select',       fn: () => getState().setActiveTool('select') },
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
        getState().setActiveTool('select')
        getState().setPlaneSelectionFeatureId(null)
    }},
    { name: 'cancel_plane_selection', fn: () => getState().setPlaneSelectionFeatureId(null) },
  ]
}
