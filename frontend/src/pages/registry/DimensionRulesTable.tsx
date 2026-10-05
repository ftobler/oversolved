import { DIMENSION_RULES } from '@/registry'

export function DimensionRulesTable() {
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Trigger</th>
          <th>Constraint Kind</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {DIMENSION_RULES.map((r, i) => {
          const trigger = r.trigger.type === 'single_entity'
            ? <><code>single_entity</code> - kind: <code>{r.trigger.entityKind}</code></>
            : <code>{r.trigger.type}</code>
          return (
            <tr key={i}>
              <td>{trigger}</td>
              <td><code>{r.constraintKind}</code></td>
              <td>{r.description}</td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
