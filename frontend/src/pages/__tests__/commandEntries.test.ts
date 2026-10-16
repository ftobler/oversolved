import { describe, it, expect, vi } from 'vitest'
import { PART_COMMAND_SPECS } from '@/pages/commandEntries'
import { KEYMAP, FEATURE_KEYMAP, SKETCH_KEYMAP } from '@/utils/core/commandRegistry'
import { CONSTRAINTS } from '@/registry'
import { partContext, partRegistry } from './commandFixtures'

// Commands that intentionally have no keyboard shortcut.
const SHORTCUT_CONSTRAINT_KINDS = new Set(CONSTRAINTS.filter(c => c.shortcut).map(c => c.kind))
const TOOLBAR_ONLY_CONSTRAINT_COMMANDS = CONSTRAINTS
  .filter(c => !SHORTCUT_CONSTRAINT_KINDS.has(c.kind))
  .map(c => `apply_${c.kind}`)

const PROGRAMMATIC_ONLY = new Set([
  'set_tool_select',
  'set_tool_drag',
  'set_tool_mirror',
  'set_tool_point',
  'set_tool_ellipse',  // toolbar-only (no keyboard shortcut), like point
  'set_tool_rect',
  'set_tool_center_rect',
  'set_tool_ngon',  // toolbar-only compound tool (no keyboard shortcut)
  'apply_offset',   // selection action triggered from the toolbar
  'add_hole',
  'add_transform',
  'add_shell',  // toolbar-only (no keyboard shortcut)
  ...TOOLBAR_ONLY_CONSTRAINT_COMMANDS,
])

describe('PART_COMMAND_SPECS', () => {
  // A command id is the registry key: an empty one names nothing and a
  // duplicate silently shadows the earlier spec in the registry's Map. Neither
  // is caught by the CommandName type, so this is the one place the structural
  // contract is pinned. The run shape is enforced by the type and is not
  // asserted.
  it('ids are non-empty and unique', () => {
    const ids = PART_COMMAND_SPECS.map(s => s.id)
    for (const id of ids) expect(id.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every id is in KEYMAP/FEATURE_KEYMAP/SKETCH_KEYMAP values or is a known programmatic-only command', () => {
    const keymapValues = new Set([...Object.values(KEYMAP), ...Object.values(FEATURE_KEYMAP), ...Object.values(SKETCH_KEYMAP)])
    for (const { id } of PART_COMMAND_SPECS) {
      const ok = keymapValues.has(id) || PROGRAMMATIC_ONLY.has(id)
      expect(ok, `"${id}" not in KEYMAP/FEATURE_KEYMAP and not in PROGRAMMATIC_ONLY`).toBe(true)
    }
  })

  it('every spec carries a label, an enabled predicate and a params schema', () => {
    for (const spec of PART_COMMAND_SPECS) {
      expect(spec.label.length, `label missing for "${spec.id}"`).toBeGreaterThan(0)
      expect(typeof spec.enabled).toBe('function')
      expect(typeof spec.params.parse).toBe('function')
    }
  })

  it('handleUndo and handleRedo are wired to the undo and redo specs', () => {
    const undo = vi.fn()
    const redo = vi.fn()
    const registry = partRegistry(partContext({ undo, redo }))
    expect(registry.execute('undo')).toEqual({ ok: true, createdIds: [] })
    expect(undo).toHaveBeenCalledOnce()
    expect(registry.execute('redo')).toEqual({ ok: true, createdIds: [] })
    expect(redo).toHaveBeenCalledOnce()
  })
})
