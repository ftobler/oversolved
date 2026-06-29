import { SINGLE_ENTITY_RULES, MULTI_ENTITY_RULES } from '@/registry/measurementRegistry'
import { Badge } from './shared'

export function MeasurementsTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Label</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td colSpan={3} className="reg-cell-section">Single Entity Rules</td>
        </tr>
        {SINGLE_ENTITY_RULES.map((r, i) => (
          <tr key={`single-${i}`}>
            <td><Badge text="single" variant="neutral" /></td>
            <td>{r.label}</td>
            <td className="reg-cell-desc">Measures individual entities</td>
          </tr>
        ))}
        <tr>
          <td colSpan={3} className="reg-cell-section">Multi-Entity Rules</td>
        </tr>
        {MULTI_ENTITY_RULES.map((r, i) => (
          <tr key={`multi-${i}`}>
            <td><Badge text="multi" variant="neutral" /></td>
            <td>{r.label}</td>
            <td className="reg-cell-desc">Measures entity pairs</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
