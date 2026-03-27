import { useSketchEditorStore } from '../../../stores/sketchEditorStore'
import ToolbarButton from '../ToolbarButton'
import toolbarCenterRectangleIcon from '../../../assets/icons/toolbar-center-rectangle.svg'

export default function CenterRectangleTool() {
  const activeTool = useSketchEditorStore(s => s.activeTool)
  const setActiveTool = useSketchEditorStore(s => s.setActiveTool)

  return (
    <ToolbarButton
      title="Center Rectangle"
      icon={toolbarCenterRectangleIcon}
      onClick={() => setActiveTool('center_rect')}
      active={activeTool === 'center_rect'}
    />
  )
}
