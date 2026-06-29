import { SNAP_RULES } from '@/registry'
import { Badge } from './shared'

export function SnapRulesTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Dragged Element</th>
          <th>Snap Kinds</th>
        </tr>
      </thead>
      <tbody>
        {Object.entries(SNAP_RULES).map(([draggedType, snapKinds]) => (
          <tr key={draggedType}>
            <td><code>{draggedType}</code></td>
            <td>{snapKinds.map(k => <Badge key={k} text={k} variant="neutral" />)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
