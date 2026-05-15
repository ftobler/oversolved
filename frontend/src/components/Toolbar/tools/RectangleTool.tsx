import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand } from '@/stores/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import toolbarRectangleIcon from '@/assets/icons/toolbar-rectangle.svg'

export default function RectangleTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)

  return (
    <ToolbarButton
      title="Rectangle"
      icon={toolbarRectangleIcon}
      onClick={() => executeCommand('set_tool_rect')}
      active={activeTool === 'rect'}
    />
  )
}
