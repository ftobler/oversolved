import { describe, it, expect, vi } from 'vitest'
import { COMMAND_NAMES } from '@/utils/core/commandNames'
import {
  KEYMAP, SKETCH_KEYMAP, FEATURE_KEYMAP, ASSEMBLY_KEYMAP,
  CORE_KEYBINDINGS, ASSEMBLY_KEYBINDINGS,
} from '@/utils/core/commandRegistry'
import { CONSTRAINT_SHORTCUTS, ENTITY_SHORTCUTS } from '@/registry'
import { buildCommandEntries } from '@/pages/commandEntries'
import { buildAssemblyHandlers, buildAssemblyCommandEntries, type AssemblyHandlerDeps } from '@/pages/assemblyCommandEntries'
import { TOOL_DEFS } from '@/components/Toolbar/tools/toolsConfig'

// The typed command union is only as good as its list. These tests make the
// list exhaustive: every name the app binds or registers must be in it.

const known = new Set<string>(COMMAND_NAMES)

function expectKnown(names: Iterable<string>, source: string): void {
  for (const name of names) {
    expect(known.has(name), `"${name}" from ${source} is not in COMMAND_NAMES`).toBe(true)
  }
}

function stubDeps(): AssemblyHandlerDeps {
  const fn = vi.fn()
  return {
    runOperation: fn,
    undo: fn,
    redo: fn,
    deleteSelected: fn,
    cancelEdit: fn,
    openInsertPart: fn,
    openExport: fn,
    mintMateId: () => 'id',
    closeOpenEditor: fn,
    onMateInserted: fn,
    deleteSubject: fn,
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

  it('covers every name the sketch editor page registers', () => {
    const fn = vi.fn()
    const entries = buildCommandEntries(fn, fn, fn, fn, fn, fn, fn, fn, fn)
    expectKnown(entries.map(e => e.name), 'buildCommandEntries')
  })

  it('covers every name the assembly editor page registers', () => {
    const entries = buildAssemblyCommandEntries(buildAssemblyHandlers(stubDeps()))
    expectKnown(entries.map(e => e.name), 'buildAssemblyCommandEntries')
  })
})
