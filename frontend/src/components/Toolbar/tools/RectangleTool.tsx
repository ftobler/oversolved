import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import ToolbarButton from '../ToolbarButton'
import toolbarRectangleIcon from '../../../assets/icons/toolbar-rectangle.svg'

export default function RectangleTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)

  return (
    <ToolbarButton
      title="Rectangle"
      icon={toolbarRectangleIcon}
      onClick={() => setActiveTool('rect')}
      active={activeTool === 'rect'}
    />
  )
}
