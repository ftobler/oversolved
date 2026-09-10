import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS, CONSTRAINT_BY_KIND, ENTITY_BY_ACTIVE_TOOL } from '@/registry'
import {
  CORE_KEYBINDINGS, KEYMAP, FEATURE_KEYMAP, SKETCH_KEYMAP,
  ASSEMBLY_KEYBINDINGS, ASSEMBLY_KEYMAP,
} from '@/utils/core/commandRegistry'

/**
 * When a binding is live, mirroring dispatchKey's branches:
 *   - 'both'     reachable in more than one place: a shared key that fires in
 *                the part editor and the assembly editor, or one with no mode
 *                override that fires in and out of sketch-edit mode
 *   - 'sketch'   only while editing a sketch
 *   - 'feature'  only outside a sketch
 *   - 'assembly' only in the assembly editor
 *   - 'none'     no branch resolves to it, i.e. the page would be advertising a
 *                key that cannot fire. A bug, asserted against in the tests.
 */
export type KeybindingMode = 'both' | 'sketch' | 'feature' | 'assembly' | 'none'

export type KeybindingRow = {
  key: string
  command: string
  label: string
  description: string
  mode: KeybindingMode
}

// A key can legitimately appear twice when it is mode-split (`e` is Add Extrude
// outside a sketch and Apply Equal inside one), so rows are identified by
// key+command. Deduping by key alone would hide a binding that really fires.
export function rowId(row: KeybindingRow): string {
  return `${row.key}:${row.command}`
}

// Ask the keymaps rather than restating their precedence here, so the page can
// never drift from what dispatchKey actually resolves.
export function resolveMode(key: string, command: string): KeybindingMode {
  const inSketch = (SKETCH_KEYMAP[key] ?? KEYMAP[key]) === command
  const inFeature = (FEATURE_KEYMAP[key] ?? KEYMAP[key]) === command
  const inPart = inSketch || inFeature
  const inAssembly = ASSEMBLY_KEYMAP[key] === command
  // A shared key that fires in both editors is reachable anywhere; an
  // assembly-only branch is labelled with its editor.
  if (inPart && inAssembly) return 'both'
  if (inAssembly) return 'assembly'
  if (inSketch && inFeature) return 'both'
  if (inSketch) return 'sketch'
  if (inFeature) return 'feature'
  return 'none'
}

export const MODE_LABEL: Readonly<Record<KeybindingMode, string>> = {
  both: 'any',
  sketch: 'sketch only',
  feature: 'feature only',
  assembly: 'assembly only',
  none: 'unreachable',
}

// Rows are gathered from the same sources KEYMAP and ASSEMBLY_KEYMAP merge, then
// sorted by key for reading. Sorting means display order is not resolution
// order, which is why each row carries its own resolved `mode` rather than
// relying on position. Rows are deduped by key+command: a shared key such as
// ctrl+z appears in both the core and assembly lists but is one binding.
export function buildKeybindingRows(): KeybindingRow[] {
  const rows: Omit<KeybindingRow, 'mode'>[] = []

  // Core bindings (with labels and descriptions from CORE_KEYBINDINGS)
  for (const b of CORE_KEYBINDINGS) {
    rows.push({ key: b.key, command: b.command, label: b.label, description: b.description })
  }

  // Constraint shortcuts: derive label/description from constraint registry
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

  // Entity shortcuts: derive label/description from entity registry
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

  // Assembly bindings: shared keys plus the assembly-only cancel.
  for (const b of ASSEMBLY_KEYBINDINGS) {
    rows.push({ key: b.key, command: b.command, label: b.label, description: b.description })
  }

  const seen = new Set<string>()
  return rows
    .map(r => ({ ...r, mode: resolveMode(r.key, r.command) }))
    .filter(r => {
      const id = rowId(r)
      if (seen.has(id)) return false
      seen.add(id)
      return true
    })
    .sort((a, b) => a.key.localeCompare(b.key))
}
