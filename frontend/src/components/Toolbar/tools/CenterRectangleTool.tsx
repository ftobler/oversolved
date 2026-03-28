import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { executeCommand } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import toolbarCenterRectangleIcon from '../../../assets/icons/toolbar-center-rectangle.svg'

export default function CenterRectangleTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)

  return (
    <ToolbarButton
      title="Center Rectangle"
      icon={toolbarCenterRectangleIcon}
      onClick={() => executeCommand('set_tool_center_rect')}
      active={activeTool === 'center_rect'}
    />
  )
}
