import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS, CONSTRAINT_BY_KIND, ENTITY_BY_ACTIVE_TOOL } from '@/registry'
import { CORE_KEYBINDINGS } from '@/utils/core/commandRegistry'

type KeybindingRow = { key: string; command: string; label: string; description: string }

function buildKeybindingRows(): KeybindingRow[] {
  const rows: KeybindingRow[] = []

  // Core bindings (with labels and descriptions from CORE_KEYBINDINGS)
  for (const b of CORE_KEYBINDINGS) {
    rows.push({ key: b.key, command: b.command, label: b.label, description: b.description })
  }

  // Constraint shortcuts — derive label/description from constraint registry
  for (const [key, command] of CONSTRAINT_SHORTCUTS) {
    const kind = command.replace(/^apply_/, '')
    const def = CONSTRAINT_BY_KIND.get(kind)
    rows.push({
      key,
      command,
      label: def ? `Apply ${def.label}` : command,
      description: def?.description ?? '',
    })
  }

  // Entity shortcuts — derive label/description from entity registry
  for (const [key, command] of ENTITY_SHORTCUTS) {
    const activeTool = command.replace(/^set_tool_/, '')
    const def = ENTITY_BY_ACTIVE_TOOL.get(activeTool)
    rows.push({
      key,
      command,
      label: def ? `${def.label} tool` : command,
      description: def?.description ?? '',
    })
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key))
}

export function KeybindingsTable() {
  const rows = buildKeybindingRows()
  return (
    <table className="reg-table">
      <thead>
        <tr>
          <th>Key</th>
          <th>Label</th>
          <th>Command</th>
          <th>Description</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ key, command, label, description }) => (
          <tr key={key}>
            <td><kbd className="reg-kbd">{key}</kbd></td>
            <td>{label}</td>
            <td><code>{command}</code></td>
            <td className="reg-cell-desc">{description}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
