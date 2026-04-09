import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { executeCommand } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import { iconUrl } from './toolUtils'

export default function DragTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const drag = useSketchEditorStore(s => s.drag)

  const isDragActive = drag !== null
  const isActive = isDragActive || activeTool === 'drag' || activeTool === null

  return (
    <ToolbarButton
      title="Drag (G)"
      icon={iconUrl('toolbar-select')}
      onClick={() => executeCommand('set_tool_drag')}
      active={isActive}
    />
  )
}