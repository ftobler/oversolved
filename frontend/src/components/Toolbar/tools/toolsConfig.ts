export interface ToolDef {
  id: string
  label: string
  icon: string
  command: string
  activeTool?: string
  shortcutCommand?: string
}

export const TOOL_DEFS: Record<string, ToolDef> = {
  dimension: { id: 'dimension', label: 'Dimension', icon: 'constraint-dimension', command: 'set_tool_dimension', activeTool: 'dimension', shortcutCommand: 'set_tool_dimension' },
  rectangle: { id: 'rectangle', label: 'Rectangle', icon: 'toolbar-rectangle', command: 'set_tool_rect', activeTool: 'rect' },
  centerRect: { id: 'centerRect', label: 'Center Rectangle', icon: 'toolbar-center-rectangle', command: 'set_tool_center_rect', activeTool: 'center_rect' },
  project: { id: 'project', label: 'Project', icon: 'toolbar-project', command: 'set_tool_project', activeTool: 'project' },
}
