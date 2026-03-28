import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import { executeCommand } from '../../../stores/commandRegistry'
import ToolbarButton from '../ToolbarButton'
import toolbarDimensionIcon from '../../../assets/icons/constraint-dimension.svg'

export default function DimensionTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)

  return (
    <ToolbarButton
      title="Dimension (D)"
      icon={toolbarDimensionIcon}
      onClick={() => executeCommand('set_tool_dimension')}
      active={activeTool === 'dimension'}
    />
  )
}
