import { CONSTRAINTS } from '@/registry'
import { Icon, Badge } from './shared'

export function ConstraintsTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Toolbar</th>
          <th>Kind</th>
          <th>Label</th>
          <th>Category</th>
          <th>Shortcut</th>
          <th>Refs</th>
          <th>Value</th>
          <th>Render</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {CONSTRAINTS.map(c => (
          <tr key={c.kind}>
            <td className="reg-cell-icon"><Icon file={c.symbolIcon} /></td>
            <td className="reg-cell-icon"><Icon file={c.toolbarIcon} /></td>
            <td><code>{c.kind}</code></td>
            <td>{c.label}</td>
            <td>
              <Badge
                text={c.category}
                variant={c.category === 'geometric' ? 'geo' : 'dim'}
              />
            </td>
            <td className="reg-cell-center">
              {c.shortcut
                ? <kbd className="reg-kbd">{c.shortcut.toUpperCase()}</kbd>
                : <span className="reg-muted">-</span>}
            </td>
            <td><code>{c.refPattern}</code></td>
            <td className="reg-cell-center">
              {c.hasValue
                ? <Badge text="yes" variant="yes" />
                : <Badge text="no" variant="no" />}
            </td>
            <td><code>{c.renderKind}</code></td>
            <td className="reg-cell-desc">{c.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
