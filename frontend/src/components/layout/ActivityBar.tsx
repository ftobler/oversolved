import type { PanelDef, PanelId } from './panelRegistry'

// The narrow rail of switchable panels. Presentational only: it owns no state
// and no list, so adding a panel is a registry edit, not a rail edit.
interface ActivityBarProps {
  panels: PanelDef[]
  active: PanelId
  onSelect: (id: PanelId) => void
}

export function ActivityBar({ panels, active, onSelect }: ActivityBarProps) {
  return (
    <div className="activity-bar" role="toolbar" aria-label="Panels">
      {panels.map(panel => (
        <button
          key={panel.id}
          type="button"
          className={`activity-bar-btn${panel.id === active ? ' active' : ''}`}
          aria-label={panel.label}
          aria-pressed={panel.id === active}
          title={panel.label}
          onClick={() => onSelect(panel.id)}
        >
          <span className="material-icons">{panel.icon}</span>
        </button>
      ))}
    </div>
  )
}
