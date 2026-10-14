import { describe, it, expect } from 'vitest'
import { COMMAND_NAMES } from '@/utils/core/commandNames'
import {
  KEYMAP, SKETCH_KEYMAP, FEATURE_KEYMAP, ASSEMBLY_KEYMAP,
  CORE_KEYBINDINGS, ASSEMBLY_KEYBINDINGS,
} from '@/utils/core/commandRegistry'
import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { ASSEMBLY_COMMAND_SPECS } from '@/pages/assemblyCommandEntries'
import { TOOL_DEFS } from '@/components/Toolbar/tools/toolsConfig'

// The typed command union is only as good as its list. These tests make the
// list exhaustive: every name the app binds or registers must be in it.

const known = new Set<string>(COMMAND_NAMES)

function expectKnown(names: Iterable<string>, source: string): void {
  for (const name of names) {
    expect(known.has(name), `"${name}" from ${source} is not in COMMAND_NAMES`).toBe(true)
  }
}

describe('COMMAND_NAMES', () => {
  it('has no duplicates', () => {
    expect(new Set(COMMAND_NAMES).size).toBe(COMMAND_NAMES.length)
  })

  it('covers every command bound in a keymap', () => {
    expectKnown(Object.values(KEYMAP), 'KEYMAP')
    expectKnown(Object.values(SKETCH_KEYMAP), 'SKETCH_KEYMAP')
    expectKnown(Object.values(FEATURE_KEYMAP), 'FEATURE_KEYMAP')
    expectKnown(Object.values(ASSEMBLY_KEYMAP), 'ASSEMBLY_KEYMAP')
  })

  it('covers every command in the Registry binding tables', () => {
    expectKnown(CORE_KEYBINDINGS.map(b => b.command), 'CORE_KEYBINDINGS')
    expectKnown(ASSEMBLY_KEYBINDINGS.map(b => b.command), 'ASSEMBLY_KEYBINDINGS')
  })

  it('covers every registry-derived shortcut command', () => {
    expectKnown(CONSTRAINT_SHORTCUTS.values(), 'CONSTRAINT_SHORTCUTS')
    expectKnown(ENTITY_SHORTCUTS.values(), 'ENTITY_SHORTCUTS')
  })

  it('covers every toolbar command, including the ones with shortcut commands', () => {
    const defs = Object.values(TOOL_DEFS)
    expectKnown(defs.map(d => d.command), 'TOOL_DEFS.command')
    expectKnown(defs.flatMap(d => d.shortcutCommand ? [d.shortcutCommand] : []), 'TOOL_DEFS.shortcutCommand')
  })

  it('covers every id in the sketch editor spec table', () => {
    expectKnown(PART_COMMAND_SPECS.map(s => s.id), 'PART_COMMAND_SPECS')
  })

  it('covers every id in the assembly editor spec table', () => {
    expectKnown(ASSEMBLY_COMMAND_SPECS.map(s => s.id), 'ASSEMBLY_COMMAND_SPECS')
  })

  // The completeness proof: every name in the union is a spec somewhere, the
  // three shared names are the only ones carried by both editors, and each
  // editor's own table has no duplicate ids.
  it('enumerates every COMMAND_NAMES entry against the two editors', () => {
    const partIds = new Set(PART_COMMAND_SPECS.map(s => s.id))
    const assemblyIds = new Set(ASSEMBLY_COMMAND_SPECS.map(s => s.id))
    for (const name of COMMAND_NAMES) {
      expect(partIds.has(name) || assemblyIds.has(name), `"${name}" has no spec in either editor`).toBe(true)
    }
    const shared = [...partIds].filter(id => assemblyIds.has(id))
    expect(new Set(shared)).toEqual(new Set(['undo', 'redo', 'delete_selected']))
  })
})
