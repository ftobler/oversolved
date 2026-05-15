import { useSketchEditorStore } from '@/stores/sketchEditorStore'
import { executeCommand, CORE_KEYBINDINGS } from '@/stores/commandRegistry'
import ToolbarButton from '@/components/Toolbar/ToolbarButton'
import toolbarDimensionIcon from '@/assets/icons/constraint-dimension.svg'

const dimensionKey = CORE_KEYBINDINGS.find(b => b.command === 'set_tool_dimension')?.key.toUpperCase()

export default function DimensionTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)

  return (
    <ToolbarButton
      title={dimensionKey ? `Dimension (${dimensionKey})` : 'Dimension'}
      icon={toolbarDimensionIcon}
      onClick={() => executeCommand('set_tool_dimension')}
      active={activeTool === 'dimension'}
    />
  )
}
