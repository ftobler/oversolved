import { buildCommandRows, EDITOR_LABEL } from '@/pages/registry/commandRows'

// Rows come from the editors' spec tables (commandRows.ts); this component is
// presentation only, so a spec change never needs a matching edit here.
export function CommandsTable() {
  const rows = buildCommandRows()
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Command</th>
          <th>Label</th>
          <th>Shortcut</th>
          <th>Undo</th>
          <th>Editor</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={row.id}>
            <td><code>{row.id}</code></td>
            <td>{row.label}</td>
            <td>{row.shortcut ? <kbd className="reg-kbd">{row.shortcut}</kbd> : '-'}</td>
            <td>{row.undoable ? 'yes' : 'no'}</td>
            <td>{EDITOR_LABEL[row.editor]}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
