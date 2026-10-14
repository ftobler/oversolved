import { domHandleProps } from '@/picking'

interface ToolbarButtonProps {
  title: string
  onClick: () => void
  active?: boolean
  icon: string
  disabled?: boolean
  // Stable scene-probe handle id, e.g. `toolbar:set_tool_line`.
  handle?: string
}

export default function ToolbarButton({ title, onClick, active, icon, disabled, handle }: ToolbarButtonProps) {
  return (
    <button
      className={`editor-btn ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
      disabled={disabled}
      {...domHandleProps(handle)}
    >
      <img src={icon} alt={title} />
    </button>
  )
}
