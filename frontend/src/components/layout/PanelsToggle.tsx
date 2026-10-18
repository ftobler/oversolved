interface PanelsToggleProps {
  open: boolean
  onToggle: () => void
}

/**
 * The one control that brings a navigator back on a phone: below the breakpoint
 * the sheet hides the navigator so the model fills the screen (Part.css), and
 * this button opens it again as a drawer. The button itself is hidden above
 * that breakpoint, where the navigator is always out, so both editors can mount
 * it unconditionally. Each editor keeps its own open flag because the drawer
 * belongs to one editor view at a time; there is no panel state behind it.
 */
export function PanelsToggle({ open, onToggle }: PanelsToggleProps) {
  const label = open ? 'Hide panels' : 'Show panels'
  return (
    <button
      type="button"
      className={`editor-btn panels-toggle${open ? ' active' : ''}`}
      aria-label={label}
      aria-pressed={open}
      title={label}
      onClick={onToggle}
    >
      <span className="material-icons">view_sidebar</span>
    </button>
  )
}
