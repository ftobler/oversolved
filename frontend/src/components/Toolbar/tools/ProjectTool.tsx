import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand } from '@/stores/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import projectIcon from '@/assets/icons/toolbar-project.svg'

// Project tool activates the 'project' active tool which allows the user to pick
// an entity from another sketch and project it onto the active sketch plane.
export default function ProjectTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const isActive = activeTool === 'project'

  return (
    <ToolbarButton
      title="Project (J)"
      icon={projectIcon}
      onClick={() => executeCommand('set_tool_project')}
      active={isActive}
    />
  )
}
