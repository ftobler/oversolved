interface ToolbarButtonProps {
  title: string
  onClick: () => void
  active?: boolean
  icon: string
  disabled?: boolean
}

export default function ToolbarButton({ title, onClick, active, icon, disabled }: ToolbarButtonProps) {
  return (
    <button
      className={`editor-btn ${active ? 'active' : ''}`}
      title={title}
      onClick={onClick}
      disabled={disabled}
    >
      <img src={icon} alt={title} />
    </button>
  )
}
