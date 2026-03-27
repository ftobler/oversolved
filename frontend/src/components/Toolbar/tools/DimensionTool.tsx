import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import ToolbarButton from '../ToolbarButton'
import toolbarDimensionIcon from '../../../assets/icons/constraint-dimension.svg'

export default function DimensionTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)

  return (
    <ToolbarButton
      title="Dimension (D)"
      icon={toolbarDimensionIcon}
      onClick={() => setActiveTool('dimension')}
      active={activeTool === 'dimension'}
    />
  )
}
