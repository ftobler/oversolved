import ToolbarButton from '../ToolbarButton'
import viewportResetIcon from '../../../assets/icons/viewport-reset.svg'

interface ResetViewportToolProps {
  onResetViewport: () => void
}

export default function ResetViewportTool({ onResetViewport }: ResetViewportToolProps) {
  return (
    <ToolbarButton
      title="Reset Viewport"
      icon={viewportResetIcon}
      onClick={onResetViewport}
    />
  )
}
