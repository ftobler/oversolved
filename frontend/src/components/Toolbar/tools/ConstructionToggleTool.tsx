import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import ToolbarButton from '../ToolbarButton'
import toolbarConstructionIcon from '../../../assets/icons/constraint-line-swap.svg'

export default function ConstructionToggleTool() {
  const toggleConstruction = useSketchEditorStore(s => s.toggleConstruction)

  return (
    <ToolbarButton
      title="Toggle Construction (Q)"
      icon={toolbarConstructionIcon}
      onClick={toggleConstruction}
    />
  )
}
