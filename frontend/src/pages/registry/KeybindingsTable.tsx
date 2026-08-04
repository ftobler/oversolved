import { buildKeybindingRows, rowId, MODE_LABEL } from '@/pages/registry/keybindingRows'

export function KeybindingsTable() {
  const rows = buildKeybindingRows()
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Mode</th>
          <th>Label</th>
          <th>Command</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
          <tr key={rowId(row)}>
            <td><kbd className="reg-kbd">{row.key}</kbd></td>
            <td>{MODE_LABEL[row.mode]}</td>
            <td>{row.label}</td>
            <td><code>{row.command}</code></td>
            <td className="reg-cell-desc">{row.description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
