import { ENTITIES } from '@/registry'
import { Icon, Badge } from './shared'

export function EntitiesTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Icon</th>
          <th>Kind</th>
          <th>Label</th>
          <th>Params</th>
          <th>Vertices</th>
          <th>Tool</th>
          <th>Toolbar</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {ENTITIES.map(e => (
          <tr key={e.kind}>
            <td className="reg-cell-icon"><Icon file={e.toolbarIcon} /></td>
            <td><code>{e.kind}</code></td>
            <td>{e.label}</td>
            <td className="reg-cell-center">{e.paramCount}</td>
            <td>
              {e.vertices.map(v => (
                <span key={v.key} className="reg-vertex-pill">
                  <code>{v.key}</code>
                  <span className="reg-vertex-idx">[{v.indices.join(',')}]</span>
                </span>
              ))}
            </td>
            <td>{e.activeTool ? <code>{e.activeTool}</code> : <span className="reg-muted">—</span>}</td>
            <td className="reg-cell-center">
              {e.showInToolbar
                ? <Badge text="yes" variant="yes" />
                : <Badge text="no" variant="no" />}
            </td>
            <td className="reg-cell-desc">{e.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
